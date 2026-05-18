// Hull-White short-rate volatility (σ), calibrated per final-maturity tenor.
//
// HW is single-factor, so σ is constant for any given bond — but we pick a
// different σ depending on the bond's tenor. That gives us a coarse vol term
// structure without needing GeneralizedHullWhite.
//
// Calibrated against 10 UBS Neo prints (trade dates 2026-05-07/11/12), T-1
// discount curves from FRED. Residuals after this table:
//   5y -1.6, 7y +0.1, 8y -2.9, 10y -6.9 (→ σ 92→88), 15y -6.9 (→ σ 90→85),
//   20y -1.6. Adjustments listed below.

const HW_SIGMA_BY_TENOR = [
  { tenor_years: 1,  sigma: 0.0094 },
  { tenor_years: 2,  sigma: 0.0094 },
  { tenor_years: 3,  sigma: 0.0094 },
  { tenor_years: 5,  sigma: 0.0094 },
  { tenor_years: 7,  sigma: 0.0094 },
  { tenor_years: 8,  sigma: 0.0093 },
  { tenor_years: 10, sigma: 0.0088 },
  { tenor_years: 15, sigma: 0.0085 },
  { tenor_years: 20, sigma: 0.0084 },
  { tenor_years: 30, sigma: 0.0084 },
];

const HW_MEAN_REVERSION = 0.03;

function sigmaForTenor(tenorYears) {
  if (tenorYears == null || !isFinite(tenorYears)) return HW_SIGMA_BY_TENOR[HW_SIGMA_BY_TENOR.length - 1].sigma;
  if (tenorYears <= HW_SIGMA_BY_TENOR[0].tenor_years) return HW_SIGMA_BY_TENOR[0].sigma;
  if (tenorYears >= HW_SIGMA_BY_TENOR[HW_SIGMA_BY_TENOR.length - 1].tenor_years) {
    return HW_SIGMA_BY_TENOR[HW_SIGMA_BY_TENOR.length - 1].sigma;
  }
  for (let i = 0; i < HW_SIGMA_BY_TENOR.length - 1; i++) {
    const a = HW_SIGMA_BY_TENOR[i];
    const b = HW_SIGMA_BY_TENOR[i + 1];
    if (tenorYears >= a.tenor_years && tenorYears <= b.tenor_years) {
      const w = (tenorYears - a.tenor_years) / (b.tenor_years - a.tenor_years);
      return a.sigma * (1 - w) + b.sigma * w;
    }
  }
  return HW_SIGMA_BY_TENOR[HW_SIGMA_BY_TENOR.length - 1].sigma;
}

module.exports = { sigmaForTenor, HW_SIGMA_BY_TENOR, HW_MEAN_REVERSION };
