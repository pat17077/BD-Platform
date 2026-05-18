#!/usr/bin/env node
// One-shot: remove non-callable rows from the issues sheet.
// Usage: source .env && node agency-analytics/server/cleanup-noncallable.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

function _looksCallable(row) {
  const struct = (row.get('structure') || '').toString();
  if (/NC\d/i.test(struct)) return true;
  const raw = (row.get('raw_source_json') || '').toString();
  if (/"callable"\s*:\s*true/i.test(raw)) return true;
  if (/Agency Callable/i.test(raw)) return true;
  return false;
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
  if (!sheet) throw new Error('issues sheet missing');
  const rows = await sheet.getRows();
  let kept = 0;
  let toDelete = [];
  for (const r of rows) {
    if (_looksCallable(r)) kept++;
    else toDelete.push(r);
  }
  console.log(`[cleanup] keeping ${kept} callable, deleting ${toDelete.length} non-callable`);
  // Delete from the bottom up so row indices stay valid
  toDelete.sort((a, b) => b.rowNumber - a.rowNumber);
  for (const r of toDelete) {
    const cusip = r.get('cusip');
    await r.delete();
    console.log(`  deleted ${cusip}`);
    await new Promise((res) => setTimeout(res, 1100)); // stay under quota
  }
  console.log('[cleanup] done');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
