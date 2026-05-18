// Morning-indication predictor.
//
// Given (issuer, structure, settle_date, yel, [fees_override], [target_funding_override])
// produces:
//   - validated/normalized dates (maturity, first_call)
//   - target funding spread (from recent comparable prints, or override)
//   - coupon range (mid ± 1.5 bp, solved against funding.py)
//   - spread label using the same tagging convention as ingest.js
//   - sample-size + std-dev + comparables list (for the "reasoning" panel)

const path = require('path');
const { spawn } = require('child_process');

const db = require('./db');
const { sigmaForTenor, HW_MEAN_REVERSION } = require('./hw-sigma');
const { ffcbFeesForTenor } = require('./ffcb-fees');
const { fetchUstCurveForAuction, fetchSofrForAuction } = require('./historical-curve');
const { buildSofrCurve } = require('./sofr-curve');

const FUNDING_PY = path.join(__dirname, '..', '..', 'quant', 'funding.py');
const PY_BIN = process.env.AGENCY_PYTHON || 'python3';

// MOVE baseline = center of the σ-calibration window (avg of our anchor MOVEs).
// At MOVE = baseline, σ is used as calibrated. At higher/lower MOVE, σ scales.
const MOVE_BASELINE = 72;

// Structure popularity scores (1.0 = very popular, 0.0 = niche).
// Hot retail-friendly callable structures get bid quickly; long-lockout / unusual
// structures take longer to clear. These get refined as we tag prints over time.
const STRUCTURE_POPULARITY = {
  '5yr/1yr':   0.90,
  '5yr/6mo':   0.85,
  '5yr/3mo':   0.80,
  '7yr/1yr':   0.85,
  '7yr/6mo':   0.85,
  '7yr/3mo':   0.80,
  '7yr/3yr':   0.40,
  '10yr/1yr':  0.95,
  '10yr/6mo':  0.90,
  '10yr/3mo':  0.85,
  '10yr/5yr':  0.30,
  '10yr/3yr':  0.45,
  '15yr/1yr':  0.80,
  '15yr/6mo':  0.80,
  '15yr/3mo':  0.75,
  '20yr/1yr':  0.75,
  '20yr/6mo':  0.75,
  '20yr/2yr':  0.50,
  '20yr/3yr':  0.40,
  '30yr/1yr':  0.60,
  '30yr/6mo':  0.60,
  '3yr/1yr':   0.75,
  '4yr/3mo':   0.65,
  '4yr/1yr':   0.70,
};
function structurePopularity(structure) {
  if (STRUCTURE_POPULARITY[structure] != null) return STRUCTURE_POPULARITY[structure];
  return 0.5; // unknown structure — neutral
}

// Market-demand-driven aggressive/cheap offsets (bp on funding spread).
// Returns null when no comparable survey signals exist — UI then hides the
// aggressive/cheap tiers and asks the user to fill in comparable color.
function offsetsFromComparables(comp) {
  if (!comp || comp.n === 0) return null;
  // Collect signals across comparables. Each non-null signal contributes a
  // bp-shift representing market demand. Positive = hot (can be tighter),
  // negative = soft (need to be looser).
  let bp_sum = 0, signals_n = 0;
  for (const r of comp.rows || []) {
    const sigSize = isFinite(r.size_mm) && r.size_mm > 0 ? r.size_mm : null;
    // Upsize: amount as fraction of original size, capped at 100%. 50% upsize → +2.5 bp tighter.
    if (r.upsize_status && r.upsize_status !== '') {
      const amt = isFinite(r.upsize_amount_mm) ? r.upsize_amount_mm : null;
      const ratio = (amt && sigSize) ? Math.min(1.0, amt / sigSize) : 0.3;  // assume 30% if amount unknown
      bp_sum += ratio * 5;
      signals_n++;
    }
    // Bonds left: >30% remaining = market saturated → needs to come cheaper.
    if (isFinite(r.bonds_left_street_mm) && sigSize) {
      const leftRatio = r.bonds_left_street_mm / sigSize;
      bp_sum -= Math.max(0, (leftRatio - 0.3)) * 10;
      signals_n++;
    }
    // Current showing price relative to par: 0.5pt above → +2.5 bp tighter.
    // Below par compresses more aggressively (asymmetric).
    if (isFinite(r.current_price)) {
      const dev = r.current_price - 100;
      bp_sum += dev > 0 ? dev * 5 : dev * 8;
      signals_n++;
    }
    // Last traded price — same sign, less weight (it's older data).
    if (isFinite(r.last_traded_price)) {
      const dev = r.last_traded_price - 100;
      bp_sum += dev > 0 ? dev * 3 : dev * 5;
      signals_n++;
    }
  }
  if (signals_n === 0) return null;
  const demand_bp = bp_sum / signals_n;  // avg market demand signal (bp)
  // Aggressive: tighter by demand_bp + base 2bp. Capped.
  const aggressive = Math.max(2, Math.min(8, 2 + Math.max(0, demand_bp)));
  // Cheap: looser by base 2bp + how much soft demand. Capped.
  const cheap = Math.max(2, Math.min(8, 2 + Math.max(0, -demand_bp)));
  return { aggressive: Math.round(aggressive * 10) / 10, cheap: Math.round(cheap * 10) / 10, demand_bp: Math.round(demand_bp * 10) / 10, signals_n };
}

