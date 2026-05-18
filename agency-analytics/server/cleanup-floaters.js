#!/usr/bin/env node
// One-shot: delete floater rows from the issues sheet.
// Detection: coupon empty AND raw_source_json signals floater (type "Agency
// Floater" or has a `floater` field).
// Usage: source .env && node agency-analytics/server/cleanup-floaters.js
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
  const rows = await sheet.getRows();
  const toDelete = [];
  for (const r of rows) {
    const coupon = String(r.get('coupon') || '').trim();
    if (coupon !== '') continue;  // has fixed coupon → keep
    const raw = String(r.get('raw_source_json') || '');
    if (/floater/i.test(raw) || /"floater"\s*:/i.test(raw)) {
      toDelete.push(r);
    }
  }
  console.log(`[cleanup-floaters] found ${toDelete.length} floater rows`);
  toDelete.sort((a, b) => b.rowNumber - a.rowNumber);
  for (const r of toDelete) {
    const c = r.get('cusip'); const s = r.get('structure');
    await r.delete();
    console.log(`  deleted ${c} (${s})`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log('[cleanup-floaters] done');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
