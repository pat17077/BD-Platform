// Routes that back the /agency desk-input page.
//   GET  /recent-prints       — last-N-days same-tenor stats for sidebar
//   POST /desk/preview        — compute OAS + funding without saving
//   POST /desk/save           — commit a manual auction row
//   POST /desk/reconcile      — manual trigger to match placeholder rows to real CUSIPs

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const oas = require('./oas');
const funding = require('./funding');
const fetch = require('node-fetch');
const { fetchUstCurveForAuction, fetchSofrForAuction } = require('./historical-curve');
const { buildSofrCurve } = require('./sofr-curve');
const { sigmaForTenor, HW_MEAN_REVERSION } = require('./hw-sigma');
const { predictIndication } = require('./predict-indication');
const crypto = require('crypto');

const router = express.Router();

const TENOR_YEARS = {
  '1mo': 1/12, '3mo': 0.25, '6mo': 0.5,
  '1yr': 1, '2yr': 2, '3yr': 3, '5yr': 5,
  '7yr': 7, '10yr': 10, '20yr': 20, '30yr': 30,
};

function _parseStruct(s) {
  if (!s) return null;
  // Allow decimal tenors (e.g., 8.5yr) and decimal lockouts.
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*yr\s*\/\s*(\d+(?:\.\d+)?)\s*(mo|yr)\s*(\(?[AE]\)?)?$/i);
  if (!m) return null;
  const tenor = +m[1];
  const callN = +m[2];
  const months = m[3].toLowerCase() === 'yr' ? callN * 12 : callN;
  return { tenorYrs: tenor, callMonths: months };
}

function _addBizDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}
function _addMonths(iso, m) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}
function _addYears(iso, y) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + y);
  return d.toISOString().slice(0, 10);
}

function _placeholderCusip(issuer, trade, struct, coupon) {
  return `PENDING-${issuer}-${trade.replace(/-/g, '')}-${struct.replace(/\//g, '')}-${coupon}`;
}

function _ustTenorYearsForBond(bondTenor) {
  // Closest active UST tenor at or below the bond's final maturity.
  const active = [2, 3, 5, 7, 10, 20, 30];
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i] <= bondTenor) return active[i];
  }
  return active[0];
}

function _rowTenorYrs(r) {
  // Prefer raw_source_json.tenorYrs; fall back to parsing the structure column.
  try {
    const raw = JSON.parse(r.raw_source_json || '{}');
    if (raw && typeof raw === 'object' && isFinite(parseFloat(raw.tenorYrs))) {
      return parseFloat(raw.tenorYrs);
    }
  } catch (_) {}
  const m = String(r.structure || '').match(/^(\d+(?:\.\d+)?)\s*yr/i);
  if (m) return parseFloat(m[1]);
  const m2 = String(r.structure || '').match(/^(\d+)\s*mo/i);
  if (m2) return parseFloat(m2[1]) / 12;
  return null;
}

async function _recentPrintsSummary(tenorYrs, issuer, asOf) {
  // Pull last 14d same-tenor (±1y) prints, summarize.
  const cutoff = new Date(asOf + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const rows = db.getRows('issues').filter((r) => {
    if (issuer && r.issuer !== issuer) return false;
    if (!r.pricing_date || r.pricing_date < cutoffIso) return false;
    const t = _rowTenorYrs(r);
    return t != null && Math.abs(t - tenorYrs) <= 1;
  });
  if (!rows.length) return { count: 0 };
  let sumFees = 0; let nFees = 0;
  let sumFunding = 0; let nFunding = 0;
  const fundingList = [];
  for (const r of rows) {
    const f = parseFloat(r.fees);
    if (isFinite(f)) { sumFees += f; nFees++; }
    if (r.funding) {
      const parts = String(r.funding).split('/');
      const s = parseFloat(parts[0]);
      if (isFinite(s)) { sumFunding += s; nFunding++; fundingList.push({ d: r.pricing_date, s }); }
    }
  }
  fundingList.sort((a, b) => a.d.localeCompare(b.d));
  let trend = null;
  if (fundingList.length >= 2) {
    const first = fundingList[0].s;
    const last = fundingList[fundingList.length - 1].s;
    trend = +(last - first).toFixed(1);
  }
  return {
    count: rows.length,
    avg_fees_bp:    nFees ? +(sumFees / nFees).toFixed(1) : null,
    avg_funding_bp: nFunding ? +(sumFunding / nFunding).toFixed(1) : null,
    trend_bp:       trend,
    sample: rows.slice(-5).map((r) => ({
      pricing_date: r.pricing_date,
      cusip: r.cusip,
      structure: r.structure,
      fees: r.fees,
      funding: r.funding,
    })),
  };
}

router.get('/recent-prints', auth.requireAgencyAuth, async (req, res) => {
  const tenor = parseFloat(req.query.tenor);
  const issuer = req.query.issuer || null;
  if (!isFinite(tenor)) return res.status(400).json({ error: 'tenor required (years)' });
  res.json(await _recentPrintsSummary(tenor, issuer, _todayIso()));
});

async function _runSolvers(req) {
  const issuer    = (req.issuer || '').toUpperCase();
  const trade     = req.trade_date;
  const settle    = req.settle_date;
  const structure = req.structure;
  const coupon    = parseFloat(req.coupon);
  const feesBp    = req.dnt ? null : parseFloat(req.fees_bp);
  const parsedStruct = _parseStruct(structure);
  if (!parsedStruct) throw new Error(`bad structure: ${structure}`);
  const { tenorYrs, callMonths } = parsedStruct;
  const sigma = sigmaForTenor(tenorYrs);

  const maturity = req.maturity_date || _addYears(settle, tenorYrs);
  const firstCall = req.first_call_date || _addMonths(settle, callMonths);

  // T-1 curve for the auction
  const ust = await fetchUstCurveForAuction(trade).catch(() => ({ curve: {} }));
  const sofr = await fetchSofrForAuction(trade).catch(() => null);
  const sofrCurve = buildSofrCurve(ust, sofr);
  if (sofrCurve.length < 5) throw new Error(`curve unavailable for ${trade}`);
  const curvePoints = sofrCurve.map((p) => ({ tenor_years: p.tenor_years, yield_pct: p.yield_pct }));

  // Build OAS payload
  let oasResult = null;
  if (isFinite(coupon) && coupon > 0 && feesBp != null && isFinite(feesBp)) {
    const oasInput = {
      cusip: req.cusip || 'preview',
      issue_date:    settle,
      settle_date:   settle,
      maturity_date: maturity,
      coupon_pct:    coupon,
      frequency:     'semiannual',
      day_count:     '30/360',
      call_schedule: _expandQuarterly(firstCall, maturity).map((d) => ({ date: d, price: 100 })),
      curve:         curvePoints,
      target_prices: { par: 100, cost: 100 - feesBp / 100 },
      hw_mean_reversion: HW_MEAN_REVERSION,
      hw_sigma:          sigma,
    };
    const [oasRes] = await oas.computeBatch([oasInput], 60_000);
    if (oasRes && oasRes.ok) oasResult = oasRes;
  }

  // Build funding payload
  let fundingResult = null;
  if (isFinite(coupon) && coupon > 0 && feesBp != null && isFinite(feesBp)) {
    const fundingInput = {
      cusip: req.cusip || 'preview',
      issue_date:      settle,
      settle_date:     settle,
      maturity_date:   maturity,
      coupon_pct:      coupon,
      frequency:       'semiannual',
      day_count:       '30/360',
      first_call_date: firstCall,
      call_price:      100,
      fees_bp:         feesBp,
      sofr_curve:      curvePoints,
      hw_mean_reversion: HW_MEAN_REVERSION,
      hw_sigma:          sigma,
    };
    const [fundingRes] = await funding.computeBatch([fundingInput], 60_000);
    if (fundingRes && fundingRes.ok) fundingResult = fundingRes;
  }

  return {
    tenorYrs, callMonths, sigma, settle, maturity, firstCall,
    curveAsOf: ust.fetchedFrom,
    sofrAsOf:  sofr != null ? trade : null,
    oas: oasResult,
    funding: fundingResult,
  };
}

function _expandQuarterly(first, mat) {
  const out = [];
  const start = new Date(first + 'T00:00:00Z');
  const end = new Date(mat + 'T00:00:00Z');
  const cap = new Date(end); cap.setUTCMonth(cap.getUTCMonth() - 3);
  let cur = new Date(start);
  while (cur <= cap) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCMonth(cur.getUTCMonth() + 3);
  }
  return out;
}

