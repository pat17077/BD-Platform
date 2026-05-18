#!/usr/bin/env node
// One-shot: physically reorder the `issues` sheet columns to match the new
// schema order (Cusip, pricing_date, issuer, structure, size, coupon, fees,
// spread, funding_neo, oas_par, oas_cost, 5s30s, yel, settle, move, ...rest).
//
// Strategy: read all rows as name-keyed objects, clear the sheet, write the
// new header row, then bulk-write all rows back via addRows (1 API call).
// Server must be running (we read from the in-memory cache to avoid the
// per-row Sheets read quota).
// Usage: source .env && node agency-analytics/server/migrate-reorder-columns.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { SCHEMA } = require('./schema');

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
  await sheet.loadHeaderRow();
  const oldHeaders = sheet.headerValues.slice();
  const newHeaders = SCHEMA.issues;

  console.log(`[reorder] current cols: ${oldHeaders.length}, target cols: ${newHeaders.length}`);

  // Read all rows as name-keyed objects (BEFORE we mutate the sheet)
  const rows = await sheet.getRows();
  console.log(`[reorder] reading ${rows.length} rows...`);
  const data = rows.map((r) => {
    const o = {};
    for (const h of oldHeaders) o[h] = r.get(h);
    return o;
  });

  // Make sure the sheet has enough columns for the new header set
  if (sheet.columnCount < newHeaders.length) {
    await sheet.resize({ rowCount: Math.max(sheet.rowCount, 1000), columnCount: newHeaders.length + 2 });
  }

  // Clear all rows (including the data — leaves header row)
  await sheet.clearRows();
  console.log('[reorder] cleared data rows');

  // Set new header row
  await sheet.setHeaderRow(newHeaders);
  console.log('[reorder] new header set');

  // Re-write all rows in chunks of 100 via addRows (bulk insert)
  const chunkSize = 100;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize).map((row) => {
      const out = {};
      for (const h of newHeaders) out[h] = row[h] != null ? row[h] : '';
      return out;
    });
    await sheet.addRows(chunk);
    console.log(`  wrote ${Math.min(i + chunkSize, data.length)} / ${data.length}`);
  }

  // Resort by pricing_date ascending so layout matches existing behavior
  await doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: 0,
      endColumnIndex: newHeaders.length,
    },
    sortSpecs: [{ dimensionIndex: newHeaders.indexOf('pricing_date'), sortOrder: 'ASCENDING' }],
  });
  console.log('[reorder] resorted by pricing_date');

  console.log(`[reorder] done — ${data.length} rows now in new column order`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
