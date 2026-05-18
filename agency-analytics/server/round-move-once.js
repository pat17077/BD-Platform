#!/usr/bin/env node
// One-shot: round move_prior_close on existing issue rows to 2 decimals.
// Usage: source .env && node agency-analytics/server/round-move-once.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
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
    const v = parseFloat(r.get('move_prior_close'));
    if (!isFinite(v)) continue;
    const rounded = Math.round(v * 100) / 100;
    if (String(rounded) === r.get('move_prior_close')) continue;
    r.set('move_prior_close', rounded);
    await r.save();
    touched++;
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[round-move] updated ${touched} rows`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
