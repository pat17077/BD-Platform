#!/usr/bin/env node
// One-shot: backfill historical FHLB callable auctions from the
// FHLB Auction History page (JSF-driven drilldown). Each historical day's
// detail returns the same shape as today's CBR results, so we feed it
// through the same _toIssueRow pipeline.
//
// Usage:
//   source .env && node agency-analytics/server/backfill-fhlb-history.js [maxDays]
//
// maxDays — optional, defaults to 30. Set to "all" to walk the entire index.

const path = require('path');
const fetch = require('node-fetch');
const db = require('./db');
const oas = require('./oas');
const history = require('./fhlb-history');

const TENOR_YEARS = {
  '1mo': 1/12, '3mo': 0.25, '6mo': 0.5,
  '1y': 1, '2y': 2, '3y': 3, '5y': 5,
  '7y': 7, '10y': 10, '20y': 20, '30y': 30,
};

function _curvePointsFromApi(apiCurve) {
  if (!apiCurve || !apiCurve.curve) return [];
  return Object.entries(apiCurve.curve)
    .map(([tenor, d]) => ({ tenor_years: TENOR_YEARS[tenor], yield_pct: d && d.yield }))
    .filter((p) => p.tenor_years != null && typeof p.yield_pct === 'number')
    .sort((a, b) => a.tenor_years - b.tenor_years);
}

function _structureNotation(item) {
  const tenor = item.tenorYrs;
  const firstCall = (item.callSchedule && item.callSchedule[0] && (item.callSchedule[0].startDate || item.callSchedule[0].nextCall)) || null;
  const issued = item.issued || item.issueDate;
  if (tenor == null || !firstCall || !issued) return item.callStructure || 'callable';
  const fc = new Date(firstCall + 'T00:00:00Z');
  const iss = new Date(issued + 'T00:00:00Z');
  if (isNaN(fc) || isNaN(iss)) return item.callStructure || 'callable';
  const months = (fc.getUTCFullYear() - iss.getUTCFullYear()) * 12 + (fc.getUTCMonth() - iss.getUTCMonth());
  const finalYr = Math.round(tenor);
  if (months < 12) return `${finalYr}yr/${months}mo`;
  return `${finalYr}yr/${Math.round(months / 12)}yr`;
}

function _priorMoveClose(series, pricingDate) {
  if (!Array.isArray(series) || !series.length || !pricingDate) return null;
  let best = null;
  for (const p of series) {
    if (p && p.date && p.date < pricingDate && typeof p.value === 'number') {
      if (best == null || p.date > best.date) best = p;
    }
  }
  return best ? Math.round(best.value * 100) / 100 : null;
}

function _row(item, moveSeries) {
  const cusip = item.cusip;
  const sizeMM = (typeof item.size === 'number' && isFinite(item.size)) ? item.size / 1e6 : '';
  const move = _priorMoveClose(moveSeries, item.traded);
  // bps from $ concession and par face: bps = fees_dollars × 10 / (size_mm × 1000)
  let feesBp = '';
  if (typeof item.feesUSD === 'number' && typeof item.size === 'number' && item.size > 0) {
    feesBp = Math.round((item.feesUSD / (item.size / 1e6 * 100)) * 10) / 10;
  }
  return {
    cusip,
    pricing_date: item.traded,
    issuer: 'FHLB',
    structure: _structureNotation(item),
    size: sizeMM,
    coupon: item.coupon != null ? item.coupon : '',
    fees: feesBp,
    spread: item.spreadBps != null ? String(item.spreadBps) : '',
    funding: '',
    oas_par: '',
    oas_cost: '',
    s5s30s: '',
    yel: '',
    settle_date: item.issued,
    move: move != null ? move : '',
    maturity_date: item.maturity,
    pricing_time_et: '',
    model_funding_spread_bp: '',
    funding_spread_gap_bp: '',
    gap_signal: '',
    ann_to_pricing_minutes: '',
    upsize_status: '',
    source_url: item.sourceUrl || 'https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/callable-bond-auction-history-119',
    raw_source_json: item,
    data_classification: 'public',
    ingested_at: new Date().toISOString(),
    version: 1,
  };
}

