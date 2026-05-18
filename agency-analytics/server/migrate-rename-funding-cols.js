#!/usr/bin/env node
// Rename sheet columns: funding_neo → funding, neo_funding_actual → funding_actual
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { SCHEMA } = require('./schema');

const RENAME = {
  funding_neo: 'funding',
  neo_funding_actual: 'funding_actual',
};

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
  const oldHeaders = sheet.headerValues.slice();
  console.log('current headers:', oldHeaders.length);

  // Check whether rename is needed
  const needsRename = oldHeaders.some((h) => RENAME[h] != null);
  if (!needsRename) { console.log('headers already in funding/funding_actual form — nothing to do'); process.exit(0); }

  const rows = await sheet.getRows();
  const data = rows.map((r) => {
    const out = {};
    for (const h of oldHeaders) {
      const newKey = RENAME[h] || h;
      out[newKey] = r.get(h);
    }
    return out;
  });

  const newHeaders = SCHEMA.issues;
  if (sheet.columnCount < newHeaders.length) {
    await sheet.resize({ rowCount: Math.max(sheet.rowCount, 1000), columnCount: newHeaders.length + 2 });
  }
  await sheet.clearRows();
  await sheet.setHeaderRow(newHeaders);
  console.log('new headers set');

  for (let i = 0; i < data.length; i += 100) {
    const chunk = data.slice(i, i + 100).map((row) => {
      const out = {};
      for (const h of newHeaders) out[h] = row[h] != null ? row[h] : '';
      return out;
    });
    await sheet.addRows(chunk);
    console.log(`  ${Math.min(i + 100, data.length)} / ${data.length}`);
  }
  await doc._makeSingleUpdateRequest('sortRange', {
    range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: sheet.rowCount, startColumnIndex: 0, endColumnIndex: newHeaders.length },
    sortSpecs: [
      { dimensionIndex: newHeaders.indexOf('pricing_date'), sortOrder: 'ASCENDING' },
      { dimensionIndex: newHeaders.indexOf('issuer'), sortOrder: 'DESCENDING' },
      { dimensionIndex: newHeaders.indexOf('maturity_date'), sortOrder: 'ASCENDING' },
    ],
  });
  console.log('renamed + resorted');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
