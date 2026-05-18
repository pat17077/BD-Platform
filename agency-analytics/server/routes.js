// Express router for /api/internal/agency/*
// Wired in server.js as: app.use('/api/internal/agency', require('./agency-analytics/server/routes'));

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const ingest = require('./ingest');
const oas = require('./oas');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.verifyCredentials(username, password);
  if (!user) {
    await db.audit(username || '(unknown)', 'login_failed', { reason: 'bad credentials' });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const session = auth.createSession(user.username);
  await auth.recordLogin(user.username);
  res.json({ token: session.token, expiresAt: session.expiresAt, username: user.username });
});

router.post('/logout', auth.requireAgencyAuth, (req, res) => {
  const t = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  auth.destroySession(t);
  res.json({ ok: true });
});

router.get('/me', auth.requireAgencyAuth, (req, res) => {
  const sheetId = process.env.AGENCY_SHEET_ID || '';
  const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '';
  res.json({ username: req.agencyUser, sheetUrl });
});

router.get('/issues', auth.requireAgencyAuth, (req, res) => {
  const rows = db.getRows('issues');
  const { issuer, since } = req.query;
  let filtered = rows;
  if (issuer) filtered = filtered.filter((r) => r.issuer === issuer);
  if (since) filtered = filtered.filter((r) => r.pricing_date >= since);
  filtered.sort((a, b) => (a.pricing_date || '').localeCompare(b.pricing_date || ''));
  res.json({ items: filtered, total: filtered.length });
});

router.get('/curve', auth.requireAgencyAuth, (req, res) => {
  const rows = db.getRows('curve_snapshots');
  const { date } = req.query;
  let filtered = rows;
  if (date) filtered = filtered.filter((r) => r.snapshot_date === date);
  res.json({ items: filtered });
});

router.get('/move', auth.requireAgencyAuth, (req, res) => {
  res.json({ items: db.getRows('move_snapshots') });
});

router.get('/audit', auth.requireAgencyAuth, (req, res) => {
  const rows = db.getRows('audit_log').slice(-100).reverse();
  res.json({ items: rows });
});

router.post('/ingest/run', auth.requireAgencyAuth, async (req, res) => {
  try {
    const out = await ingest.runAll();
    await db.audit(req.agencyUser, 'ingest_manual', out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/oas/compute', auth.requireAgencyAuth, async (req, res) => {
  const { cusip } = req.body || {};
  if (!cusip) return res.status(400).json({ error: 'cusip required' });
  const issue = db.findRow('issues', (r) => r.cusip === cusip);
  if (!issue) return res.status(404).json({ error: 'unknown cusip' });
  const today = new Date().toISOString().slice(0, 10);
  const todaysCurve = db.getRows('curve_snapshots').filter((r) => r.snapshot_date === today);
  if (!todaysCurve.length) return res.status(400).json({ error: 'no curve snapshot for today; run /ingest/run first' });

  // Rebuild call schedule from raw_source_json so we don't depend on the
  // call_schedules summary tab being well-formed for this CUSIP.
  let raw = {};
  try { raw = typeof issue.raw_source_json === 'string' ? JSON.parse(issue.raw_source_json) : (issue.raw_source_json || {}); } catch (_) {}
  const calls = require('./ingest')._expandCallScheduleForRoute
    ? require('./ingest')._expandCallScheduleForRoute(raw, issue.maturity_date)
    : [];
  const callsForApi = calls.map((c) => ({ call_date: c.date, call_price: c.price }));

  try {
    const result = await oas.computeForIssue(issue, callsForApi, todaysCurve, { timeoutMs: 30_000 });
    await db.audit(req.agencyUser, 'oas_compute', { cusip, result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/pending', auth.requireAgencyAuth, (req, res) => {
  // Default: only today + future. Pass ?all=1 to see history.
  const showAll = req.query.all === '1';
  // NYC-time "today" — markets run on ET.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const today = `${parts.find(p => p.type==='year').value}-${parts.find(p => p.type==='month').value}-${parts.find(p => p.type==='day').value}`;
  let rows = db.getRows('pending_auctions');
  if (!showAll) rows = rows.filter((r) => (r.trade_date || '') >= today);
  rows.sort((a, b) => {
    const td = (a.trade_date || '').localeCompare(b.trade_date || '');
    if (td) return td;
    // Same trade_date: order by maturity_date so tenors flow short → long
    // (e.g. 7y, 8.5y, 15y, 20y) regardless of settle_date.
    const md = (a.maturity_date || '').localeCompare(b.maturity_date || '');
    if (md) return md;
    return (a.settle_date || '').localeCompare(b.settle_date || '');
  });
  res.json({ items: rows, total: rows.length, today_nyc: today });
});

router.post('/pending/refresh', auth.requireAgencyAuth, async (req, res) => {
  try {
    const out = await ingest.ingestPendingAuctions();
    // After re-pulling tentatives, auto-spawn Morning Indications predictions
    // for any new ones we don't already have an indication for.
    const { autoCreateIndicationFromPending } = require('./desk-routes');
    if (typeof autoCreateIndicationFromPending === 'function') {
      // NYC-time today
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const today = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
      const pendingToday = db.getRows('pending_auctions').filter((r) => (r.trade_date || '') >= today);
      const created = [];
      const skipped = [];
      for (const p of pendingToday) {
        try {
          const r = await autoCreateIndicationFromPending(p, req.agencyUser);
          if (r.created) created.push(r.indication_id);
          else if (r.skipped) skipped.push({ structure: p.structure, settle: p.settle_date, why: r.skipped });
        } catch (e) {
          skipped.push({ structure: p.structure, settle: p.settle_date, why: e.message });
        }
      }
      out.indications_created = created.length;
      out.indications_skipped = skipped;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', auth.requireAgencyAuth, (req, res) => {
  res.json({
    issues: db.getRows('issues').length,
    pending_auctions: db.getRows('pending_auctions').length,
    curve_snapshots: db.getRows('curve_snapshots').length,
    move_snapshots: db.getRows('move_snapshots').length,
    sofr_snapshots: db.getRows('sofr_snapshots').length,
    predictions: db.getRows('predictions').length,
    users: db.getRows('users').length,
  });
});

module.exports = router;
