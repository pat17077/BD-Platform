#!/usr/bin/env node
// One-shot: undo DNT marks on rows that are actually floaters (or otherwise
// legitimately have no numeric coupon but did trade). Detection: parse the
// raw_source_json for a `floater` field or Floater in the `type` field.
// Usage: source .env && node agency-analytics/server/fix-false-dnt.js
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
  let fixed = 0;
  for (const r of rows) {
    if (r.get('fees_bp') !== 'DNT') continue;
    let raw = {};
    try { raw = JSON.parse(r.get('raw_source_json') || '{}'); } catch (_) {}
    const isFloater = !!raw.floater || /floater/i.test(raw.type || '');
    if (isFloater) {
      r.set('fees_bp', '');
      await r.save();
      fixed++;
      console.log(`  ${r.get('cusip')}: DNT -> '' (floater)`);
      await new Promise((res) => setTimeout(res, 1100));
    }
  }
  console.log(`[fix-dnt] reverted ${fixed} false DNTs`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
