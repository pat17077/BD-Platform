#!/usr/bin/env node
// One-shot: backfill s5s30s (30y UST − 5y UST, bp) for every row using the
// UST curve from T-1 of the row's pricing_date. Caches per-date FRED lookups
// to minimise calls (typically ~30-40 unique trade dates across the sheet).
// Usage: source .env && node agency-analytics/server/backfill-s5s30s.js

const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { fetchUstCurveForAuction } = require('./historical-curve');

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

  const curveCache = new Map(); // pricing_date -> { '5yr': y5, '30yr': y30 }
  async function getSpread(date) {
    if (curveCache.has(date)) return curveCache.get(date);
    const res = await fetchUstCurveForAuction(date).catch(() => ({ curve: {} }));
    const y5 = res.curve['5yr']  && res.curve['5yr'].yield;
    const y30 = res.curve['30yr'] && res.curve['30yr'].yield;
    let spreadBp = null;
    if (typeof y5 === 'number' && typeof y30 === 'number') {
      spreadBp = Math.round((y30 - y5) * 100);
    }
    curveCache.set(date, spreadBp);
    return spreadBp;
  }

  let touched = 0;
  for (const r of rows) {
    const pd = r.get('pricing_date');
    if (!pd) continue;
    const spread = await getSpread(pd);
    if (spread == null) continue;
    if (String(r.get('s5s30s')) === String(spread)) continue;
    r.set('s5s30s', spread);
    await r.save();
    touched++;
    if (touched % 10 === 0) console.log(`  progress: ${touched} rows updated`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[s5s30s] backfilled ${touched} rows (${curveCache.size} unique trade dates)`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
