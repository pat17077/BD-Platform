#!/usr/bin/env node
// One-shot: delete FHLB rows that didn't come from the FHLB Auction Results
// page (CBR) or the Callable Bond Auction History page. Detection:
//   - source_url doesn't reference auction-results-51 or callable-bond-auction-history
//   - OR fees is empty (true auction results always have a concession)
// Usage: source .env && node agency-analytics/server/cleanup-non-auction-fhlb.js
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

function isAuctionSource(url) {
  if (!url) return false;
  return /auction-results-51|callable-bond-auction-history/i.test(String(url));
}

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
    if (r.get('issuer') !== 'FHLB') continue;
    const url = r.get('source_url');
    const fees = String(r.get('fees') || '').trim();
    // delete if not from the auction sources AND fees is missing
    if (!isAuctionSource(url) && (fees === '' || fees === '0')) {
      toDelete.push(r);
    }
  }
  console.log(`[cleanup-non-auction-fhlb] found ${toDelete.length} rows to delete`);
  toDelete.sort((a, b) => b.rowNumber - a.rowNumber);
  for (const r of toDelete) {
    const c = r.get('cusip'); const s = r.get('structure'); const p = r.get('pricing_date');
    await r.delete();
    console.log(`  deleted ${c}  ${s}  ${p}`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log('[cleanup-non-auction-fhlb] done');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