// Save a draft prediction (BEFORE the auction is announced) — does NOT touch
// the issues sheet. Lives in predictions_draft until matched.
router.post('/predictions/save', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    if (!issuer || !b.structure) throw new Error('issuer + structure required');
    if (!_parseStruct(b.structure)) throw new Error('bad structure: ' + b.structure);
    const draft_id = `${b.trade_date || _todayIso()}-${issuer}-${b.structure.replace(/\//g,'')}-${Date.now()}`;
    await db.upsertRow('predictions_draft', {
      draft_id,
      created_at: new Date().toISOString(),
      created_by: req.agencyUser,
      trade_date: b.trade_date || _todayIso(),
      issuer,
      structure: b.structure,
      yel: b.yel === 'Y' ? 'Y' : '',
      yel_effective_date: b.yel_effective_date || '',
      model_pred: b.model_pred || '',
      user_pred: b.user_pred || '',
      user_confidence: b.user_confidence || '',
      notes: b.notes || '',
      status: 'open',
      matched_cusip: '',
    });
    await db.audit(req.agencyUser, 'prediction_draft', { draft_id, structure: b.structure, model: b.model_pred, user: b.user_pred });
    res.json({ ok: true, draft_id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/predictions/drafts', auth.requireAgencyAuth, async (req, res) => {
  const status = req.query.status || 'open';
  const rows = db.getRows('predictions_draft')
    .filter((r) => !status || r.status === status)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ items: rows, total: rows.length });
});

