// FFCB has a standardized dealer-fee schedule by final-maturity tenor (FHLB
// fees are bid). User-provided table:
//   1yr=3.5, 2yr=12.5, 3yr=15, 4yr=17.5, 5yr=20, 6yr=22.5, 7yr=25, 8yr=27.5,
//   9yr+=30. 30yr is "higher" — TBD until we get an exact number.
// Tenor floor-rounds (e.g., 6.5yr→6yr, 5.5yr→5yr).

const FFCB_FEES_BP = {
  1:  3.5,
  2: 12.5,
  3: 15,
  4: 17.5,
  5: 20,
  6: 22.5,
  7: 25,
  8: 27.5,
};
const FFCB_FEES_9PLUS_BP = 30;
const FFCB_FEES_30YR_BP  = 30; // TODO: confirm the exact 30yr fee with the user

function ffcbFeesForTenor(tenorYrs) {
  if (!isFinite(tenorYrs) || tenorYrs <= 0) return null;
  const floor = Math.floor(tenorYrs);
  if (floor >= 30) return FFCB_FEES_30YR_BP;
  if (floor >= 9)  return FFCB_FEES_9PLUS_BP;
  return FFCB_FEES_BP[floor] != null ? FFCB_FEES_BP[floor] : null;
}

module.exports = { ffcbFeesForTenor, FFCB_FEES_BP, FFCB_FEES_9PLUS_BP, FFCB_FEES_30YR_BP };
