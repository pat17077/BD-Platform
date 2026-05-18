#!/usr/bin/env node
// One-shot: rename columns to short forms and rewrite the issues sheet.
// Mapping:
//   size_mm                    → size
//   fees_bp                    → fees
//   actual_funding_spread_bp   → spread
//   funding_spread_neo         → funding_neo
//   oas_at_par_bp              → oas_par
//   oas_at_cost_bp             → oas_cost
//   s2s30s_at_auction_bp       → s5s30s
//   yel_designation            → yel
//   move_prior_close           → move
//   spread_to_ct_treasury_bp   → (dropped)
// Usage: source .env && node agency-analytics/server/migrate-rename-columns.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { SCHEMA } = require('./schema');

const RENAME = {
  size_mm: 'size',
  fees_bp: 'fees',
  actual_funding_spread_bp: 'spread',
  funding_spread_neo: 'funding_neo',
  oas_at_par_bp: 'oas_par',
  oas_at_cost_bp: 'oas_cost',
  s2s30s_at_auction_bp: 's5s30s',
  yel_designation: 'yel',
  move_prior_close: 'move',
};
const DROP = new Set(['spread_to_ct_treasury_bp']);

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
  console.log(`[rename] old cols: ${oldHeaders.length} → new cols: ${newHeaders.length}`);

  const rows = await sheet.getRows();
  console.log(`[rename] reading ${rows.length} rows...`);
  const data = rows.map((r) => {
    const old = {};
    for (const h of oldHeaders) old[h] = r.get(h);
    const out = {};
    for (const [k, v] of Object.entries(old)) {
      if (DROP.has(k)) continue;
      const newKey = RENAME[k] || k;
      out[newKey] = v;
    }
    return out;
  });

  if (sheet.columnCount < newHeaders.length) {
    await sheet.resize({ rowCount: Math.max(sheet.rowCount, 1000), columnCount: newHeaders.length + 2 });
  }
  await sheet.clearRows();
  await sheet.setHeaderRow(newHeaders);
  console.log('[rename] new header set');

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

  await doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1, endRowIndex: sheet.rowCount,
      startColumnIndex: 0, endColumnIndex: newHeaders.length,
    },
    sortSpecs: [{ dimensionIndex: newHeaders.indexOf('pricing_date'), sortOrder: 'ASCENDING' }],
  });
  console.log(`[rename] done — ${data.length} rows migrated to short column names`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