// Manually add a tentative auction (FFCB usually distributes its calendar to
// dealers the day prior). Inserts into pending_auctions so the user can later
// click-to-fill the entry form.
router.post('/pending/add', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    if (issuer !== 'FHLB' && issuer !== 'FFCB') throw new Error('issuer must be FHLB or FFCB');
    if (!b.structure || !b.trade_date || !b.settle_date) {
      throw new Error('structure, trade_date, settle_date required');
    }
    const parsed = _parseStruct(b.structure);
    if (!parsed) throw new Error(`bad structure: ${b.structure}`);
    const maturity = b.maturity_date || _addYears(b.settle_date, parsed.tenorYrs);
    const firstCall = b.first_call_date || _addMonths(b.settle_date, parsed.callMonths);
    const pendingRow = {
      trade_date:    b.trade_date,
      bids_due_et:   b.bids_due_et || '',
      source:        issuer,
      structure:     b.structure,
      settle_date:   b.settle_date,
      maturity_date: maturity,
      first_call_date: firstCall,
      next_pay_date: b.next_pay_date || firstCall,
      par_mm:        b.par_mm || '',
      benchmark_desc: b.benchmark_desc || '',
      coupon:        b.coupon || '',
      ingested_at:   new Date().toISOString(),
    };
    await db.upsertRow('pending_auctions', pendingRow);
    // Auto-spawn a full Morning Indications prediction for this tentative.
    let indication = null;
    try { indication = await autoCreateIndicationFromPending(pendingRow, req.agencyUser); }
    catch (e) { console.warn('[pending/add] auto-indication failed:', e.message); }
    res.json({ ok: true, indication });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One-click DNT — marks an auction as Did Not Trade. Creates an issues row
// with coupon='', fees='DNT', and matches any open indication for the same
// (issuer, structure, settle_date).
router.post('/desk/mark-dnt', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    if (issuer !== 'FHLB' && issuer !== 'FFCB') throw new Error('issuer must be FHLB or FFCB');
    if (!b.structure || !b.settle_date) throw new Error('structure + settle_date required');
    const parsed = _parseStruct(b.structure);
    if (!parsed) throw new Error('bad structure: ' + b.structure);
    const tradeDate = b.trade_date || _todayIso();
    const maturity = b.maturity_date || _addYears(b.settle_date, parsed.tenorYrs);
    const firstCall = b.first_call_date || _addMonths(b.settle_date, parsed.callMonths);
    const cusip = `PENDING-${issuer}-${tradeDate.replace(/-/g,'')}-${b.structure.replace(/\//g,'')}-DNT`;
    const now = new Date().toISOString();
    const row = {
      cusip,
      pricing_date: tradeDate,
      issuer,
      structure: b.structure,
      size: b.size_mm || '',
      coupon: '',
      fees: 'DNT',
      yel: b.yel === 'Y' ? 'Y' : '',
      settle_date: b.settle_date,
      maturity_date: maturity,
      first_call_date: firstCall,
      move:   b.move   || '',
      s5s30s: b.s5s30s || '',
      desk_notes: 'DNT — did not trade',
      entered_by: req.agencyUser,
      data_classification: 'internal',
      ingested_at: now,
      version: 1,
    };
    await db.upsertRow('issues', row);
    // Match open indication for this (issuer, structure, settle_date)
    const inds = db.getRows('indications').filter((r) =>
      r.status === 'open' && (!r.actual_cusip || r.actual_cusip === '') &&
      r.issuer === issuer && r.structure === b.structure && r.settle_date === b.settle_date
    );
    let matched = 0;
    for (const ind of inds) {
      await db.upsertRow('indications', {
        ...ind,
        actual_cusip: cusip,
        actual_coupon: 'DNT',
        actual_funding_spread: '',
        gap_bp: '',
        updated_at: now,
      });
      matched++;
    }
    res.json({ ok: true, cusip, indications_matched: matched });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Toggle YEL flag on a pending row. Deletes any existing open indication for
// the same (issuer, structure, settle_date) and re-spawns it with the new YEL
// so the prediction reflects the YEL fees+funding adjustment.
router.patch('/pending/yel', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    const { structure, trade_date, settle_date, yel } = b;
    if (!issuer || !structure || !trade_date || !settle_date) {
      return res.status(400).json({ error: 'issuer, structure, trade_date, settle_date required' });
    }
    const row = db.getRows('pending_auctions').find((r) =>
      r.source === issuer && r.structure === structure &&
      r.trade_date === trade_date && r.settle_date === settle_date
    );
    if (!row) return res.status(404).json({ error: 'pending row not found' });
    row.yel = yel === 'Y' ? 'Y' : '';
    await db.upsertRow('pending_auctions', row);
    // Delete existing open indication so it gets re-spawned with the new YEL.
    await db.deleteWhere('indications', (r) =>
      r.status === 'open' && r.issuer === issuer &&
      r.structure === structure && r.settle_date === settle_date
    );
    let indication = null;
    try { indication = await autoCreateIndicationFromPending(row, req.agencyUser); }
    catch (e) { console.warn('[pending/yel] auto-indication failed:', e.message); }
    res.json({ ok: true, yel: row.yel, indication });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a pending row by composite key (issuer + structure + trade_date + settle_date).
// Also removes the auto-spawned indication if one exists for the same triple.
router.delete('/pending', auth.requireAgencyAuth, async (req, res) => {
  try {
    const issuer = (req.query.issuer || req.body?.issuer || '').toUpperCase();
    const structure = req.query.structure || req.body?.structure;
    const trade_date = req.query.trade_date || req.body?.trade_date;
    const settle_date = req.query.settle_date || req.body?.settle_date;
    if (!issuer || !structure || !trade_date || !settle_date) {
      return res.status(400).json({ error: 'issuer, structure, trade_date, settle_date required' });
    }
    const pendingDeleted = await db.deleteWhere('pending_auctions', (r) =>
      r.source === issuer && r.structure === structure &&
      r.trade_date === trade_date && r.settle_date === settle_date
    );
    // Also remove the auto-spawned indication, if any (status=open).
    const indDeleted = await db.deleteWhere('indications', (r) =>
      r.status === 'open' && r.issuer === issuer && r.structure === structure &&
      r.settle_date === settle_date
    );
    res.json({ ok: true, pending_deleted: pendingDeleted, indication_deleted: indDeleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/predictions/discard', auth.requireAgencyAuth, async (req, res) => {
  try {
    const { draft_id } = req.body || {};
    if (!draft_id) throw new Error('draft_id required');
    const row = db.findRow('predictions_draft', (r) => r.draft_id === draft_id);
    if (!row) return res.status(404).json({ error: 'not found' });
    await db.upsertRow('predictions_draft', { ...row, status: 'discarded' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pre-auction prediction. Returns predicted COUPON (%) and predicted FEES (bp)
// using recent same-tenor coupons (adjusted for UST curve drift) and the FFCB
// fee schedule. Phase 4 will replace with a trained model.
router.post('/desk/predict', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    const structure = b.structure;
    const tradeDate = b.trade_date || _todayIso();
    const yelOn = b.yel === 'Y';
    if (!issuer || !structure) throw new Error('issuer + structure required');
    const parsed = _parseStruct(structure);
    if (!parsed) throw new Error(`bad structure: ${structure}`);
    const tenorYrs = parsed.tenorYrs;

    // Pull T-1 UST curve for the trade date (so coupon estimate uses the right level)
    const ust = await fetchUstCurveForAuction(tradeDate).catch(() => ({ curve: {} }));
    function ustYieldFor(yrs) {
      const map = { 2: '2yr', 3: '3yr', 5: '5yr', 7: '7yr', 10: '10yr', 20: '20yr', 30: '30yr' };
      const active = Object.keys(map).map(Number).sort((a, b) => a - b);
      // closest at-or-below
      let pick = active[0];
      for (const a of active) if (a <= yrs) pick = a;
      const v = ust.curve[map[pick]];
      return v && typeof v.yield === 'number' ? v.yield : null;
    }

    // Same-tenor recent prints — gives us a sense of recent coupon and fees
    const recent = await _recentPrintsSummary(tenorYrs, issuer, tradeDate);

    // Predicted coupon = current_UST_yield_at_tenor + recent_avg_spread_to_UST_bp/100
    // The `spread` column on each row is bp over the relevant UST benchmark
    // (parse first number — handles single "65/10yr" and multi "73/20yr 130/10yr").
    let recentAvgUstSpread = null;
    let recentAvgCoupon    = null;
    {
      const sameRows = db.getRows('issues').filter((r) => {
        if (r.issuer !== issuer) return false;
        const t = _rowTenorYrs(r);
        return t != null && Math.abs(t - tenorYrs) <= 1;
      });
      const spreads = sameRows.map((r) => {
        const m = String(r.spread || '').match(/^-?(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
      }).filter((s) => s != null);
      if (spreads.length) recentAvgUstSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      const coupons = sameRows.map((r) => parseFloat(r.coupon)).filter((c) => isFinite(c));
      if (coupons.length) recentAvgCoupon = coupons.reduce((a, b) => a + b, 0) / coupons.length;
    }
    const currentUST = ustYieldFor(tenorYrs);
    let predictedCoupon = null;
    if (currentUST != null && recentAvgUstSpread != null) {
      predictedCoupon = +(currentUST + recentAvgUstSpread / 100).toFixed(3);
    }

    // Predicted fees: FFCB → standard schedule; FHLB → recent same-tenor avg
    let predictedFees = recent.avg_fees_bp;
    if (issuer === 'FFCB') {
      const { ffcbFeesForTenor } = require('./ffcb-fees');
      const standardFees = ffcbFeesForTenor(tenorYrs);
      if (standardFees != null) predictedFees = standardFees;
    }
    // YEL bonds: fees drop dramatically (use rough floor of 5 bp for now)
    if (yelOn && predictedFees != null && predictedFees > 5) {
      predictedFees = Math.min(predictedFees, 5);
    }

    res.json({
      structure, issuer, tenorYrs, yel: yelOn,
      predicted_coupon_pct: predictedCoupon,
      predicted_fees_bp:    predictedFees != null ? +predictedFees.toFixed(1) : null,
      current_ust_yield:    currentUST,
      recent_avg_coupon:    recentAvgCoupon     != null ? +recentAvgCoupon.toFixed(3) : null,
      recent_avg_spread_bp: recentAvgUstSpread  != null ? Math.round(recentAvgUstSpread) : null,
      recent_context:       recent,
      method: recent.count > 0 ? 'ust_plus_recent_spread' : 'insufficient_data',
      note: recent.count < 3 ? 'Fewer than 3 same-tenor prints in the last 14 days — low confidence.' :
            yelOn ? 'YEL flag on — predicted fees floored at ~5 bp; refine when we have more YEL data.' : null,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/desk/preview', auth.requireAgencyAuth, async (req, res) => {
  try {
    const result = await _runSolvers(req.body);
    const recent = (() => {
      const tenor = result.tenorYrs;
      const issuer = (req.body.issuer || '').toUpperCase();
      return _recentPrintsSummary(tenor, issuer, req.body.trade_date || _todayIso());
    })();
    res.json({ ...result, recent: await recent });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/desk/save', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    if (issuer !== 'FHLB' && issuer !== 'FFCB') throw new Error('issuer must be FHLB or FFCB');
    if (!b.trade_date || !b.settle_date) throw new Error('trade_date and settle_date required');
    if (!b.structure || !b.coupon) throw new Error('structure and coupon required');

    const solvers = await _runSolvers(b);
    const parsedStruct = _parseStruct(b.structure);
    const cusip = b.cusip || _placeholderCusip(issuer, b.trade_date, b.structure, b.coupon);

    // If a matching open draft exists, pull predictions in and mark it matched.
    let matchedDraft = null;
    if (!b.model_pred && !b.user_pred) {
      matchedDraft = db.findRow('predictions_draft', (r) =>
        r.status === 'open' &&
        r.issuer === issuer &&
        r.structure === b.structure &&
        r.trade_date === b.trade_date
      );
      if (matchedDraft) {
        if (matchedDraft.model_pred) b.model_pred = matchedDraft.model_pred;
        if (matchedDraft.user_pred)  b.user_pred  = matchedDraft.user_pred;
        if (matchedDraft.user_confidence) b.user_confidence = matchedDraft.user_confidence;
        if (matchedDraft.yel === 'Y' && !b.yel) b.yel = 'Y';
        if (matchedDraft.yel_effective_date && !b.yel_effective_date) b.yel_effective_date = matchedDraft.yel_effective_date;
      }
    }

    const feesBp = b.dnt ? 'DNT' : (b.fees_bp || '');
    // Prefer user-supplied "funding" (their Neo readout) over our model output.
    // Store our model output in `funding_actual` only if user didn't provide
    // their own funding (so we keep their value if they typed it in).
    const modelFundingStr = solvers.funding ? `${solvers.funding.sofr_spread_bp}/${solvers.funding.model_fees_bp}` : '';
    const userFunding = b.funding && String(b.funding).trim() ? String(b.funding).trim() : '';
    const fundingValue = userFunding || modelFundingStr;
    // funding_actual stores what we computed (so user can see model vs theirs)
    const fundingActual = userFunding && modelFundingStr ? modelFundingStr : (b.funding_actual || '');
    const fundingGap = (() => {
      if (!userFunding || !solvers.funding) return '';
      const userS = parseFloat(String(userFunding).split('/')[0]);
      if (!isFinite(userS)) return '';
      return +(userS - solvers.funding.sofr_spread_bp).toFixed(2);
    })();

    const recent = await _recentPrintsSummary(solvers.tenorYrs, issuer, b.trade_date);
    const recentSummary = recent.count > 0
      ? `n=${recent.count} avg_funding=${recent.avg_funding_bp ?? '-'} avg_fees=${recent.avg_fees_bp ?? '-'} trend=${recent.trend_bp != null ? (recent.trend_bp >= 0 ? '+' : '') + recent.trend_bp : '-'}`
      : 'no_recent';

    const userOasPar  = (b.oas_par  != null && b.oas_par  !== '') ? Number(b.oas_par)  : null;
    const userOasCost = (b.oas_cost != null && b.oas_cost !== '') ? Number(b.oas_cost) : null;
    const oasPar  = isFinite(userOasPar)  ? userOasPar  : (solvers.oas ? solvers.oas.oas_at_par_bp  : '');
    const oasCost = isFinite(userOasCost) ? userOasCost : (solvers.oas && solvers.oas.oas_at_cost_bp != null ? solvers.oas.oas_at_cost_bp : '');

    const row = {
      cusip,
      pricing_date: b.trade_date,
      issuer,
      structure: b.structure,
      size: b.size_mm || b.size || '',
      coupon: b.coupon,
      fees: feesBp,
      spread: b.spread || '',
      funding: fundingValue,
      oas_par: oasPar,
      oas_cost: oasCost,
      s5s30s: '',
      yel: b.yel === 'Y' ? 'Y' : '',
      model_pred: b.model_pred || '',
      user_pred:  b.user_pred  || '',
      user_confidence: b.user_confidence || '',
      pred_made_at: (b.model_pred || b.user_pred) ? (b.pred_made_at || new Date().toISOString()) : '',
      settle_date: b.settle_date,
      move: '',
      maturity_date: solvers.maturity,
      pricing_time_et: b.pricing_time_et || (() => {
        // Auto-stamp the input time in ET if not provided. Format: HH:MM
        const d = new Date();
        const etOpts = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false };
        return new Intl.DateTimeFormat('en-US', etOpts).format(d);
      })(),
      model_funding_spread_bp: '',
      funding_spread_gap_bp: '',
      gap_signal: '',
      funding_actual: fundingActual,
      funding_gap_bp: fundingGap === '' ? '' : fundingGap,
      yel_effective_date: b.yel_effective_date || '',
      dealers_count: b.dealers_count || '',
      pre_ioi: b.pre_ioi || '',
      competing_prints: b.competing_prints || '',
      ann_to_pricing_minutes: b.ann_to_pricing_minutes || '',
      upsize_status: b.upsize_status || '',
      source_url: b.source_url || '',
      raw_source_json: { manualEntry: true, structParsed: parsedStruct, solvers },
      entered_by: req.agencyUser,
      market_sentiment: b.market_sentiment || '',
      desk_notes: b.desk_notes || '',
      recent_5d_summary: recentSummary,
      data_classification: 'internal',
      ingested_at: new Date().toISOString(),
      version: 1,
    };
    await db.upsertRow('issues', row);
    // Mark the matched draft as matched (instead of deleting — keep history)
    if (matchedDraft) {
      await db.upsertRow('predictions_draft', {
        ...matchedDraft, status: 'matched', matched_cusip: cusip,
      });
    }
    await db.audit(req.agencyUser, 'desk_save', {
      cusip, issuer, structure: b.structure,
      matched_draft: matchedDraft ? matchedDraft.draft_id : null,
    });
    res.json({ ok: true, row, isPlaceholder: cusip.startsWith('PENDING-'), matched_draft: matchedDraft && matchedDraft.draft_id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Reconcile placeholder CUSIPs against real CUSIPs from CBR/FFCB feeds.
 * Matches on (issuer, structure prefix, settle_date, coupon).
 */
async function reconcilePlaceholders() {
  const issues = db.getRows('issues');
  const placeholders = issues.filter((r) => r.cusip && r.cusip.startsWith('PENDING-'));
  if (!placeholders.length) return { matched: 0, scanned: 0 };
  let matched = 0;
  for (const p of placeholders) {
    // Match on (issuer, structure, settle_date, coupon). pricing_date is
    // allowed to drift up to 5 days (the user-entered placeholder is often
    // stamped yesterday while CBR shows today). When merging, the user's
    // pricing_date wins (it's the actual trade date).
    const _absDays = (a, b) => {
      if (!a || !b) return 999;
      const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
      return Math.abs((da - db) / (1000 * 60 * 60 * 24));
    };
    const same = issues.find((r) =>
      r !== p &&
      !r.cusip.startsWith('PENDING-') &&
      r.issuer === p.issuer &&
      r.settle_date === p.settle_date &&
      String(r.coupon) === String(p.coupon) &&
      r.structure === p.structure &&
      _absDays(r.pricing_date, p.pricing_date) <= 5
    );
    if (same) {
      // Placeholder data is the source of truth for everything the user filled.
      const USER_FIELDS = [
        'spread', 'funding', 'oas_par', 'oas_cost', 'fees',
        'yel', 'yel_effective_date',
        'model_pred', 'user_pred', 'user_confidence', 'pred_made_at',
        'dealers_count', 'pre_ioi', 'competing_prints', 'ann_to_pricing_minutes',
        's5s30s', 'move', 'pricing_time_et',
        'desk_notes', 'market_sentiment', 'entered_by',
        'funding_actual', 'funding_gap_bp', 'recent_5d_summary',
        'size', 'coupon', 'upsize_status',
      ];
      const merged = { ...same };
      for (const k of USER_FIELDS) {
        if (p[k] !== '' && p[k] != null) merged[k] = p[k];
      }
      // User-entered pricing_date wins over CBR's auto-stamp (the user typed
      // the actual trade date).
      if (p.pricing_date) merged.pricing_date = p.pricing_date;
      await db.upsertRow('issues', merged);
      await db.deleteWhere('issues', (r) => r.cusip === p.cusip);
      await db.audit('(reconcile)', 'cusip_match', { from: p.cusip, to: same.cusip });
      matched++;
    }
  }
  return { scanned: placeholders.length, matched };
}

// Bulk pricing-date fix. Body: { entries: "CUSIP,YYYY-MM-DD\n..." }
// or { entries: [{cusip, pricing_date}, ...] }. Updates pricing_date and
// recomputes move_prior_close (lookup against move_snapshots), spread (today's
// curve as proxy), and re-sorts. OAS/funding are *not* recomputed — run the full
// ingest after if you need those refreshed for the corrected dates.
router.post('/desk/bulk-fix-dates', auth.requireAgencyAuth, async (req, res) => {
  try {
    const raw = req.body && req.body.entries;
    let entries = [];
    if (Array.isArray(raw)) entries = raw;
    else if (typeof raw === 'string') {
      entries = raw.split(/\r?\n/).map((line) => {
        const m = line.trim().match(/^([A-Z0-9]{9})\s*[,\s]\s*(\d{4}-\d{2}-\d{2})$/i);
        return m ? { cusip: m[1].toUpperCase(), pricing_date: m[2] } : null;
      }).filter(Boolean);
    }
    if (!entries.length) return res.status(400).json({ error: 'no parseable entries' });

    // Pull MOVE series once for lookup
    const port = process.env.PORT || 3001;
    const moveResp = await fetch(`http://127.0.0.1:${port}/api/public/move/history`, { timeout: 15_000 }).catch(() => null);
    const moveSeries = moveResp && moveResp.ok ? (await moveResp.json()).series || [] : [];
    function priorMoveClose(pricingDate) {
      if (!Array.isArray(moveSeries) || !moveSeries.length || !pricingDate) return null;
      let best = null;
      for (const p of moveSeries) {
        if (p && p.date && p.date < pricingDate && typeof p.value === 'number') {
          if (best == null || p.date > best.date) best = p;
        }
      }
      return best ? Math.round(best.value * 100) / 100 : null;
    }

    let updated = 0;
    const notFound = [];
    for (const e of entries) {
      const row = db.findRow('issues', (r) => r.cusip === e.cusip);
      if (!row) { notFound.push(e.cusip); continue; }
      const newPricing = e.pricing_date;
      const newMove = priorMoveClose(newPricing);
      const merged = { ...row, pricing_date: newPricing };
      if (newMove != null) merged.move = newMove;
      await db.upsertRow('issues', merged);
      updated++;
    }
    await db.audit(req.agencyUser, 'bulk_fix_dates', { updated, notFound });
    try {
      await db.sortMulti('issues', [
        { column: 'pricing_date',    direction: 'ASCENDING' },
        { column: 'pricing_time_et', direction: 'ASCENDING' },
        { column: 'issuer',          direction: 'DESCENDING' },
        { column: 'maturity_date',   direction: 'ASCENDING' },
      ]);
    } catch (_) {}
    res.json({ updated, notFound, total: entries.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// General-purpose bulk update — any field on any CUSIP. Recomputes `move`
// when pricing_date changes; sorts when done. Body: { entries: [{cusip, ...fields}] }
router.post('/desk/bulk-update', auth.requireAgencyAuth, async (req, res) => {
  try {
    const entries = (req.body && req.body.entries) || [];
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'entries array required' });
    }

    // MOVE series for recompute (only if pricing_date is changed)
    const port = process.env.PORT || 3001;
    const moveResp = await fetch(`http://127.0.0.1:${port}/api/public/move/history`, { timeout: 15_000 }).catch(() => null);
    const moveSeries = moveResp && moveResp.ok ? (await moveResp.json()).series || [] : [];
    function priorMoveClose(pricingDate) {
      if (!Array.isArray(moveSeries) || !moveSeries.length || !pricingDate) return null;
      let best = null;
      for (const p of moveSeries) {
        if (p && p.date && p.date < pricingDate && typeof p.value === 'number') {
          if (best == null || p.date > best.date) best = p;
        }
      }
      return best ? Math.round(best.value * 100) / 100 : null;
    }

    let updated = 0;
    const notFound = [];
    const ALLOWED = new Set([
      'pricing_date', 'structure', 'spread', 'funding',
      'funding_actual', 'oas_par', 'oas_cost', 'size', 'coupon',
      'settle_date', 'maturity_date', 'fees', 'desk_notes', 'market_sentiment',
      'yel', 'yel_effective_date', 'dealers_count', 'pre_ioi', 'competing_prints',
      'ann_to_pricing_minutes',
      'model_pred', 'user_pred', 'user_confidence', 'pred_made_at',
    ]);
    for (const e of entries) {
      if (!e || !e.cusip) continue;
      const row = db.findRow('issues', (r) => r.cusip === e.cusip);
      if (!row) { notFound.push(e.cusip); continue; }
      const merged = { ...row };
      for (const [k, v] of Object.entries(e)) {
        if (k === 'cusip') continue;
        if (!ALLOWED.has(k)) continue;
        if (v != null && v !== '') merged[k] = v;
      }
      // Recompute move if pricing_date changed
      if (e.pricing_date && e.pricing_date !== row.pricing_date) {
        const m = priorMoveClose(e.pricing_date);
        if (m != null) merged.move = m;
      }
      await db.upsertRow('issues', merged);
      updated++;
    }
    await db.audit(req.agencyUser, 'bulk_update', { updated, notFound });
    try {
      await db.sortMulti('issues', [
        { column: 'pricing_date',    direction: 'ASCENDING' },
        { column: 'pricing_time_et', direction: 'ASCENDING' },
        { column: 'issuer',          direction: 'DESCENDING' },
        { column: 'maturity_date',   direction: 'ASCENDING' },
      ]);
    } catch (_) {}
    res.json({ updated, notFound, total: entries.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick result entry — used by the "Awaiting Results" UI for manual entry
// of FFCB (which we can't scrape yet) or FHLB when CBR hasn't pulled it.
// If a real issue row already exists for this (issuer, structure, settle_date),
// MERGE the new fields onto it (preserving the real CUSIP and any prior fields
// the user didn't change). Otherwise create a placeholder PENDING- row.
router.post('/desk/quick-result', auth.requireAgencyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const issuer = (b.issuer || '').toUpperCase();
    if (issuer !== 'FHLB' && issuer !== 'FFCB') throw new Error('issuer must be FHLB or FFCB');
    if (!b.structure || !b.settle_date) throw new Error('structure + settle_date required');
    if (b.coupon == null || b.coupon === '') throw new Error('coupon required');
    const parsed = _parseStruct(b.structure);
    if (!parsed) throw new Error('bad structure: ' + b.structure);
    const tradeDate = b.trade_date || _todayIso();
    const maturity = b.maturity_date || _addYears(b.settle_date, parsed.tenorYrs);
    const firstCall = b.first_call_date || _addMonths(b.settle_date, parsed.callMonths);

    // Only set fields the user actually provided — leaves the rest unchanged
    // when merging onto an existing row.
    const userFields = {};
    const setIf = (k, v) => { if (v !== '' && v != null) userFields[k] = v; };
    setIf('size',     b.size_mm);
    setIf('coupon',   b.coupon);
    setIf('fees',     b.fees);
    setIf('spread',   b.spread);
    setIf('funding',  b.funding);
    setIf('oas_par',  b.oas_par);
    setIf('oas_cost', b.oas_cost);
    setIf('move',     b.move);
    setIf('s5s30s',   b.s5s30s);
    if (b.yel === 'Y') userFields.yel = 'Y';

    // Find any rows for this (issuer, structure, settle_date) — there may be
    // more than one if a duplicate slipped in (real CUSIP + leftover PENDING-,
    // or two CBR pulls). We pick the most-recently-ingested one to keep, then
    // DELETE the rest so the user's input ends up as the single source of truth.
    const candidates = db.getRows('issues').filter((r) =>
      r.issuer === issuer && r.structure === b.structure && r.settle_date === b.settle_date
    );
    let existing = null;
    if (candidates.length) {
      candidates.sort((a, c) => (c.ingested_at || '').localeCompare(a.ingested_at || ''));
      existing = candidates[0];
      // Delete any extra rows (keep the chosen one, clean the rest)
      for (let i = 1; i < candidates.length; i++) {
        await db.deleteWhere('issues', (r) => r.cusip === candidates[i].cusip);
      }
    }
    let cusip;
    let row;
    if (existing) {
      cusip = existing.cusip;
      row = {
        ...existing,
        ...userFields,
        // Keep real CUSIP; pricing_date prefers user input over today's date.
        cusip: existing.cusip,
        pricing_date: tradeDate,
        maturity_date: existing.maturity_date || maturity,
        first_call_date: existing.first_call_date || firstCall,
        entered_by: req.agencyUser,
        ingested_at: new Date().toISOString(),
      };
    } else {
      cusip = `PENDING-${issuer}-${tradeDate.replace(/-/g,'')}-${b.structure.replace(/\//g,'')}-${b.coupon}`;
      row = {
        cusip,
        pricing_date: tradeDate,
        issuer,
        structure: b.structure,
        ...userFields,
        settle_date: b.settle_date,
        maturity_date: maturity,
        first_call_date: firstCall,
        entered_by: req.agencyUser,
        data_classification: 'internal',
        ingested_at: new Date().toISOString(),
        version: 1,
      };
    }
    await db.upsertRow('issues', row);

    // Inline auto-match: link any open indication for the same triple. We bypass
    // the regular auto-match's "skip PENDING-" filter because *this* PENDING-
    // row represents the actual print (user-entered, not a tentative).
    const inds = db.getRows('indications').filter((r) =>
      r.status === 'open' && (!r.actual_cusip || r.actual_cusip === '') &&
      r.issuer === issuer && r.structure === b.structure && r.settle_date === b.settle_date
    );
    let matched = 0;
    for (const ind of inds) {
      const fundingNum = parseFloat(String(row.funding || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
      const predicted = parseFloat(ind.predicted_funding_spread);
      const gap = (isFinite(fundingNum) && isFinite(predicted)) ? Math.round((fundingNum - predicted) * 100) / 100 : '';
      await db.upsertRow('indications', {
        ...ind,
        actual_cusip: cusip,
        actual_coupon: row.coupon,
        actual_funding_spread: isFinite(fundingNum) ? fundingNum : '',
        gap_bp: gap,
        updated_at: new Date().toISOString(),
      });
      matched++;
    }
    res.json({ ok: true, cusip, indications_matched: matched });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/desk/reconcile', auth.requireAgencyAuth, async (req, res) => {
  try {
    const out = await reconcilePlaceholders();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Auto-indication for pending tentatives — called by /pending/add and after
// /pending/refresh pulls new rows from FHLB CBA. Idempotent on (issuer,
// structure, settle_date) so refreshing twice doesn't double-create.
// ──────────────────────────────────────────────────────────────────────────
async function autoCreateIndicationFromPending(pendingRow, username) {
  const issuer = (pendingRow.source || pendingRow.issuer || '').toUpperCase();
  const structure = pendingRow.structure;
  const settle_date = pendingRow.settle_date;
  if (!issuer || !structure || !settle_date) return { skipped: 'missing fields' };
  // Dedupe: skip if an open indication for this (issuer, structure, settle_date) already exists
  const existing = db.getRows('indications').find((r) =>
    r.status === 'open' &&
    r.issuer === issuer &&
    r.structure === structure &&
    r.settle_date === settle_date
  );
  if (existing) return { skipped: 'already exists', indication_id: existing.indication_id };
  const size_mm = parseFloat(pendingRow.par_mm) || 25;  // default size when issuer doesn't disclose
  const result = await predictIndication({
    issuer, structure, settle_date,
    yel: pendingRow.yel === 'Y' ? 'Y' : '',
    size_mm,
  });
  if (!result.ok) return { skipped: 'predict failed: ' + (result.errors || []).join('; ') };
  const now = new Date().toISOString();
  const id = crypto.randomBytes(6).toString('hex');
  const row = {
    indication_id: id,
    created_at: now,
    created_by: username || '(auto)',
    trade_date: pendingRow.trade_date || _todayIso(),
    status: 'open',
    issuer: result.inputs.issuer,
    structure: result.inputs.structure,
    settle_date: result.inputs.settle_date,
    maturity_date: result.auto.maturity_date,
    first_call_date: result.auto.first_call_date,
    yel: result.inputs.yel || '',
    size_mm: String(size_mm),
    predicted_coupon_low: result.prediction.coupon_low,
    predicted_coupon_mid: result.prediction.coupon_mid,
    predicted_coupon_high: result.prediction.coupon_high,
    predicted_spread: result.prediction.spread,
    predicted_funding_spread: result.prediction.funding_spread,
    aggressive_coupon:  result.prediction.aggressive_coupon ?? '',
    aggressive_funding: result.prediction.aggressive_funding ?? '',
    cheap_coupon:       result.prediction.cheap_coupon ?? '',
    cheap_funding:      result.prediction.cheap_funding ?? '',
    speed_at_predicted: result.prediction.speed_at_predicted ?? '',
    speed_score:        result.prediction.speed_score ?? '',
    predicted_oas_par: '',
    predicted_oas_cost: '',
    fees_used: result.prediction.fees_used,
    sample_size: result.reasoning.sample_size,
    sigma_used: result.reasoning.sigma_used,
    curve_date: result.reasoning.curve_date,
    reasoning_json: JSON.stringify(result.reasoning),
    market_color: '',
    actual_cusip: '',
    actual_coupon: '',
    actual_funding_spread: '',
    gap_bp: '',
    updated_at: now,
  };
  await db.upsertRow('indications', row);
  return { created: true, indication_id: id };
}

// ──────────────────────────────────────────────────────────────────────────
// Morning indications
// ──────────────────────────────────────────────────────────────────────────

// "Today" in New York time — markets operate on ET, and a UTC-based
// definition flips date hours before ET midnight (causing stale "yesterday"
// pending rows after 8 PM ET).
function _todayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// ── Market snapshot (today's live levels) ────────────────────────────────
const SNAPSHOT_FIELDS = [
  'ust_2y','ust_3y','ust_5y','ust_7y','ust_10y','ust_20y','ust_30y',
  'sofr_overnight','s5s30s','move','notes',
];

router.get('/market-snapshot', auth.requireAgencyAuth, (req, res) => {
  try {
    const date = req.query.date || _todayIso();
    const row = db.getRows('market_snapshots').find((r) => r.snapshot_date === date);
    res.json({ snapshot_date: date, row: row || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tag post-print signals on an existing issues row (a comparable). Used by the
// indication-reasoning panel so the user can capture upsized? / bonds-left /
// current-price as they're already looking at it.
router.patch('/issues/:cusip/post-print', auth.requireAgencyAuth, async (req, res) => {
  try {
    const cusip = req.params.cusip;
    const row = db.getRows('issues').find((r) => r.cusip === cusip);
    if (!row) return res.status(404).json({ error: 'cusip not found' });
    const allowed = [
      'bonds_left_street_mm', 'current_price', 'last_traded_price',
      'upsize_status', 'upsize_amount_mm', 'post_print_notes',
      'execution_speed', 'cover_bp', 'time_to_clear_mins',
    ];
    for (const k of allowed) {
      if (k in (req.body || {})) row[k] = req.body[k] === '' ? '' : req.body[k];
    }
    await db.upsertRow('issues', row);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/market-snapshot', auth.requireAgencyAuth, async (req, res) => {
  try {
    const date = (req.body && req.body.snapshot_date) || _todayIso();
    const existing = db.getRows('market_snapshots').find((r) => r.snapshot_date === date) || {};
    const row = { ...existing, snapshot_date: date };
    for (const k of SNAPSHOT_FIELDS) {
      if (k in (req.body || {})) row[k] = req.body[k] === '' ? '' : req.body[k];
    }
    row.updated_at = new Date().toISOString();
    row.updated_by = req.agencyUser;
    await db.upsertRow('market_snapshots', row);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Preview — run predictor without saving
router.post('/indications/preview', auth.requireAgencyAuth, async (req, res) => {
  try {
    const out = await predictIndication(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save — commit a predicted indication to the sheet
router.post('/indications', auth.requireAgencyAuth, async (req, res) => {
  try {
    const result = await predictIndication(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    const now = new Date().toISOString();
    const id = crypto.randomBytes(6).toString('hex');
    const row = {
      indication_id: id,
      created_at: now,
      created_by: req.agencyUser,
      trade_date: _todayIso(),
      status: 'open',
      issuer: result.inputs.issuer,
      structure: result.inputs.structure,
      settle_date: result.inputs.settle_date,
      maturity_date: result.auto.maturity_date,
      first_call_date: result.auto.first_call_date,
      yel: result.inputs.yel || '',
      size_mm: req.body.size_mm || '',
      predicted_coupon_low: result.prediction.coupon_low,
      predicted_coupon_mid: result.prediction.coupon_mid,
      predicted_coupon_high: result.prediction.coupon_high,
      predicted_spread: result.prediction.spread,
      predicted_funding_spread: result.prediction.funding_spread,
      aggressive_coupon:  result.prediction.aggressive_coupon ?? '',
      aggressive_funding: result.prediction.aggressive_funding ?? '',
      cheap_coupon:       result.prediction.cheap_coupon ?? '',
      cheap_funding:      result.prediction.cheap_funding ?? '',
      speed_at_predicted: result.prediction.speed_at_predicted ?? '',
      speed_score:        result.prediction.speed_score ?? '',
      predicted_oas_par: '',
      predicted_oas_cost: '',
      fees_used: result.prediction.fees_used,
      sample_size: result.reasoning.sample_size,
      sigma_used: result.reasoning.sigma_used,
      curve_date: result.reasoning.curve_date,
      reasoning_json: JSON.stringify(result.reasoning),
      market_color: '',
      user_pred:        req.body.user_pred ?? '',
      user_confidence:  req.body.user_confidence ?? '',
      in_auction_at:    '',
      refreshed_at:     '',
      actual_cusip: '',
      actual_coupon: '',
      actual_funding_spread: '',
      gap_bp: '',
      updated_at: now,
    };
    await db.upsertRow('indications', row);
    res.json({ ok: true, indication_id: id, row, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle "in auction today" on an indication. When turning ON, re-run the
// predictor using the latest snapshot/curve so the displayed coupon reflects
// the current market (not the level when it was first saved).
router.post('/indications/:id/toggle-in-auction', auth.requireAgencyAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const row = db.getRows('indications').find((r) => r.indication_id === id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    const isOn = row.in_auction_at && row.in_auction_at !== '';
    if (isOn) {
      // Turn off — keep the existing prediction, just clear the flag
      row.in_auction_at = '';
      row.updated_at = now;
      await db.upsertRow('indications', row);
      return res.json({ ok: true, in_auction: false, row });
    }
    // Turn on — re-run the predictor with the same inputs but current market data.
    const result = await predictIndication({
      issuer:    row.issuer,
      structure: row.structure,
      settle_date: row.settle_date,
      yel:       row.yel,
      size_mm:   row.size_mm,
    });
    if (!result.ok) {
      // Mark as in_auction even if re-predict failed; user still wants the flag.
      row.in_auction_at = now;
      row.updated_at = now;
      await db.upsertRow('indications', row);
      return res.json({ ok: true, in_auction: true, row, refresh_skipped: result.errors });
    }
    const merged = {
      ...row,
      predicted_coupon_low: result.prediction.coupon_low,
      predicted_coupon_mid: result.prediction.coupon_mid,
      predicted_coupon_high: result.prediction.coupon_high,
      predicted_spread: result.prediction.spread,
      predicted_funding_spread: result.prediction.funding_spread,
      aggressive_coupon:  result.prediction.aggressive_coupon ?? '',
      aggressive_funding: result.prediction.aggressive_funding ?? '',
      cheap_coupon:       result.prediction.cheap_coupon ?? '',
      cheap_funding:      result.prediction.cheap_funding ?? '',
      speed_at_predicted: result.prediction.speed_at_predicted ?? '',
      speed_score:        result.prediction.speed_score ?? '',
      fees_used:          result.prediction.fees_used,
      sample_size:        result.reasoning.sample_size,
      sigma_used:         result.reasoning.sigma_used,
      curve_date:         result.reasoning.curve_date,
      reasoning_json:     JSON.stringify(result.reasoning),
      in_auction_at:      now,
      refreshed_at:       now,
      updated_at:         now,
    };
    await db.upsertRow('indications', merged);
    res.json({ ok: true, in_auction: true, row: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List today's (or any day's) open indications
router.get('/indications', auth.requireAgencyAuth, (req, res) => {
  try {
    const date = req.query.trade_date || _todayIso();
    const status = req.query.status || 'open';
    // Build a lookup of live post-print signals by cusip so the saved
    // reasoning's snapshot of comparables stays current with what the user
    // has typed on the issues sheet.
    const issuesByCusip = new Map();
    for (const r of db.getRows('issues')) {
      if (r.cusip) issuesByCusip.set(r.cusip, r);
    }
    const overlay = (c) => {
      const live = issuesByCusip.get(c.cusip);
      if (!live) return c;
      const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : c[v]; };
      return {
        ...c,
        upsize_status:        live.upsize_status || '',
        upsize_amount_mm:     isFinite(parseFloat(live.upsize_amount_mm))    ? parseFloat(live.upsize_amount_mm)    : '',
        bonds_left_street_mm: isFinite(parseFloat(live.bonds_left_street_mm))? parseFloat(live.bonds_left_street_mm): '',
        current_price:        isFinite(parseFloat(live.current_price))      ? parseFloat(live.current_price)      : '',
        last_traded_price:    isFinite(parseFloat(live.last_traded_price))  ? parseFloat(live.last_traded_price)  : '',
        execution_speed:      live.execution_speed || '',
      };
    };
    const rows = db.getRows('indications')
      .filter((r) => r.trade_date === date && r.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map((r) => {
        let reasoning = null;
        try { reasoning = r.reasoning_json ? JSON.parse(r.reasoning_json) : null; } catch (_) {}
        if (reasoning && Array.isArray(reasoning.comparables)) {
          reasoning.comparables = reasoning.comparables.map(overlay);
        }
        return { ...r, reasoning };
      });
    res.json({ trade_date: date, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update editable fields (just market_color today)
router.patch('/indications/:id', auth.requireAgencyAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const row = db.getRows('indications').find((r) => r.indication_id === id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const allowed = ['market_color', 'user_pred', 'user_confidence', 'actual_cusip', 'actual_coupon', 'actual_funding_spread', 'gap_bp'];
    for (const k of allowed) {
      if (k in (req.body || {})) row[k] = req.body[k];
    }
    row.updated_at = new Date().toISOString();
    await db.upsertRow('indications', row);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a single indication
router.delete('/indications/:id', auth.requireAgencyAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const found = db.getRows('indications').some((r) => r.indication_id === id);
    if (!found) return res.status(404).json({ error: 'not found' });
    await db.deleteWhere('indications', (r) => r.indication_id === id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Archive all open indications (end-of-day "refresh for new day")
router.post('/indications/refresh-day', auth.requireAgencyAuth, async (req, res) => {
  try {
    const open = db.getRows('indications').filter((r) => r.status === 'open');
    for (const r of open) {
      r.status = 'archived';
      r.updated_at = new Date().toISOString();
      await db.upsertRow('indications', r);
    }
    res.json({ ok: true, archived: open.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.reconcilePlaceholders = reconcilePlaceholders;
module.exports.autoCreateIndicationFromPending = autoCreateIndicationFromPending;
