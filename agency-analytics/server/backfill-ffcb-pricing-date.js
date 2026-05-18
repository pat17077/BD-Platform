#!/usr/bin/env node
// One-shot: for FFCB rows where pricing_date == settle_date, approximate
// pricing_date as settle_date − 1 business day (T-1 convention for FFCB
// benchmark callables, since FFCB's public feed doesn't publish trade dates).
// Usage: source .env && node agency-analytics/server/backfill-ffcb-pricing-date.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

function minusBusinessDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d)) return iso;
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); // skip Sat (6) & Sun (0)
  return d.toISOString().slice(0, 10);
}

(async () => {
  const sa = require(path.resolve(process.env.AGENCY_SERVICE_ACCOUNT_PATH));
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.AGENCY_SHEET_ID, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['issues'];
  const rows = await sheet.getRows();
  let touched = 0;
  for (const r of rows) {
    const issuer = r.get('issuer');
    const pd = r.get('pricing_date');
    const sd = r.get('settle_date');
    if (issuer !== 'FFCB') continue;
    if (!pd || !sd || pd !== sd) continue;
    const newPd = minusBusinessDay(sd);
    if (newPd === pd) continue;
    r.set('pricing_date', newPd);
    await r.save();
    touched++;
    console.log(`  ${r.get('cusip')}: ${pd} -> ${newPd}`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[backfill] updated ${touched} FFCB rows`);

  // Re-sort
  await doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: 0,
      endColumnIndex: 27,
    },
    sortSpecs: [{ dimensionIndex: 2, sortOrder: 'ASCENDING' }],
  });
  console.log('[backfill] resorted by pricing_date');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