// Speed score: 0 (very fast) → 1 (likely DNT). Returns a {score, category} object.
// Inputs include aggregate post-print signals from comparables when available.
function speedScore({ sizeMM, structure, yel, fundingPredicted, fundingAvg, move, comp }) {
  const s = parseFloat(sizeMM) || 25;
  // Size: 5MM → ~0.13, 25MM → 0.51, 50MM → 0.76, 100MM → 0.94
  const sizeFactor = 1 - Math.exp(-s / 35);
  const pop = structurePopularity(structure);
  const yelDelta = yel === 'Y' ? -0.10 : 0;
  let fundDelta = 0;
  if (isFinite(fundingPredicted) && isFinite(fundingAvg) && fundingAvg !== 0) {
    fundDelta = Math.max(-0.15, Math.min(0.30, (fundingAvg - fundingPredicted) / Math.abs(fundingAvg)));
    fundDelta = fundDelta * 0.4;
  }
  const moveLevel = parseFloat(move);
  const moveDelta = isFinite(moveLevel) ? Math.max(-0.1, Math.min(0.3, (moveLevel - MOVE_BASELINE) / 100)) : 0;

  // Post-print signals from comparables (when filled in by the user).
  // Three independent signals, each shifts the score:
  //   upsize fraction → faster (negative)
  //   bonds left on street → slower (positive, scaled by size)
  //   current price < par → slower; > par → faster
  let postPrintDelta = 0;
  if (comp && comp.n > 0) {
    const upsizeFrac = comp.upsized_count / comp.n;
    postPrintDelta -= upsizeFrac * 0.25;
    if (isFinite(comp.avg_bonds_left)) {
      // 0MM left → 0, 5MM → 0.05, 15MM → 0.15, 30MM → 0.3 (capped)
      postPrintDelta += Math.min(0.30, comp.avg_bonds_left / 100);
    }
    if (isFinite(comp.avg_current_price)) {
      const dev = comp.avg_current_price - 100;  // bp from par
      // -1pt (price 99) → +0.15 slower; +0.5pt (100.5) → -0.05 faster
      postPrintDelta -= Math.max(-0.20, Math.min(0.25, dev * 0.15));
    }
  }

  let score = sizeFactor * 0.5 + (1 - pop) * 0.3 + yelDelta + fundDelta + moveDelta + postPrintDelta;
  score = Math.max(0, Math.min(1, score));

  // Richness floor — small bonds still trade fast *within reason*. If predicted
  // funding is way tighter than recent avg (super rich), enforce a slower floor
  // on the score regardless of how small/popular the bond is.
  //   3 bp through avg → floor 0.30
  //   5 bp through    → floor 0.40 (normal)
  //  10 bp through    → floor 0.65 (slow)
  //  15+ bp through   → floor 0.85 (likely DNT)
  let richness_floor = null;
  if (isFinite(fundingPredicted) && isFinite(fundingAvg)) {
    const richness_bp = fundingAvg - fundingPredicted;
    if (richness_bp > 3) {
      richness_floor = Math.min(0.85, 0.30 + (richness_bp - 3) * 0.05);
      score = Math.max(score, richness_floor);
    }
  }

  let category;
  if (score < 0.25) category = 'fast';
  else if (score < 0.55) category = 'normal';
  else if (score < 0.80) category = 'slow';
  else                  category = 'likely_dnt';
  return {
    score: Math.round(score * 100) / 100,
    category,
    factors: {
      size_mm: s,
      structure_popularity: pop,
      yel_delta: yelDelta,
      funding_aggressiveness_delta: Math.round(fundDelta * 100) / 100,
      move_delta: Math.round(moveDelta * 100) / 100,
      post_print_delta: Math.round(postPrintDelta * 100) / 100,
      richness_floor: richness_floor != null ? Math.round(richness_floor * 100) / 100 : null,
      comparable_n_with_signals: comp ? (comp.upsized_count + (comp.avg_bonds_left != null ? 1 : 0) + (comp.avg_current_price != null ? 1 : 0)) : 0,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Date validation — US bond market (SIFMA) holiday calendar
// ──────────────────────────────────────────────────────────────────────────
const SIFMA_HOLIDAYS = new Set([
  // 2026
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-10-12','2026-11-11',
  '2026-11-26','2026-12-25',
  // 2027
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
  '2027-06-18','2027-07-05','2027-09-06','2027-10-11','2027-11-11',
  '2027-11-25','2027-12-24',
]);

function isBusinessDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0) return { ok: false, reason: 'Sunday' };
  if (dow === 6) return { ok: false, reason: 'Saturday' };
  if (SIFMA_HOLIDAYS.has(iso)) return { ok: false, reason: 'SIFMA holiday' };
  return { ok: true };
}

function nextBusinessDay(iso) {
  let d = new Date(iso + 'T00:00:00Z');
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = d.toISOString().slice(0, 10);
    if (isBusinessDay(s).ok) return s;
  }
  return null;
}

