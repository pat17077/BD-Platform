// Ingestion: pull current snapshots from the running server's internal API
// and persist them to Google Sheets via db.js.
//
// We call the local server's existing endpoints (loose coupling, no refactor
// of server.js needed). Both run in the same process, so it's a localhost
// roundtrip — latency doesn't matter for 2x/day cron.

const fetch = require('node-fetch');
const db = require('./db');
const oas = require('./oas');
const funding = require('./funding');
const { buildSofrCurve } = require('./sofr-curve');
const { sigmaForTenor, HW_MEAN_REVERSION } = require('./hw-sigma');
const { fetchUstCurveForAuction, fetchSofrForAuction } = require('./historical-curve');
const { ffcbFeesForTenor } = require('./ffcb-fees');
const fhlbCbr = require('./fhlb-cbr');
const fhlbCba = require('./fhlb-cba');

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

function _baseUrl() {
  const port = process.env.PORT || 3001;
  return `http://127.0.0.1:${port}`;
}

function _headers() {
  return {
    'x-internal-token': process.env.INTERNAL_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function _get(path) {
  const r = await fetch(`${_baseUrl()}${path}`, { headers: _headers(), timeout: 15000 });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function _today() {
  // NYC-time "today" — markets run on ET, UTC would flip date hours early.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
}

function _normalizeIssuer(name) {
  if (!name) return '';
  const s = String(name).toLowerCase();
  if (s.includes('fhlb') || s.includes('federal home loan')) return 'FHLB';
  if (s.includes('ffcb') || s.includes('farm credit')) return 'FFCB';
  return name;
}

function _structureNotation(item) {
  // "10yr/6mo" — final-maturity in years over first-call protection.
  // First-call < 12mo → months suffix; otherwise years suffix.
  const tenor = item.tenorYrs;
  const firstCall = (item.callSchedule && item.callSchedule[0] &&
    (item.callSchedule[0].startDate || item.callSchedule[0].nextCall)) || null;
  const issued = item.issued || item.issueDate;
  if (tenor == null || !firstCall || !issued) {
    return item.callStructure || item.type || (item.callable ? 'callable' : 'bullet');
  }
  const fc = new Date(firstCall + 'T00:00:00Z');
  const iss = new Date(issued + 'T00:00:00Z');
  if (isNaN(fc) || isNaN(iss)) return item.callStructure || 'callable';
  const months = (fc.getUTCFullYear() - iss.getUTCFullYear()) * 12
                  + (fc.getUTCMonth() - iss.getUTCMonth());
  const finalYr = Math.round(tenor);
  if (months < 12) return `${finalYr}yr/${months}mo`;
  return `${finalYr}yr/${Math.round(months / 12)}yr`;
}

function _priorMoveClose(series, pricingDate) {
  // Return the MOVE close on the latest series date strictly before pricingDate.
  if (!Array.isArray(series) || !series.length || !pricingDate) return null;
  let best = null;
  for (const p of series) {
    if (p && p.date && p.date < pricingDate && typeof p.value === 'number') {
      if (best == null || p.date > best.date) best = p;
    }
  }
  return best ? Math.round(best.value * 100) / 100 : null;
}

// Map of recent UST curve yields (% terms) — set by ingestNewIssues so that
// _toIssueRow can compute multi-value spreads for ≥20yr structures without
// re-fetching the curve per row.
let _currentUstCurve = null;
function _setCurrentUstCurve(curveApi) {
  _currentUstCurve = {};
  if (curveApi && curveApi.curve) {
    for (const [k, v] of Object.entries(curveApi.curve)) {
      if (v && typeof v.yield === 'number') _currentUstCurve[k] = v.yield;
    }
  }
}

function _spreadValue(tenorYrs, coupon) {
  // < 20yr: "X/Nyr"  (spread to closest UST tenor at-or-below)
  // 20–29yr: "X/20yr Y/10yr"
  // 30yr+:   "X/30yr Y/20yr Z/10yr"
  if (!isFinite(coupon) || !isFinite(tenorYrs)) return '';
  if (!_currentUstCurve) return '';
  const lookup = (key) => _currentUstCurve[key];
  const bp = (couponPct, ustPct) =>
    (isFinite(couponPct) && isFinite(ustPct)) ? Math.round((couponPct - ustPct) * 100) : null;
  const fmt = (val, tenorKey) => val != null ? `${val}/${tenorKey}` : null;

  if (tenorYrs >= 30) {
    const a = fmt(bp(coupon, lookup('30yr')), '30yr');
    const b = fmt(bp(coupon, lookup('20yr')), '20yr');
    const c = fmt(bp(coupon, lookup('10yr')), '10yr');
    return [a, b, c].filter(Boolean).join(' ');
  }
  if (tenorYrs >= 20) {
    const a = fmt(bp(coupon, lookup('20yr')), '20yr');
    const b = fmt(bp(coupon, lookup('10yr')), '10yr');
    return [a, b].filter(Boolean).join(' ');
  }
  // Closest active UST tenor at or below the bond's maturity
  const active = [
    { yrs: 30, key: '30yr' }, { yrs: 20, key: '20yr' }, { yrs: 10, key: '10yr' },
    { yrs: 7,  key: '7yr'  }, { yrs: 5,  key: '5yr'  }, { yrs: 3,  key: '3yr' },
    { yrs: 2,  key: '2yr'  }, { yrs: 1,  key: '1yr'  },
  ];
  for (const a of active) {
    if (a.yrs <= tenorYrs) {
      const v = bp(coupon, lookup(a.key));
      if (v != null) return `${v}/${a.key}`;
      break;
    }
  }
  return '';
}

function _toIssueRow(item, moveSeries, sourceUrl, existingPricingDate) {
  const cusip = item.cusip || '';
  const issuer = _normalizeIssuer(item.issuer || item.source || item.agency || '');
  const coupon = item.couponPct != null ? item.couponPct : item.coupon;
  const structure = _structureNotation(item);
  // Compute spread fresh against today's UST curve (overrides item.spreadBps);
  // falls back to source feed's spread if curve not available.
  const computedSpread = _spreadValue(parseFloat(item.tenorYrs), parseFloat(coupon));
  const spread = computedSpread !== '' ? computedSpread
                 : (item.spreadBps != null ? String(item.spreadBps)
                    : (item.spreadToBenchBp != null ? String(item.spreadToBenchBp) : ''));

  // FHLB's feed publishes a real `traded` field — use it.
  // FFCB's feed only has issue/settle date. Heuristic:
  //   - If we've ingested this CUSIP before, keep the prior pricing_date.
  //   - Else for FFCB, assume the print priced ~5 calendar days before settle
  //     (typical FFCB callable MTN T+3 to T+7); but cap at today's date.
  //     This is far more accurate than "always today" — most fresh FFCB rows
  //     we see today actually printed yesterday or earlier.
  //   - Historical observation (settle in the past): pricing_date ≈ settle_date.
  const settle = item.issued || item.settleDate || '';
  let pricing_date;
  if (issuer === 'FHLB' && item.traded) {
    pricing_date = item.traded;
  } else if (existingPricingDate) {
    pricing_date = existingPricingDate;
  } else if (settle && settle > _today()) {
    const sub5 = new Date(settle + 'T00:00:00Z');
    sub5.setUTCDate(sub5.getUTCDate() - 5);
    const guessed = sub5.toISOString().slice(0, 10);
    pricing_date = guessed > _today() ? _today() : guessed;
  } else {
    pricing_date = settle || _today();
  }

  const moveClose = _priorMoveClose(moveSeries, pricing_date);
  const sizeRaw = item.size || item.sizeUSD || null;
  const sizeMM = (typeof sizeRaw === 'number' && isFinite(sizeRaw)) ? sizeRaw / 1e6 : '';

  // fees: dealer concession per bond, in basis points.
  // FHLB → bid (from CBR/history concPer1000)
  // FFCB → standardized by tenor (no public source — table in ffcb-fees.js)
  let feesBp;
  if (item.didNotTrade === true) {
    feesBp = 'DNT';
  } else if (typeof item.concPer1000 === 'number' && isFinite(item.concPer1000)) {
    feesBp = Math.round(item.concPer1000 * 10 * 10) / 10;
  } else if (item.feesUSD && sizeRaw) {
    feesBp = Math.round((item.feesUSD / sizeRaw) * 10000 * 10) / 10;
  } else if (issuer === 'FFCB') {
    const ffcb = ffcbFeesForTenor(parseFloat(item.tenorYrs));
    feesBp = ffcb != null ? ffcb : '';
  } else {
    feesBp = '';
  }

  // s5s30s = 30y UST - 5y UST (in bp), at trade date.
  let s5s30s = '';
  if (_currentUstCurve && typeof _currentUstCurve['30yr'] === 'number' && typeof _currentUstCurve['5yr'] === 'number') {
    s5s30s = Math.round((_currentUstCurve['30yr'] - _currentUstCurve['5yr']) * 100);
  }

  return {
    cusip,
    pricing_date,
    issuer,
    structure,
    size: sizeMM,
    coupon: coupon != null ? coupon : '',
    fees: feesBp,
    spread,
    funding: '',
    oas_par: '',
    oas_cost: '',
    s5s30s,
    yel: item.yel ? 'Y' : '',
    settle_date: settle,
    move: moveClose != null ? moveClose : '',
    maturity_date: item.maturity || item.maturityDate || '',
    pricing_time_et: item.pricingTimeET || '',
    model_funding_spread_bp: '',
    funding_spread_gap_bp: '',
    gap_signal: '',
    ann_to_pricing_minutes: '',
    upsize_status: item.upsize || '',
    source_url: sourceUrl || item.sourceUrl || '',
    raw_source_json: item,
    data_classification: 'public',
    ingested_at: new Date().toISOString(),
    version: 1,
  };
}

function _expandCallSchedule(item, maturity) {
  // Source feed gives a single { startDate, endDate, frequency } describing a
  // continuously- or periodically-callable window. QuantLib needs discrete dates.
  // We approximate as quarterly call dates from startDate up to (maturity - 3mo).
  const raw = Array.isArray(item.callSchedule) ? item.callSchedule : [];
  const out = [];
  for (const c of raw) {
    if (c.date || c.callDate) {
      // Already a discrete entry
      out.push({ date: c.date || c.callDate, price: c.price != null ? c.price : 100 });
      continue;
    }
    const start = c.startDate || c.nextCall;
    const end = c.endDate || maturity;
    if (!start || !end) continue;
    const freq = (c.frequency || '').toUpperCase();
    const stepMonths = freq === 'CONT' ? 3
                       : freq === 'MONTHLY' ? 1
                       : freq === 'QUARTERLY' ? 3
                       : freq === 'SEMIANNUAL' ? 6
                       : freq === 'ANNUAL' ? 12
                       : 3; // default quarterly
    const startD = new Date(start + 'T00:00:00Z');
    const endD = new Date(end + 'T00:00:00Z');
    if (isNaN(startD) || isNaN(endD)) continue;
    // Stop ≥ 3 months before maturity to avoid degenerate near-maturity calls
    const cap = new Date(endD); cap.setUTCMonth(cap.getUTCMonth() - 3);
    let d = new Date(startD);
    while (d <= cap) {
      out.push({ date: d.toISOString().slice(0, 10), price: 100 });
      d.setUTCMonth(d.getUTCMonth() + stepMonths);
    }
  }
  return out;
}

function _lastMoveClose(moveHist) {
  if (!moveHist || !Array.isArray(moveHist.series) || !moveHist.series.length) return null;
  const last = moveHist.series[moveHist.series.length - 1];
  return last && typeof last.value === 'number' ? last.value : null;
}

async function _fetchMoveWithRetry() {
  // Server's /move/history is lazy: first call kicks off the populate and returns
  // empty. Retry a few times with backoff until the cache hydrates.
  for (let attempt = 0; attempt < 6; attempt++) {
    const m = await _get('/api/public/move/history').catch(() => null);
    if (m && Array.isArray(m.series) && m.series.length > 0) return m;
    await new Promise((r) => setTimeout(r, 2000 + attempt * 1000));
  }
  return null;
}

function _buildOasPayload(item, cusip, row, curvePoints) {
  const couponNum = parseFloat(row.coupon);
  if (!isFinite(couponNum) || couponNum <= 0) return null;
  if (!row.maturity_date) return null;
  if (!curvePoints.length) return null;
  const settle = row.settle_date || row.pricing_date;
  if (!settle) return null;
  const cost = (() => {
    // OAS-at-cost target price = 100 − concession_pct
    //   fees_bp is bps per bond; 1bp = 0.01% so cost = 100 − fees_bp/100
    const fbp = parseFloat(row.fees);
    if (!isFinite(fbp)) return null;  // DNT or missing
    return 100.0 - fbp / 100.0;
  })();
  const callSchedule = _expandCallSchedule(item, row.maturity_date);
  return {
    cusip,
    issue_date:    row.pricing_date || settle,
    settle_date:   settle,
    maturity_date: row.maturity_date,
    coupon_pct:    couponNum,
    frequency:     'semiannual',
    day_count:     '30/360',
    call_schedule: callSchedule,
    curve:         curvePoints,
    target_prices: cost != null ? { par: 100.0, cost } : { par: 100.0 },
    hw_mean_reversion: 0.03,
    hw_sigma:          0.01,
  };
}

async function ingestNewIssues() {
  const start = Date.now();
  const newIssues = await _get('/api/internal/new-issues');
  const moveHist = await _fetchMoveWithRetry();
  const moveSeries = (moveHist && Array.isArray(moveHist.series)) ? moveHist.series : [];
  // Curve used for OAS and funding compute: prior business day's FRED close
  // ("T-1"). Auctions price at 10:30 ET, before today's close is known, so
  // T-1 matches UBS Neo's pricing convention.
  const today = _today();
  const tMinus1Curve = await fetchUstCurveForAuction(today).catch(() => ({ curve: {} }));
  const tMinus1Sofr  = await fetchSofrForAuction(today).catch(() => null);
  const curvePoints = _curvePointsFromApi(tMinus1Curve);
  const sofrCurve   = buildSofrCurve(tMinus1Curve, tMinus1Sofr);
  _setCurrentUstCurve(tMinus1Curve);  // enables _spreadValue() + s5s30s
  if (tMinus1Curve.fetchedFrom) {
    console.log(`[agency.ingest] auction curve as of ${tMinus1Curve.fetchedFrom} (T-1 of ${today})`);
  }

  // FHLB Callable Bond Auction Results — high-fidelity source for today's
  // FHLB auctions (trade date separate from settle, par in MM, dealer
  // concession for OAS-at-cost). Falls back gracefully if the page is down.
  let cbrByCusip = new Map();
  let cbrCount = 0;
  try {
    const cbrItems = await fhlbCbr.fetchCbr();
    cbrByCusip = new Map(cbrItems.map((i) => [i.cusip, i]));
    cbrCount = cbrItems.length;
    console.log(`[agency.ingest] FHLB CBR: ${cbrCount} auctions today`);
  } catch (e) {
    console.warn('[agency.ingest] FHLB CBR fetch failed (will fall back to /new-issues):', e.message);
  }

  // Merge: CBR items first (today's FHLB), then the rest from the existing feed.
  // Items present in both sources prefer CBR.
  const feedItems = newIssues.items || [];
  const cbrCusips = new Set(cbrByCusip.keys());
  const items = [
    ...cbrByCusip.values(),
    ...feedItems.filter((it) => !cbrCusips.has(it.cusip)),
  ];
  let fhlbCount = 0;
  let ffcbCount = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const existing = new Map(db.getRows('issues').map((r) => [r.cusip, r]));

  // First pass: build rows and OAS payloads
  const rowsByCusip = new Map();   // cusip -> { item, row, issuer }
  const oasPayloads = [];
  for (const item of items) {
    const cusip = item.cusip || '';
    if (!cusip) { skipped++; continue; }
    const issuer = _normalizeIssuer(item.issuer || item.source || item.agency || '');
    if (issuer !== 'FHLB' && issuer !== 'FFCB') { skipped++; continue; }
    // Only callable agency auctions per Phase 2 scope
    const isCallable = item.callable === true
                       || /NC\d/i.test(item.callStructure || '')
                       || /callable/i.test(item.type || '');
    if (!isCallable) { skipped++; continue; }
    // Skip zero-coupon bonds — funding/OAS model assumes coupon-paying.
    const couponNum = parseFloat(item.coupon);
    if (isFinite(couponNum) && couponNum === 0) { skipped++; continue; }
    if (issuer === 'FHLB') fhlbCount++;
    else ffcbCount++;

    const prior = existing.get(cusip);
    const row = _toIssueRow(item, moveSeries,
      issuer === 'FHLB' ? 'https://www.fhlb-of.com/' : 'https://www.farmcreditfunding.com/',
      prior ? prior.pricing_date : null);
    // Skip FHLB rows with no fee data (public new-issues feed sometimes returns
    // rows without concPer1000/feesUSD). User-entered fills happen via the
    // manual entry flow instead. We do NOT skip if it's a known DNT (fees='DNT')
    // or if there's already a prior row we'd be updating (which may keep its fees).
    if (issuer === 'FHLB' && (row.fees == null || row.fees === '') && !prior) {
      skipped++; fhlbCount--;
      continue;
    }
    rowsByCusip.set(cusip, { item, row, issuer });

    const payload = _buildOasPayload(item, cusip, row, curvePoints);
    if (payload) oasPayloads.push(payload);
  }

  // Compute OAS in a single Python batch
  let oasResults = [];
  let oasOk = 0;
  let oasErr = 0;
  if (oasPayloads.length) {
    try {
      const t0 = Date.now();
      oasResults = await oas.computeBatch(oasPayloads, 120_000);
      console.log(`[agency.ingest] OAS batch: ${oasResults.length} results in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[agency.ingest] OAS batch error:', e.message);
    }
  }
  const oasByCusip = new Map();
  for (let i = 0; i < oasResults.length; i++) {
    const r = oasResults[i];
    const cusip = oasPayloads[i].cusip;
    if (r && r.ok) {
      oasByCusip.set(cusip, r);
      oasOk++;
    } else {
      oasErr++;
    }
  }

  // Compute funding spread in a parallel Python batch. Needs fees_bp,
  // first_call_date, sofr curve.
  const fundingPayloads = [];
  for (const [cusip, { item, row }] of rowsByCusip.entries()) {
    const couponNum = parseFloat(row.coupon);
    const feesBp = parseFloat(row.fees);
    const firstCall = (Array.isArray(item.callSchedule) && item.callSchedule[0] &&
      (item.callSchedule[0].startDate || item.callSchedule[0].nextCall)) || null;
    if (!isFinite(couponNum) || !isFinite(feesBp) || !row.maturity_date || !firstCall || !sofrCurve.length) continue;
    const tenorYrs = parseFloat(item.tenorYrs) || (() => {
      // derive tenor from maturity - settle when source didn't supply it
      const m = new Date(row.maturity_date + 'T00:00:00Z');
      const s = new Date((row.settle_date || row.pricing_date) + 'T00:00:00Z');
      if (isNaN(m) || isNaN(s)) return null;
      return (m - s) / (365.25 * 86400000);
    })();
    const sigma = sigmaForTenor(tenorYrs);
    fundingPayloads.push({
      cusip,
      issue_date:    row.pricing_date || row.settle_date,
      settle_date:   row.settle_date || row.pricing_date,
      maturity_date: row.maturity_date,
      coupon_pct:    couponNum,
      frequency:     'semiannual',
      day_count:     '30/360',
      first_call_date: firstCall,
      call_price:    100,
      fees_bp:       feesBp,
      sofr_curve:    sofrCurve.map((p) => ({ tenor_years: p.tenor_years, yield_pct: p.yield_pct })),
      hw_mean_reversion: HW_MEAN_REVERSION,
      hw_sigma:          sigma, // tenor-stepped from hw-sigma.js
    });
  }
  let fundingResults = [];
  let fundingOk = 0;
  let fundingErr = 0;
  if (fundingPayloads.length) {
    try {
      const t0 = Date.now();
      fundingResults = await funding.computeBatch(fundingPayloads, 180_000);
      console.log(`[agency.ingest] funding batch: ${fundingResults.length} results in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[agency.ingest] funding batch error:', e.message);
    }
  }
  const fundingByCusip = new Map();
  for (let i = 0; i < fundingResults.length; i++) {
    const r = fundingResults[i];
    const cusip = fundingPayloads[i].cusip;
    if (r && r.ok) {
      fundingByCusip.set(cusip, r);
      fundingOk++;
    } else {
      fundingErr++;
    }
  }

  // Second pass: merge OAS + funding spread into rows and write
  for (const [cusip, { item, row }] of rowsByCusip.entries()) {
    const o = oasByCusip.get(cusip);
    if (o) {
      if (o.oas_at_par_bp != null) row.oas_par = o.oas_at_par_bp;
      if (o.oas_at_cost_bp != null) row.oas_cost = o.oas_at_cost_bp;
    }
    const n = fundingByCusip.get(cusip);
    if (n) {
      row.funding = `${n.sofr_spread_bp}/${n.model_fees_bp}`;
    }
    if (existing.has(cusip)) updated++;
    else inserted++;
    await db.upsertRow('issues', row);

    const expanded = _expandCallSchedule(item, row.maturity_date);
    // Persist only the first call date as a summary row to avoid blowing the sheet
    // with 40+ rows per CUSIP. Full schedule is reconstructable from raw_source_json.
    if (expanded.length) {
      const first = expanded[0];
      await db.upsertRow('call_schedules', {
        cusip,
        call_date: first.date,
        call_price: first.price,
        is_european_approx: 'true',
      });
    }
  }

  // Reconcile manual-entry placeholders to real CUSIPs now that today's
  // CBR/FFCB feed values are in the cache.
  let reconciled = 0;
  try {
    const out = await require('./desk-routes').reconcilePlaceholders();
    reconciled = out.matched;
    if (reconciled) console.log(`[agency.ingest] reconciled ${reconciled} placeholder CUSIPs`);
  } catch (e) {
    console.warn('[agency.ingest] reconcile failed:', e.message);
  }

  // Keep the sheet grouped: pricing_date ASC → FHLB before FFCB → shorter
  // maturities first. (FHLB > FFCB alphabetically so issuer DESC gets the
  // FHLB-first ordering the desk wants.)
  try {
    await db.sortMulti('issues', [
      { column: 'pricing_date',    direction: 'ASCENDING' },   // oldest first → newest at bottom
      { column: 'issuer',          direction: 'DESCENDING' },  // FHLB > FFCB alpha → FHLB above FFCB on same day
      { column: 'pricing_time_et', direction: 'ASCENDING' },
      { column: 'maturity_date',   direction: 'ASCENDING' },
    ]);
  } catch (e) {
    console.warn('[agency.ingest] sort issues failed:', e.message);
  }

  const summary = {
    fhlb: fhlbCount,
    ffcb: ffcbCount,
    inserted,
    updated,
    skipped,
    oas_computed: oasOk,
    oas_errors: oasErr,
    funding_computed: fundingOk,
    funding_errors: fundingErr,
    elapsed_ms: Date.now() - start,
  };
  // ── Auto-match saved indications to new real prints ──────────────────
  // For each open indication whose actual_* fields are empty, find the first
  // real CUSIP in the sheet that matches (issuer, structure, settle_date).
  // Backfill actual_coupon, actual_funding_spread, gap_bp.
  try {
    const inds = db.getRows('indications').filter((r) =>
      r.status === 'open' &&
      (!r.actual_cusip || r.actual_cusip === '')
    );
    const allIssues = db.getRows('issues');
    let matchedN = 0;
    for (const ind of inds) {
      const hit = allIssues.find((r) =>
        r.cusip && !r.cusip.startsWith('PENDING-') &&
        r.issuer === ind.issuer &&
        r.structure === ind.structure &&
        r.settle_date === ind.settle_date
      );
      if (!hit) continue;
      const actualCoupon = parseFloat(hit.coupon);
      const fundingStr = String(hit.funding || '');
      const m = fundingStr.match(/-?\d+(?:\.\d+)?/);
      const actualFunding = m ? parseFloat(m[0]) : null;
      const predicted = parseFloat(ind.predicted_funding_spread);
      const gap = (actualFunding != null && isFinite(predicted)) ? (actualFunding - predicted) : '';
      const merged = {
        ...ind,
        actual_cusip:           hit.cusip,
        actual_coupon:          isFinite(actualCoupon) ? actualCoupon : '',
        actual_funding_spread:  actualFunding != null ? actualFunding : '',
        gap_bp:                 gap !== '' ? Math.round(gap * 100) / 100 : '',
        updated_at:             new Date().toISOString(),
      };
      await db.upsertRow('indications', merged);
      matchedN++;
    }
    if (matchedN) {
      console.log(`[agency.ingest] matched ${matchedN} indications to real prints`);
      summary.indications_matched = matchedN;
    }
  } catch (e) {
    console.warn('[agency.ingest] indication match failed:', e.message);
  }

  // Auto-reconcile PENDING- placeholders to their real-CUSIP counterparts.
  // The CBR pull often arrives a day after the user typed a placeholder, so
  // the matcher now tolerates pricing_date drift up to 5 days.
  try {
    const { reconcilePlaceholders } = require('./desk-routes');
    if (typeof reconcilePlaceholders === 'function') {
      const rec = await reconcilePlaceholders();
      if (rec && rec.matched) summary.placeholders_reconciled = rec.matched;
    }
  } catch (e) {
    console.warn('[agency.ingest] auto-reconcile failed:', e.message);
  }

  // Re-sort so newly-inserted/merged rows land in the right place
  // (pricing_date ASC, issuer DESC, maturity_date ASC).
  try {
    await db.sortMulti('issues', [
      { column: 'pricing_date',    direction: 'ASCENDING' },
      { column: 'issuer',          direction: 'DESCENDING' },
      { column: 'pricing_time_et', direction: 'ASCENDING' },
      { column: 'maturity_date',   direction: 'ASCENDING' },
    ]);
  } catch (e) {
    console.warn('[agency.ingest] re-sort failed:', e.message);
  }

  await db.audit('(cron)', 'ingest_new_issues', summary);
  console.log('[agency.ingest] new-issues:', summary);
  return summary;
}

async function ingestMarketSnapshot() {
  const start = Date.now();
  const today = _today();

  const curve = await _get('/api/curve').catch((e) => { console.error('[agency.ingest] curve fetch failed:', e.message); return null; });
  const move = await _fetchMoveWithRetry();

  let curveRows = 0;
  if (curve && curve.curve) {
    for (const [tenor, data] of Object.entries(curve.curve)) {
      const y = data && data.yield;
      if (y == null) continue;
      await db.upsertRow('curve_snapshots', {
        snapshot_date: today,
        tenor,
        yield_pct: y,
      });
      curveRows++;
    }
  }

  let moveRow = 0;
  const moveClose = _lastMoveClose(move);
  if (moveClose != null) {
    await db.upsertRow('move_snapshots', {
      snapshot_date: today,
      move_close: moveClose,
    });
    moveRow = 1;
  }

  const econ = await _get('/api/econ').catch(() => null);
  let sofrRow = 0;
  const sofr = econ && econ.data && (econ.data.sofr || econ.data.SOFR);
  if (sofr && sofr.current != null) {
    await db.upsertRow('sofr_snapshots', {
      snapshot_date: today,
      sofr_overnight: sofr.current,
      sofr_30d_avg: '',
      sofr_90d_avg: '',
    });
    sofrRow = 1;
  }

  const summary = {
    curve_rows: curveRows,
    move_rows: moveRow,
    sofr_rows: sofrRow,
    elapsed_ms: Date.now() - start,
  };
  await db.audit('(cron)', 'ingest_market_snapshot', summary);
  console.log('[agency.ingest] market-snapshot:', summary);
  return summary;
}

async function ingestPendingAuctions() {
  const start = Date.now();
  let parsed = { items: [] };
  try {
    parsed = await fhlbCba.fetchCba();
  } catch (e) {
    console.warn('[agency.ingest] CBA fetch failed:', e.message);
    return { error: e.message, items: 0, elapsed_ms: Date.now() - start };
  }
  // Purge stale FHLB rows only — past trade dates from the FHLB source. We never
  // touch FFCB rows (different ingest path) or future-dated rows (user-added
  // tomorrow tentatives the CBA page doesn't list yet).
  let deleted = 0;
  const today = _today();
  deleted = await db.deleteWhere('pending_auctions', (r) =>
    (r.source === 'FHLB' || r.source === 'fhlb') &&
    r.trade_date && r.trade_date < today
  );
  // Normalize the structure on each item before upserting so downstream predictor
  // / display code can parse it (CBA format like "7 Yr nc 1 Yr (A)" → "7yr/1yr").
  function _normalizeCbaStructure(s) {
    if (!s) return s;
    const m = String(s).match(/(\d+(?:\.\d+)?)\s*Yr\s*nc\s*(\d+(?:\.\d+)?)\s*(Yr|Mo)/i);
    if (!m) return s;
    const tenor = m[1];
    const lock  = m[2];
    const unit  = m[3].toLowerCase() === 'yr' ? 'yr' : 'mo';
    return `${tenor}yr/${lock}${unit}`;
  }
  let upserted = 0;
  for (const it of parsed.items) {
    const itNorm = { ...it, structure: _normalizeCbaStructure(it.structure) };
    await db.upsertRow('pending_auctions', itNorm);
    upserted++;
  }
  const summary = {
    trade_date: parsed.tradeDate,
    items: upserted,
    purged_stale: deleted,
    elapsed_ms: Date.now() - start,
  };
  await db.audit('(cron)', 'ingest_pending_auctions', summary);
  console.log('[agency.ingest] pending-auctions:', summary);
  return summary;
}

async function runAll() {
  const out = { startedAt: new Date().toISOString() };
  try {
    out.market = await ingestMarketSnapshot();
  } catch (e) {
    out.market = { error: e.message };
    console.error('[agency.ingest] market error:', e.message);
  }
  try {
    out.pendingAuctions = await ingestPendingAuctions();
  } catch (e) {
    out.pendingAuctions = { error: e.message };
    console.error('[agency.ingest] pending-auctions error:', e.message);
  }
  try {
    out.newIssues = await ingestNewIssues();
  } catch (e) {
    out.newIssues = { error: e.message };
    console.error('[agency.ingest] new-issues error:', e.message);
  }
  out.endedAt = new Date().toISOString();
  return out;
}

module.exports = {
  ingestNewIssues,
  ingestMarketSnapshot,
  ingestPendingAuctions,
  runAll,
  _expandCallScheduleForRoute: _expandCallSchedule,
};
