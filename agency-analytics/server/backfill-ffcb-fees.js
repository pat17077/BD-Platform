#!/usr/bin/env node
// One-shot: fill FFCB fees for every FFCB row missing them, using the
// standardized tenor table. Tenor is parsed from the structure column
// (e.g., "10yr/6mo" → 10). Skips floaters (rows with no coupon → DNT? no:
// floaters have no fixed coupon but ARE FFCB issues — still apply standard
// fees per tenor).
// Usage: source .env && node agency-analytics/server/backfill-ffcb-fees.js

const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { ffcbFeesForTenor } = require('./ffcb-fees');

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
  let touched = 0;
  for (const r of rows) {
    if (r.get('issuer') !== 'FFCB') continue;
    const cur = String(r.get('fees') || '').trim();
    if (cur !== '' && cur !== '0' && cur !== 'DNT') continue; // already filled
    const m = String(r.get('structure') || '').match(/^(\d+)\s*yr/i);
    if (!m) continue;
    const tenor = parseFloat(m[1]);
    const fee = ffcbFeesForTenor(tenor);
    if (fee == null) continue;
    r.set('fees', fee);
    await r.save();
    touched++;
    console.log(`  ${r.get('cusip')}  ${r.get('structure')}  fees → ${fee}`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[ffcb-fees] updated ${touched} FFCB rows`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
