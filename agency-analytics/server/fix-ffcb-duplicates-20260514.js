#!/usr/bin/env node
// One-shot: merge PENDING-FFCB-* placeholder rows into the matching real-CUSIP
// rows that the ingest pulled with the wrong (today) pricing_date.
//
// Match rule: same issuer + same structure + same coupon (rounded to 4 dp),
// and the placeholder's pricing_date within 7 days of the real row's
// pricing_date. Real CUSIP's settle/maturity/first_call are authoritative;
// user-entered fields (funding, oas_par/cost, fees, spread, yel, etc.) win.
const db = require('./db');

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

function _abs(d1, d2) {
  if (!d1 || !d2) return 999;
  const a = new Date(d1 + 'T00:00:00Z');
  const b = new Date(d2 + 'T00:00:00Z');
  return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

(async () => {
  await db.init();
  const issues = db.getRows('issues');
  const placeholders = issues.filter((r) => r.cusip && r.cusip.startsWith('PENDING-FFCB-'));
  const reals = issues.filter((r) => r.cusip && !r.cusip.startsWith('PENDING-') && r.issuer === 'FFCB');
  console.log('PENDING-FFCB placeholders:', placeholders.length);
  console.log('Real FFCB rows:', reals.length);

  let merged = 0;
  for (const p of placeholders) {
    const pCpn = parseFloat(p.coupon);
    if (!isFinite(pCpn)) continue;
    const hit = reals.find((r) =>
      r.issuer === p.issuer &&
      r.structure === p.structure &&
      isFinite(parseFloat(r.coupon)) &&
      Math.abs(parseFloat(r.coupon) - pCpn) < 0.005 &&
      _abs(r.pricing_date, p.pricing_date) <= 7
    );
    if (!hit) { console.log('  no match for', p.cusip); continue; }
    console.log(`  ${p.cusip}  →  ${hit.cusip}  (Δpriced=${_abs(p.pricing_date, hit.pricing_date)}d)`);
    const out = { ...hit };
    // Prefer user-entered pricing_date over the ingest-stamped one.
    if (p.pricing_date) out.pricing_date = p.pricing_date;
    for (const k of USER_FIELDS) {
      if (p[k] !== '' && p[k] != null) out[k] = p[k];
    }
    out.updated_at = new Date().toISOString();
    await db.upsertRow('issues', out);
    await db.deleteWhere('issues', (r) => r.cusip === p.cusip);
    merged++;
  }
  console.log('merged:', merged);
  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