function priorBusinessDay(iso) {
  let d = new Date(iso + 'T00:00:00Z');
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (isBusinessDay(s).ok) return s;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Structure parsing
// ──────────────────────────────────────────────────────────────────────────
function parseStructure(structure) {
  // Examples: "20yr/1yr", "10yr/6mo", "15yr/3mo", "5yr/1yr"
  if (!structure || typeof structure !== 'string') return null;
  const norm = structure.trim().toLowerCase();
  const m = norm.match(/^(\d+(?:\.\d+)?)\s*yr\s*\/\s*(\d+(?:\.\d+)?)\s*(yr|mo)$/);
  if (!m) return null;
  const finalTenor = parseFloat(m[1]);
  const lockNum = parseFloat(m[2]);
  const lockoutYrs = m[3] === 'mo' ? lockNum / 12 : lockNum;
  return { finalTenorYrs: finalTenor, lockoutYrs };
}

function addYearsISO(iso, years) {
  const d = new Date(iso + 'T00:00:00Z');
  const wholeYears = Math.floor(years);
  d.setUTCFullYear(d.getUTCFullYear() + wholeYears);
  const fracMonths = Math.round((years - wholeYears) * 12);
  if (fracMonths) d.setUTCMonth(d.getUTCMonth() + fracMonths);
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Spread label (same convention as ingest.js)
// ──────────────────────────────────────────────────────────────────────────
function spreadLabel(tenorYrs, coupon, curve) {
  if (!isFinite(coupon) || !isFinite(tenorYrs) || !curve) return '';
  const lookup = (k) => {
    const v = curve[k];
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && typeof v.yield === 'number') return v.yield;
    return null;
  };
  const bp = (c, u) => (isFinite(c) && isFinite(u)) ? Math.round((c - u) * 100) : null;
  const fmt = (v, k) => v != null ? `${v}/${k}` : null;
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

// ──────────────────────────────────────────────────────────────────────────
// 4. Comparables — recent same-structure prints
// ──────────────────────────────────────────────────────────────────────────
function _parseFundingSpread(funding) {
  // The "funding" column stores user-entered "X/Y" where X is the funding spread (bp).
  if (funding == null) return null;
  const s = String(funding).trim();
  if (!s || s === 'DNT') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function _normStructure(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

// Parse "7yr/6mo" into { tenor: 7, lockout: 0.5 } years.
function _structureParts(s) {
  const norm = _normStructure(s);
  const m = norm.match(/^(\d+(?:\.\d+)?)yr\/(\d+(?:\.\d+)?)(yr|mo)$/);
  if (!m) return null;
  const tenor = parseFloat(m[1]);
  const lockNum = parseFloat(m[2]);
  const lockout = m[3] === 'mo' ? lockNum / 12 : lockNum;
  return { tenor, lockout };
}

function findComparables({ issuer, structure, lookbackDays = 30, maxN = 8, lockoutTolerance = 0.75 }) {
  const all = db.getRows('issues') || [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const target = _structureParts(structure);
  // Fall back to strict-match if we can't parse the target structure.
  if (!target) {
    const sNorm = _normStructure(structure);
    return all
      .filter((r) => r.issuer === issuer)
      .filter((r) => _normStructure(r.structure) === sNorm)
      .filter((r) => r.pricing_date && r.pricing_date >= cutoffIso)
      .filter((r) => r.fees && r.fees !== 'DNT')
      .filter((r) => _parseFundingSpread(r.funding) != null)
      .sort((a, b) => (a.pricing_date < b.pricing_date ? 1 : -1))
      .slice(0, maxN);
  }
  // Match by same tenor + lockout within `lockoutTolerance` years.
  // Rank by closeness: exact match first, then by lockout distance, then by date.
  const candidates = [];
  for (const r of all) {
    if (r.issuer !== issuer) continue;
    if (!r.pricing_date || r.pricing_date < cutoffIso) continue;
    if (!r.fees || r.fees === 'DNT') continue;
    if (_parseFundingSpread(r.funding) == null) continue;
    const rp = _structureParts(r.structure);
    if (!rp) continue;
    if (rp.tenor !== target.tenor) continue;
    const dLock = Math.abs(rp.lockout - target.lockout);
    if (dLock > lockoutTolerance) continue;
    candidates.push({ row: r, dLock, exact: dLock < 1e-6 });
  }
  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.dLock !== b.dLock) return a.dLock - b.dLock;
    return a.row.pricing_date < b.row.pricing_date ? 1 : -1;
  });
  // Attach a flag/diff so summary can show "near match" in the table.
  return candidates.slice(0, maxN).map((c) => ({ ...c.row, _lockout_diff_yrs: c.dLock, _structure_exact: c.exact }));
}

function _mean(xs)  { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function _stddev(xs) {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  return Math.sqrt(_mean(xs.map((x) => (x - m) ** 2)));
}

// YEL → non-YEL deltas (funding spread + fees). Market practice per the desk:
//   - YEL bonds price *tighter* (cheaper all-in for issuer)
//   - YEL bonds have *higher stated coupon* but *lower fees*
//   - All-in cost: YEL < non-YEL
// We use both deltas to make the YEL coupon come out higher (correct) while
// keeping the funding spread tighter (also correct).
const YEL_MARKET_PRIOR_BP = -2.0;       // YEL ~ −2bp tighter funding spread
const YEL_FEES_PRIOR_BP   = -10.0;      // YEL ~ −10bp lower fees (drives higher stated coupon)
const YEL_EMPIRICAL_MIN_SAMPLE = 10;
const YEL_DELTA_CAP_BP   = 3.0;
const YEL_FEES_CAP_BP    = 15.0;

function computeYelDelta(targetTenorYears) {
  const all = db.getRows('issues') || [];
  const tenorOf = (s) => {
    const m = String(s || '').match(/^(\d+(?:\.\d+)?)yr/i);
    return m ? parseFloat(m[1]) : null;
  };

  // Try same-tenor cohort (±2 yr). Require large sample on both sides to override the prior.
  if (isFinite(targetTenorYears)) {
    const bucket = all.filter((r) => {
      const t = tenorOf(r.structure);
      return t != null && Math.abs(t - targetTenorYears) <= 2 && _parseFundingSpread(r.funding) != null;
    });
    const bY = bucket.filter((r) => r.yel === 'Y').map((r) => _parseFundingSpread(r.funding));
    const bN = bucket.filter((r) => !r.yel || r.yel === '').map((r) => _parseFundingSpread(r.funding));
    if (bY.length >= YEL_EMPIRICAL_MIN_SAMPLE && bN.length >= YEL_EMPIRICAL_MIN_SAMPLE) {
      const raw = _mean(bY) - _mean(bN);
      const capped = Math.max(-YEL_DELTA_CAP_BP, Math.min(YEL_DELTA_CAP_BP, raw));
      return {
        delta: Math.round(capped * 10) / 10,
        n_yel: bY.length, n_non: bN.length,
        scope: `${targetTenorYears}y±2 empirical (raw ${raw.toFixed(1)} bp, capped ±${YEL_DELTA_CAP_BP})`,
      };
    }
    // Sample too small — note what we'd have seen, but use the prior.
    return {
      delta: YEL_MARKET_PRIOR_BP,
      n_yel: bY.length, n_non: bN.length,
      scope: `market prior ${YEL_MARKET_PRIOR_BP} bp (YEL cheaper; sample ${bY.length}/${bN.length} too small for empirical)`,
    };
  }

  return { delta: YEL_MARKET_PRIOR_BP, n_yel: 0, n_non: 0, scope: `market prior ${YEL_MARKET_PRIOR_BP} bp (YEL cheaper)` };
}

// Same structure as computeYelDelta but for the *fees* delta. YEL prints tend
// to come with significantly lower fees than non-YEL of the same tenor. We use
// empirical when we have ≥10 of each side in the tenor bucket; otherwise fall
// back to the market prior (−10 bp).
function computeYelFeesDelta(targetTenorYears) {
  const all = db.getRows('issues') || [];
  const tenorOf = (s) => {
    const m = String(s || '').match(/^(\d+(?:\.\d+)?)yr/i);
    return m ? parseFloat(m[1]) : null;
  };
  if (isFinite(targetTenorYears)) {
    const bucket = all.filter((r) => {
      const t = tenorOf(r.structure);
      const f = parseFloat(r.fees);
      return t != null && Math.abs(t - targetTenorYears) <= 2 && isFinite(f);
    });
    const bY = bucket.filter((r) => r.yel === 'Y').map((r) => parseFloat(r.fees));
    const bN = bucket.filter((r) => !r.yel || r.yel === '').map((r) => parseFloat(r.fees));
    if (bY.length >= YEL_EMPIRICAL_MIN_SAMPLE && bN.length >= YEL_EMPIRICAL_MIN_SAMPLE) {
      const raw = _mean(bY) - _mean(bN);
      const capped = Math.max(-YEL_FEES_CAP_BP, Math.min(YEL_FEES_CAP_BP, raw));
      return {
        delta: Math.round(capped * 10) / 10,
        n_yel: bY.length, n_non: bN.length,
        scope: `${targetTenorYears}y±2 empirical (raw ${raw.toFixed(1)} bp, capped ±${YEL_FEES_CAP_BP})`,
      };
    }
    return {
      delta: YEL_FEES_PRIOR_BP,
      n_yel: bY.length, n_non: bN.length,
      scope: `market prior ${YEL_FEES_PRIOR_BP} bp fees (sample ${bY.length}/${bN.length} too small)`,
    };
  }
  return { delta: YEL_FEES_PRIOR_BP, n_yel: 0, n_non: 0, scope: `market prior ${YEL_FEES_PRIOR_BP} bp fees` };
}

function summarizeComparables(rows, targetYel, yelDelta) {
  const yelTarget = targetYel === 'Y';
  const adj = isFinite(yelDelta) ? yelDelta : 0;
  const out = rows.map((r) => {
    const compYel = r.yel === 'Y';
    const fundingRaw = _parseFundingSpread(r.funding);
    // If comparable YEL state differs from target, shift its funding spread.
    // Comparable YEL → target non-YEL: subtract yelDelta (un-adjust toward non-YEL)
    // Comparable non-YEL → target YEL: add yelDelta
    let fundingAdj = fundingRaw;
    let yelMismatch = false;
    if (isFinite(fundingRaw) && compYel !== yelTarget) {
      yelMismatch = true;
      fundingAdj = fundingRaw + (yelTarget ? adj : -adj);
    }
    return {
      cusip: r.cusip,
      pricing_date: r.pricing_date,
      structure:    r.structure,
      structure_exact: !!r._structure_exact,
      lockout_diff_yrs: r._lockout_diff_yrs,
      coupon: parseFloat(r.coupon),
      fees: parseFloat(r.fees),
      size_mm: parseFloat(r.size) || null,
      funding_spread:     fundingRaw,    // original print
      funding_spread_adj: fundingAdj,    // adjusted for YEL mismatch (used in avg)
      yel_mismatch:       yelMismatch,
      yel: r.yel || '',
      upsize_status:       r.upsize_status || '',
      upsize_amount_mm:    parseFloat(r.upsize_amount_mm),
      bonds_left_street_mm: parseFloat(r.bonds_left_street_mm),
      current_price:        parseFloat(r.current_price),
      last_traded_price:    parseFloat(r.last_traded_price),
      execution_speed:      r.execution_speed || '',
    };
  });
  // Use ADJUSTED funding spreads when averaging.
  const fs = out.map((r) => r.funding_spread_adj).filter((v) => isFinite(v));
  const fees = out.map((r) => r.fees).filter((v) => isFinite(v));
  // Aggregate post-print signals across comparables that have them.
  const withSpeed = out.filter((r) => r.execution_speed);
  const speedCounts = { fast: 0, normal: 0, slow: 0, dnt: 0 };
  withSpeed.forEach((r) => { if (speedCounts[r.execution_speed] != null) speedCounts[r.execution_speed]++; });
  const upsizedN = out.filter((r) => r.upsize_status && r.upsize_status !== '').length;
  const leftFigures = out.map((r) => r.bonds_left_street_mm).filter((v) => isFinite(v));
  const priceFigures = out.map((r) => r.current_price).filter((v) => isFinite(v));
  const n_mismatch = out.filter((r) => r.yel_mismatch).length;
  return {
    n: out.length,
    avg_funding_spread: fs.length ? _mean(fs) : null,
    std_funding_spread: fs.length ? _stddev(fs) : null,
    avg_fees: fees.length ? _mean(fees) : null,
    speed_counts: speedCounts,
    upsized_count: upsizedN,
    avg_bonds_left: leftFigures.length ? _mean(leftFigures) : null,
    avg_current_price: priceFigures.length ? _mean(priceFigures) : null,
    yel_target: targetYel,
    yel_delta_applied: adj,
    n_yel_mismatched: n_mismatch,
    rows: out,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 5. funding.py — solve for coupon given target funding spread
// ──────────────────────────────────────────────────────────────────────────
function _runFundingPy(payload, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY_BIN, [FUNDING_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('funding.py timeout')); }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(stdout)); } catch (e) {
        reject(new Error(`funding.py parse: ${e.message}: ${stdout.slice(0, 300)} stderr=${stderr.slice(0, 200)}`));
      }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Main predictor
// ──────────────────────────────────────────────────────────────────────────
async function predictIndication(input) {
  const errors = [];
  const issuer = (input.issuer || '').toUpperCase();
  if (issuer !== 'FHLB' && issuer !== 'FFCB') errors.push('issuer must be FHLB or FFCB');

  const struct = parseStructure(input.structure);
  if (!struct) errors.push('could not parse structure (expected like "20yr/1yr" or "10yr/6mo")');

  const settle = input.settle_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settle || '')) errors.push('settle_date must be YYYY-MM-DD');

  if (errors.length) return { ok: false, errors };

  const settleCheck = isBusinessDay(settle);
  if (!settleCheck.ok) {
    const next = nextBusinessDay(settle);
    return {
      ok: false,
      errors: [`${settle} is a ${settleCheck.reason} — pick a business day (next available: ${next})`],
      suggested_settle: next,
    };
  }

  const yel = (input.yel === true || input.yel === 'Y' || input.yel === 'y') ? 'Y' : '';

  // Maturity = settle + final tenor; first call = settle + lockout
  const maturity = addYearsISO(settle, struct.finalTenorYrs);
  const firstCall = addYearsISO(settle, struct.lockoutYrs);

  // Pricing date = today (the morning the user runs this), curve = T-1
  const today = new Date().toISOString().slice(0, 10);
  const curveResp = await fetchUstCurveForAuction(today).catch(() => ({ curve: {} }));
  const ustCurve = curveResp.curve || {};
  const curveDate = curveResp.fetchedFrom || (priorBusinessDay(today) || today);
  const sofr = await fetchSofrForAuction(today).catch(() => null);

  if (!ustCurve || Object.keys(ustCurve).length === 0) {
    return { ok: false, errors: ['could not fetch UST curve (FRED may be rate-limited)'] };
  }
  if (!sofr) {
    return { ok: false, errors: ['could not fetch SOFR curve'] };
  }

  // Live snapshot overrides — for any UST tenor / SOFR-O/N that's set today,
  // overwrite the FRED EOD value so the prediction uses *current* levels.
  const snap = db.getRows('market_snapshots').find((r) => r.snapshot_date === today) || {};
  const snapMap = { '2yr':snap.ust_2y, '3yr':snap.ust_3y, '5yr':snap.ust_5y, '7yr':snap.ust_7y,
                    '10yr':snap.ust_10y, '20yr':snap.ust_20y, '30yr':snap.ust_30y };
  const overridden = [];
  for (const [k, v] of Object.entries(snapMap)) {
    const n = parseFloat(v);
    if (isFinite(n) && n > 0) {
      ustCurve[k] = { yield: n, date: today };
      overridden.push(k);
    }
  }
  const sofrSnap = parseFloat(snap.sofr_overnight);
  const sofrEffective = isFinite(sofrSnap) && sofrSnap > 0 ? sofrSnap : sofr;
  const moveSnap = parseFloat(snap.move);
  const moveUsed = isFinite(moveSnap) && moveSnap > 0 ? moveSnap : null;

  // Find comparables — start 30d, widen if nothing recent.
  let comps = findComparables({ issuer, structure: input.structure, lookbackDays: 30 });
  let lookback_used = 30;
  if (comps.length === 0) { comps = findComparables({ issuer, structure: input.structure, lookbackDays: 90 });  lookback_used = 90;  }
  if (comps.length === 0) { comps = findComparables({ issuer, structure: input.structure, lookbackDays: 365 }); lookback_used = 365; }
  // Compute YEL delta — prefer same-tenor cohort, fall back to capped global.
  const yelStats = computeYelDelta(struct.finalTenorYrs);
  const comp = summarizeComparables(comps, yel, yelStats.delta);

  // Decide target funding spread (override > auto)
  let target_funding_spread = null;
  let funding_source = '';
  if (input.target_funding_spread != null && input.target_funding_spread !== '') {
    target_funding_spread = parseFloat(input.target_funding_spread);
    funding_source = 'user-override';
  } else if (comp.avg_funding_spread != null) {
    target_funding_spread = comp.avg_funding_spread;
    funding_source = `avg of ${comp.n} ${issuer} ${input.structure} prints (last ${lookback_used} days)`;
  } else {
    return { ok: false, errors: [`No ${issuer} ${input.structure} prints found in the last year. Either (a) check the structure spelling — sheet uses lowercase like "20yr/1yr" or "10yr/6mo", or (b) enter "Target fund" manually to override.`] };
  }

  // Decide fees (override > FFCB schedule > recent avg)
  let fees_bp = null;
  let fees_source = '';
  if (input.fees != null && input.fees !== '') {
    fees_bp = parseFloat(input.fees);
    fees_source = 'user-input';
  } else if (issuer === 'FFCB') {
    const ffcb = ffcbFeesForTenor(struct.finalTenorYrs);
    if (ffcb != null) { fees_bp = ffcb; fees_source = `FFCB schedule (${struct.finalTenorYrs}y tenor)`; }
  }
  if (fees_bp == null && comp.avg_fees != null) {
    fees_bp = Math.round(comp.avg_fees * 10) / 10;
    fees_source = `avg fees of ${comp.n} comparable prints`;
  }
  if (fees_bp == null) {
    return { ok: false, errors: ['no fees override given and no comparable prints to derive fees from'] };
  }

  // YEL fees adjustment — if predicting YEL and the base fees came from a
  // mixed-YEL source (FFCB schedule or non-YEL-dominant comparables), reduce
  // fees by the empirical YEL-fees delta. Skip if user supplied fees explicitly.
  const yelFeesStats = computeYelFeesDelta(struct.finalTenorYrs);
  let fees_yel_adjustment_bp = 0;
  if (fees_source !== 'user-input' && yel === 'Y') {
    // YEL bonds get the negative delta (lower fees).
    fees_yel_adjustment_bp = yelFeesStats.delta;
    fees_bp = Math.max(0, Math.round((fees_bp + fees_yel_adjustment_bp) * 10) / 10);
    fees_source = fees_source + ` + YEL fees adj ${fees_yel_adjustment_bp} bp`;
  } else if (fees_source !== 'user-input' && yel !== 'Y' && comp.n > 0) {
    // If predicting non-YEL but comparable fees were derived from a YEL-skewed
    // sample, push fees back up. Approximation: if >50% of comparables are YEL,
    // shift fees up by |delta|.
    const yelFraction = comp.rows.filter((r) => r.yel === 'Y').length / comp.n;
    if (yelFraction > 0.5) {
      fees_yel_adjustment_bp = -yelFeesStats.delta;
      fees_bp = Math.max(0, Math.round((fees_bp + fees_yel_adjustment_bp) * 10) / 10);
      fees_source = fees_source + ` + non-YEL fees adj +${(-yelFeesStats.delta).toFixed(1)} bp`;
    }
  }

  // σ for the tenor, scaled by today's MOVE if provided.
  const sigmaBase = sigmaForTenor(struct.finalTenorYrs);
  const moveScalar = moveUsed ? Math.max(0.5, Math.min(2.0, moveUsed / MOVE_BASELINE)) : 1.0;
  const sigma = sigmaBase * moveScalar;

  // ── Bias correction ────────────────────────────────────────────────────
  // For each (issuer, structure) pair, compute an exponentially-weighted moving
  // average of (actual − predicted) funding spread from past matched indications,
  // then apply that as an offset to today's target before solving for coupon.
  // EWMA half-life ~5 prints.
  const HL = 5;
  const matched = db.getRows('indications').filter((r) =>
    r.issuer === issuer &&
    r.structure === input.structure &&
    r.actual_funding_spread !== '' && r.actual_funding_spread != null &&
    r.predicted_funding_spread !== '' && r.predicted_funding_spread != null
  ).sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  let bias_correction_bp = 0, bias_n = 0;
  if (matched.length > 0) {
    let num = 0, den = 0;
    matched.forEach((r, i) => {
      const ageFromNewest = matched.length - 1 - i;
      const w = Math.pow(0.5, ageFromNewest / HL);
      const gap = parseFloat(r.actual_funding_spread) - parseFloat(r.predicted_funding_spread);
      if (isFinite(gap)) { num += w * gap; den += w; }
    });
    if (den > 0) { bias_correction_bp = num / den; bias_n = matched.length; }
  }

  const target_funding_with_bias = target_funding_spread + bias_correction_bp;

  // SOFR curve = UST curve − basis (the same convention used in calibrate/ingest).
  // We re-pack curveResp.curve with our possibly-overridden ustCurve so the
  // overrides flow through buildSofrCurve.
  const curveForSofr = { ...curveResp, curve: ustCurve };
  const sofrOn = (typeof sofrEffective === 'number' && isFinite(sofrEffective))
    ? sofrEffective
    : (sofr && (sofr.sofr_overnight ?? sofr.sofr_30d_avg)) ?? null;
  const sofrCurve = buildSofrCurve(curveForSofr, sofrOn);
  if (!sofrCurve || sofrCurve.length < 5) {
    return { ok: false, errors: ['SOFR curve has <5 points — cannot solve'] };
  }
  const sofrCurvePayload = sofrCurve.map((p) => ({ tenor_years: p.tenor_years, yield_pct: p.yield_pct }));

  // Predicted-first coupon solve. Aggressive and cheap are computed only if the
  // user has filled in comparable survey signals; otherwise the UI prompts for them.
  const offsets = offsetsFromComparables(comp);
  const basePayload = {
    mode: 'solve_coupon',
    settle_date: settle,
    issue_date:  settle,
    maturity_date: maturity,
    first_call_date: firstCall,
    fees_bp,
    call_price: 100.0,
    frequency: 'Semiannual',
    day_count: '30/360',
    sofr_curve: sofrCurvePayload,
    hw_mean_reversion: HW_MEAN_REVERSION,
    hw_sigma: sigma,
  };
  const fund_predicted = target_funding_with_bias;

  const solveJobs = [_runFundingPy({ ...basePayload, target_funding_spread_bp: fund_predicted }).catch((e) => ({ ok: false, error: e.message }))];
  let fund_aggressive = null, fund_cheap = null;
  if (offsets) {
    fund_aggressive = fund_predicted - offsets.aggressive;
    fund_cheap      = fund_predicted + offsets.cheap;
    solveJobs.push(_runFundingPy({ ...basePayload, target_funding_spread_bp: fund_aggressive }).catch((e) => ({ ok: false, error: e.message })));
    solveJobs.push(_runFundingPy({ ...basePayload, target_funding_spread_bp: fund_cheap      }).catch((e) => ({ ok: false, error: e.message })));
  }
  const [solvedMid, solvedAgg, solvedCheap] = await Promise.all(solveJobs);

  if (!solvedMid || !solvedMid.ok) {
    return { ok: false, errors: [`coupon solver failed: ${solvedMid ? solvedMid.error : 'no result'}`] };
  }
  const couponMid = solvedMid.coupon_pct;
  const couponLow  = Math.round((couponMid - 0.015) * 1000) / 1000;
  const couponHigh = Math.round((couponMid + 0.015) * 1000) / 1000;
  const couponAggressive = (solvedAgg && solvedAgg.ok) ? solvedAgg.coupon_pct : null;
  const couponCheap      = (solvedCheap && solvedCheap.ok) ? solvedCheap.coupon_pct : null;

  // Speed score at the *predicted* funding spread, using post-print signals
  // from comparables when available.
  const sizeForSpeed = input.size_mm ?? 25;
  const speed = speedScore({
    sizeMM: sizeForSpeed,
    structure: input.structure,
    yel,
    fundingPredicted: fund_predicted,
    fundingAvg: comp.avg_funding_spread,
    move: moveUsed,
    comp,
  });

  // Spread label vs UST curve
  const spread = spreadLabel(struct.finalTenorYrs, couponMid, ustCurve);

  // OAS (par) and OAS at cost — optional; use existing oas.js if available.
  // Keep simple: skip for now to keep predictor fast. Can wire later.
  return {
    ok: true,
    inputs: {
      issuer, structure: input.structure, settle_date: settle, yel,
      fees_input: input.fees ?? null,
      target_funding_override: input.target_funding_spread ?? null,
    },
    auto: {
      maturity_date: maturity,
      first_call_date: firstCall,
      final_tenor_years: struct.finalTenorYrs,
      lockout_years:     struct.lockoutYrs,
    },
    prediction: {
      coupon_low:  couponLow,
      coupon_mid:  couponMid,
      coupon_high: couponHigh,
      spread,
      funding_spread: Math.round(target_funding_with_bias * 10) / 10,
      fees_used: fees_bp,
      aggressive_coupon:  couponAggressive,
      aggressive_funding: fund_aggressive != null ? Math.round(fund_aggressive * 10) / 10 : null,
      cheap_coupon:       couponCheap,
      cheap_funding:      fund_cheap != null ? Math.round(fund_cheap * 10) / 10 : null,
      speed_at_predicted: speed.category,
      speed_score:        speed.score,
      tiers_source:       offsets ? `${offsets.signals_n} comparable signals (demand ${offsets.demand_bp >= 0 ? '+' : ''}${offsets.demand_bp} bp)` : 'fill in comparable color to compute',
    },
    reasoning: {
      funding_source,
      fees_source,
      sigma_base_bp:    Math.round(sigmaBase * 10000),
      sigma_used:       Math.round(sigma * 10000),
      move_used:        moveUsed,
      move_scalar:      Math.round(moveScalar * 1000) / 1000,
      bias_correction_bp: Math.round(bias_correction_bp * 100) / 100,
      bias_sample_n:    bias_n,
      speed_factors:    speed.factors,
      offsets:          offsets,  // null if no survey signals yet
      curve_overrides:  overridden,
      curve_date:       curveDate,
      sample_size:      comp.n,
      sample_avg_funding: comp.avg_funding_spread != null ? Math.round(comp.avg_funding_spread * 10) / 10 : null,
      sample_std_funding: comp.std_funding_spread != null ? Math.round(comp.std_funding_spread * 10) / 10 : null,
      sample_avg_fees:    comp.avg_fees != null ? Math.round(comp.avg_fees * 10) / 10 : null,
      yel_delta_bp:       yelStats.delta,
      yel_delta_scope:    yelStats.scope,
      yel_delta_sample:   { n_yel: yelStats.n_yel, n_non: yelStats.n_non },
      yel_mismatched_comparables: comp.n_yel_mismatched,
      yel_fees_adj_bp:    fees_yel_adjustment_bp,
      yel_fees_scope:     yelFeesStats.scope,
      comparables:      comp.rows,
      solver_iterations: solvedMid.iterations,
    },
  };
}

module.exports = {
  predictIndication,
  isBusinessDay,
  nextBusinessDay,
  parseStructure,
};
