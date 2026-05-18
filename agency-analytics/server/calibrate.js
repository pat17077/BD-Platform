#!/usr/bin/env node
// One-shot calibration runner.
// For each anchor (date, structure, coupon, fees), fetch the historical UST
// curve, build a SOFR curve, run the funding solver, and compare to the user's
// the observed print.
//
// Edit ANCHORS below, then: source .env && node agency-analytics/server/calibrate.js
//
// Output: residual (our_s − expected_s) per row, and per-tenor averages so we know
// which σ entries to nudge.

const path = require('path');
const { fetchUstCurveForAuction, fetchSofrForAuction } = require('./historical-curve');
const { buildSofrCurve } = require('./sofr-curve');
const { sigmaForTenor, HW_MEAN_REVERSION } = require('./hw-sigma');
const funding = require('./funding');

// Each anchor: trade date, structure (XYr/Zmo or XYr/Zyr), coupon %,
// fees in bps per bond, Neo's reported s (bp) and model fees (bp).
const ANCHORS = [
  // 5/12 batch (initial calibration set)
  { trade: '2026-05-12', struct: '7yr/6mo',  cpn: 4.85,  fees: 19.4, expected_s: 9.2,  expected_fees: 19.46 },
  { trade: '2026-05-12', struct: '20yr/6mo', cpn: 5.7,   fees: 23.4, expected_s: 30.75, expected_fees: 23.45 },
  { trade: '2026-05-12', struct: '20yr/1yr', cpn: 5.75,  fees: 4.0,  expected_s: 36.5, expected_fees: 4.07 },
  // 5/11 batch (new)
  { trade: '2026-05-11', struct: '7yr/6mo',  cpn: 5.00,  fees: 1.1,  expected_s: 17.0, expected_fees: 1.11 },
  { trade: '2026-05-11', struct: '8yr/6mo',  cpn: 4.935, fees: 27.5, expected_s: 15.2, expected_fees: 27.55 },
  { trade: '2026-05-11', struct: '10yr/6mo', cpn: 5.04,  fees: 29.9, expected_s: 17.4, expected_fees: 30.0 },
  // 5/7 batch (new)
  { trade: '2026-05-07', struct: '5yr/1yr',  cpn: 4.45,  fees: 10.8, expected_s: 2.4,  expected_fees: 10.87 },
  { trade: '2026-05-07', struct: '10yr/1yr', cpn: 5.05,  fees: 9.3,  expected_s: 15.2, expected_fees: 9.22 },
  { trade: '2026-05-07', struct: '15yr/2yr', cpn: 5.32,  fees: 18.0, expected_s: 36.2, expected_fees: 18.14 },
  { trade: '2026-05-07', struct: '20yr/1yr', cpn: 5.60,  fees: 27.7, expected_s: 35.5, expected_fees: 27.75 },
];

function _parseStruct(s) {
  const m = s.match(/^(\d+)yr\/(\d+)(mo|yr)$/i);
  if (!m) throw new Error(`bad structure: ${s}`);
  const tenor = +m[1];
  const callN = +m[2];
  const months = m[3].toLowerCase() === 'yr' ? callN * 12 : callN;
  return { tenorYrs: tenor, callMonths: months };
}

function _addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function _addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function _addYears(iso, years) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

(async () => {
  console.log('Calibrating against', ANCHORS.length, 'anchors\n');
  console.log('date        struct       cpn    fees    our_s/our_fees    expected_s/expected_fees    gap_s');
  console.log('----------  -----------  -----  ------  ----------------  ----------------  ------');

  // Group anchors by trade date so we hit FRED once per date
  const byDate = {};
  for (const a of ANCHORS) {
    (byDate[a.trade] = byDate[a.trade] || []).push(a);
  }

  const results = [];

  for (const trade of Object.keys(byDate).sort()) {
    // Auctions price at 10:30 ET, before today's close → use prior business
    // day's curve (T-1), same convention as UBS Neo.
    const ust = await fetchUstCurveForAuction(trade);
    const sofrOn = await fetchSofrForAuction(trade);
    if (ust.fetchedFrom) {
      console.log(`[${trade}] using curve as of ${ust.fetchedFrom} (T-1 of auction date)`);
    }
    const sofrCurve = buildSofrCurve(ust, sofrOn);
    if (sofrCurve.length < 5) {
      console.error(`[${trade}] curve has <5 points — skipping`);
      continue;
    }
    // FHLB callable settlement: typically T+10 business days. Approximate
    // as +14 calendar for the solver — small effect on spread (~0.1bp).
    const settleApprox = _addDays(trade, 14);

    const payloads = byDate[trade].map((a) => {
      const { tenorYrs, callMonths } = _parseStruct(a.struct);
      const sigma = sigmaForTenor(tenorYrs);
      return {
        anchor: a, tenorYrs, callMonths, sigma,
        payload: {
          cusip: `${a.trade}_${a.struct}`,
          issue_date:      settleApprox,
          settle_date:     settleApprox,
          maturity_date:   _addYears(settleApprox, tenorYrs),
          coupon_pct:      a.cpn,
          frequency:       'semiannual',
          day_count:       '30/360',
          first_call_date: _addMonths(settleApprox, callMonths),
          call_price:      100,
          fees_bp:         a.fees,
          sofr_curve:      sofrCurve.map((p) => ({ tenor_years: p.tenor_years, yield_pct: p.yield_pct })),
          hw_mean_reversion: HW_MEAN_REVERSION,
          hw_sigma:          sigma,
        },
      };
    });

    const out = await funding.computeBatch(payloads.map((p) => p.payload), 180_000);
    for (let i = 0; i < payloads.length; i++) {
      const { anchor: a, tenorYrs, sigma } = payloads[i];
      const r = out[i];
      if (!r || !r.ok) {
        console.log(`${a.trade}  ${a.struct.padEnd(11)}  -                 ERROR             ${r ? r.error : '?'}`);
        continue;
      }
      const gap = r.sofr_spread_bp - a.expected_s;
      console.log(
        `${a.trade}  ${a.struct.padEnd(11)}  ${String(a.cpn).padEnd(5)}  ${String(a.fees).padEnd(6)}  ` +
        `${(r.sofr_spread_bp + '/' + r.model_fees_bp).padEnd(16)}  ` +
        `${(a.expected_s + '/' + a.expected_fees).padEnd(16)}  ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}  ` +
        `(σ=${(sigma*10000).toFixed(0)}bp at ${tenorYrs}y)`
      );
      results.push({ ...a, tenorYrs, our_s: r.sofr_spread_bp, gap, sigma });
    }
  }

  // Per-tenor average gap
  console.log('\n=== Per-tenor average gap ===');
  const byTenor = {};
  for (const r of results) {
    (byTenor[r.tenorYrs] = byTenor[r.tenorYrs] || []).push(r.gap);
  }
  for (const t of Object.keys(byTenor).sort((a, b) => +a - +b)) {
    const gaps = byTenor[t];
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`  ${t}y (n=${gaps.length})  avg gap = ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}bp  (gaps: ${gaps.map((g) => g.toFixed(1)).join(', ')})`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