(async () => {
  const arg = process.argv[2];
  const maxDays = arg === 'all' ? Infinity : (parseInt(arg, 10) || 30);

  await db.init();

  // Curve + MOVE pulled from the running server
  const port = process.env.PORT || 3001;
  const [curveR, moveR] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/curve`, { timeout: 15000 }).then((r) => r.json()).catch(() => null),
    fetch(`http://127.0.0.1:${port}/api/public/move/history`, { timeout: 15000 }).then((r) => r.json()).catch(() => null),
  ]);
  const curvePoints = _curvePointsFromApi(curveR);
  const moveSeries = (moveR && Array.isArray(moveR.series)) ? moveR.series : [];
  if (!curvePoints.length) console.warn('[backfill] no curve points — OAS will be skipped');
  if (!moveSeries.length) console.warn('[backfill] no MOVE series — move_prior_close will be empty');

  const dates = await history.listAuctionDates();
  console.log(`[backfill] history index has ${dates.length} dates; processing first ${Math.min(maxDays, dates.length)}`);

  let totalIngested = 0;
  let oasOk = 0;
  let oasErr = 0;
  let dayErrors = 0;

  for (let i = 0; i < Math.min(maxDays, dates.length); i++) {
    const d = dates[i];
    try {
      const items = await history.fetchAuctionDay(d.index);
      if (!items.length) { console.log(`  [${i}] ${d.tradeDate}: 0 auctions`); continue; }

      // Build OAS payloads in batch
      const oasPayloads = items.map((it) => {
        const row = _row(it, moveSeries);
        if (!isFinite(parseFloat(row.coupon)) || !row.maturity_date || !curvePoints.length) return null;
        const cost = (it.feesUSD && it.size) ? 100 - (it.feesUSD / it.size) * 100 : null;
        const callSchedule = (it.callSchedule || []).map((c) => {
          const start = c.startDate || c.nextCall;
          const end = c.endDate || it.maturity;
          if (!start || !end) return [];
          // expand quarterly
          const out = [];
          let cur = new Date(start + 'T00:00:00Z');
          const cap = new Date(end + 'T00:00:00Z'); cap.setUTCMonth(cap.getUTCMonth() - 3);
          while (cur <= cap) { out.push({ date: cur.toISOString().slice(0, 10), price: 100 }); cur.setUTCMonth(cur.getUTCMonth() + 3); }
          return out;
        }).flat();
        return {
          cusip: it.cusip,
          issue_date: it.issued,
          settle_date: it.issued,
          maturity_date: it.maturity,
          coupon_pct: parseFloat(row.coupon),
          frequency: 'semiannual',
          day_count: '30/360',
          call_schedule: callSchedule,
          curve: curvePoints,
          target_prices: cost != null ? { par: 100, cost } : { par: 100 },
          hw_mean_reversion: 0.03,
          hw_sigma: 0.01,
        };
      });
      const validPayloads = oasPayloads.filter((p) => p != null);
      let results = [];
      if (validPayloads.length) {
        try { results = await oas.computeBatch(validPayloads, 60_000); }
        catch (e) { console.warn(`  [${i}] OAS batch err:`, e.message); }
      }
      const oasByCusip = new Map();
      for (let k = 0; k < results.length; k++) {
        if (results[k] && results[k].ok) { oasByCusip.set(validPayloads[k].cusip, results[k]); oasOk++; }
        else oasErr++;
      }

      for (const it of items) {
        const row = _row(it, moveSeries);
        const o = oasByCusip.get(it.cusip);
        if (o) {
          if (o.oas_at_par_bp != null) row.oas_par = o.oas_at_par_bp;
          if (o.oas_at_cost_bp != null) row.oas_cost = o.oas_at_cost_bp;
        }
        await db.upsertRow('issues', row);
        totalIngested++;
      }
      console.log(`  [${i}] ${d.tradeDate}: ${items.length} auctions ingested (running total ${totalIngested})`);
    } catch (e) {
      dayErrors++;
      console.error(`  [${i}] ${d.tradeDate}: ERR ${e.message}`);
    }
  }

  await db.sortBy('issues', 'pricing_date', 'ASCENDING');
  await db.audit('(backfill)', 'fhlb_history_backfill', {
    days: Math.min(maxDays, dates.length),
    ingested: totalIngested,
    oas_ok: oasOk,
    oas_err: oasErr,
    day_errors: dayErrors,
  });
  console.log(`[backfill] done — ingested ${totalIngested} auctions, OAS ok=${oasOk} err=${oasErr}, day errors=${dayErrors}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
