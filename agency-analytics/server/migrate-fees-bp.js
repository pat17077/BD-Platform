#!/usr/bin/env node
// One-shot: convert fees_dollars column → fees_bp (concession in bps per bond).
//   bps = fees_dollars / (size_mm × 100)
// For rows with no coupon → mark "DNT".
// Also renames the column header from fees_dollars to fees_bp.
// Usage: source .env && node agency-analytics/server/migrate-fees-bp.js

const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

(async () => {
  const sa = require(path.resolve(process.env.AGENCY_SERVICE_ACCOUNT_PATH));
  const jwt = new JWT({
    email: sa.client_email, key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.AGENCY_SHEET_ID, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['issues'];
  await sheet.loadHeaderRow();
  const headers = sheet.headerValues.slice();
  const oldHeader = 'fees_dollars';
  const newHeader = 'fees_bp';
  const colName = headers.includes(newHeader) ? newHeader : oldHeader;

  const rows = await sheet.getRows();
  let touched = 0;
  for (const r of rows) {
    const cur = r.get(colName);
    const sizeMM = parseFloat(r.get('size_mm'));
    const coupon = parseFloat(r.get('coupon'));
    let nextVal;
    if (!isFinite(coupon)) {
      nextVal = 'DNT';
    } else if (colName === oldHeader) {
      // current value is dollars on par face; convert to bps
      const dollars = parseFloat(cur);
      if (!isFinite(dollars) || !isFinite(sizeMM) || sizeMM <= 0) {
        nextVal = '';
      } else {
        nextVal = Math.round((dollars / (sizeMM * 100)) * 10) / 10;
      }
    } else {
      // already in bps — only re-stamp if it parses oddly
      const v = parseFloat(cur);
      if (cur === 'DNT' || isFinite(v) || cur === '') continue;
      nextVal = '';
    }
    if (String(nextVal) === String(cur)) continue;
    r.set(colName, nextVal);
    await r.save();
    touched++;
    console.log(`  ${r.get('cusip')}  ${cur || '-'} -> ${nextVal}`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[fees-bp] updated ${touched} rows`);

  // Rename header
  if (colName === oldHeader) {
    const newHeaders = headers.map((h) => h === oldHeader ? newHeader : h);
    await sheet.setHeaderRow(newHeaders);
    console.log('[fees-bp] header renamed: fees_dollars → fees_bp');
  }
  // Re-sort just in case
  await doc._makeSingleUpdateRequest('sortRange', {
    range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: sheet.rowCount, startColumnIndex: 0, endColumnIndex: 27 },
    sortSpecs: [{ dimensionIndex: 2, sortOrder: 'ASCENDING' }],
  });
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
