// SOFR curve builder.
//
// We don't have direct access to SOFR swap mids on FRED. Approach:
//   - Anchor at FRED's overnight SOFR (already cached server-side as part of
//     the existing economic-indicators feed).
//   - For longer tenors, take the UST curve and subtract a per-tenor SOFR-UST
//     basis (typical: 2-5 bp at 1y, 6-10 bp at 5-7y, 10-15 bp at 10y+).
//   - Basis values are configurable via the constants below — recalibrate
//     them whenever we sample a few UBS Neo prints to lock our spreads to
//     within ~1 bp of Neo's.
//
// Future improvement: pull ICE SOFR Swap Rate daily CSV
// (https://www.theice.com/marketdata/reports/180) and use those mids directly.

// SOFR/FHLMC-equivalent discount basis vs UST (bps). Positive = curve < UST.
// Starting values reflect typical SOFR-UST swap spreads; recalibrate when we
// have UBS Neo prints to compare against.
const SOFR_UST_BASIS_BP = {
  0.0833: 0,   // 1mo  — SOFR ≈ T-bill at the short end
  0.25:   0,   // 3mo
  0.5:    2,
  1:      3,
  2:      5,
  3:      7,
  5:      9,
  7:     11,
  10:    13,
  20:    14,
  30:    15,
};

function _interpBasis(tenorYrs) {
  const points = Object.keys(SOFR_UST_BASIS_BP).map(parseFloat).sort((a, b) => a - b);
  if (tenorYrs <= points[0]) return SOFR_UST_BASIS_BP[points[0]];
  if (tenorYrs >= points[points.length - 1]) return SOFR_UST_BASIS_BP[points[points.length - 1]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]; const b = points[i + 1];
    if (tenorYrs >= a && tenorYrs <= b) {
      const w = (tenorYrs - a) / (b - a);
      return SOFR_UST_BASIS_BP[a] * (1 - w) + SOFR_UST_BASIS_BP[b] * w;
    }
  }
  return 10;
}

const UST_TENOR_YEARS = {
  '1mo': 1/12, '3mo': 0.25, '6mo': 0.5,
  // /api/curve uses the 'Xyr' form (not 'Xy') — match that.
  '1yr': 1, '2yr': 2, '3yr': 3, '5yr': 5,
  '7yr': 7, '10yr': 10, '20yr': 20, '30yr': 30,
};

/**
 * Build the SOFR discount curve.
 *
 * @param {{curve: Record<string,{yield:number}>}} ustCurveApi — `/api/curve` shape
 * @param {number|null} sofrOvernight — FRED SOFR overnight (in % terms)
 * @returns {Array<{tenor_years:number, yield_pct:number}>}
 */
function buildSofrCurve(ustCurveApi, sofrOvernight) {
  if (!ustCurveApi || !ustCurveApi.curve) return [];
  const out = [];
  // Anchor at SOFR overnight if available, else 1mo UST as a fallback
  const anchor = (typeof sofrOvernight === 'number' && isFinite(sofrOvernight))
    ? sofrOvernight
    : (ustCurveApi.curve['1mo'] && ustCurveApi.curve['1mo'].yield) || null;
  if (anchor != null) {
    out.push({ tenor_years: 1/365, yield_pct: anchor });
  }
  for (const [tenor, data] of Object.entries(ustCurveApi.curve)) {
    const yrs = UST_TENOR_YEARS[tenor];
    if (yrs == null || !data || typeof data.yield !== 'number') continue;
    const basis = _interpBasis(yrs);
    out.push({ tenor_years: yrs, yield_pct: data.yield - basis / 100.0 });
  }
  return out.sort((a, b) => a.tenor_years - b.tenor_years);
}

module.exports = { buildSofrCurve, SOFR_UST_BASIS_BP };
