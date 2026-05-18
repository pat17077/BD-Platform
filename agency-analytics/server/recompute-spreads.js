#!/usr/bin/env node
// One-shot: for any issue row with an implausible spread (>200bp) or where
// the row is ≥20yr and `spread` is a single value (missing the /10y portion),
// recompute using today's UST curve as a proxy and overwrite.
// Usage: source .env && node agency-analytics/server/recompute-spreads.js
const path = require('path');
const fetch = require('node-fetch');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const ACTIVE_TENORS = [
  { yrs: 30, key: '30yr' }, { yrs: 20, key: '20yr' }, { yrs: 10, key: '10yr' },
  { yrs: 7,  key: '7yr'  }, { yrs: 5,  key: '5yr'  }, { yrs: 3,  key: '3yr' },
  { yrs: 2,  key: '2yr'  }, { yrs: 1,  key: '1yr'  },
];

function spreadValue(tenorYrs, coupon, curve) {
  const lookup = (k) => curve[k];
  const bp = (cpn, ust) => (isFinite(cpn) && isFinite(ust)) ? Math.round((cpn - ust) * 100) : null;
  const fmt = (val, tenorKey) => val != null ? `${val}/${tenorKey}` : null;
  if (tenorYrs >= 30) {
    return [fmt(bp(coupon, lookup('30yr')), '30yr'),
            fmt(bp(coupon, lookup('20yr')), '20yr'),
            fmt(bp(coupon, lookup('10yr')), '10yr')].filter(Boolean).join(' ') || null;
  }
  if (tenorYrs >= 20) {
    return [fmt(bp(coupon, lookup('20yr')), '20yr'),
            fmt(bp(coupon, lookup('10yr')), '10yr')].filter(Boolean).join(' ') || null;
  }
  for (const a of ACTIVE_TENORS) {
    if (a.yrs <= tenorYrs) {
      const v = bp(coupon, lookup(a.key));
      return v != null ? `${v}/${a.key}` : null;
    }
  }
  return null;
}

(async () => {
  const port = process.env.PORT || 3001;
  const curveApi = await fetch(`http://127.0.0.1:${port}/api/curve`).then((r) => r.json());
  const curve = {};
  for (const [k, v] of Object.entries(curveApi.curve || {})) {
    if (v && typeof v.yield === 'number') curve[k] = v.yield;
  }
  console.log('[recompute] today\'s curve loaded:', Object.keys(curve).length, 'tenors');

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
    const coupon = parseFloat(r.get('coupon'));
    if (!isFinite(coupon)) continue;
    let tenor = null;
    // Try raw_source_json first
    try {
      const raw = JSON.parse(r.get('raw_source_json') || '{}');
      if (raw && typeof raw === 'object' && isFinite(parseFloat(raw.tenorYrs))) {
        tenor = parseFloat(raw.tenorYrs);
      }
    } catch (_) {}
    // Fall back to parsing the structure column ("10yr/6mo" → 10)
    if (tenor == null) {
      const m = String(r.get('structure') || '').match(/^(\d+)\s*yr/i);
      if (m) tenor = parseFloat(m[1]);
    }
    if (!isFinite(tenor)) continue;

    const currentSpread = String(r.get('spread') || '');
    // Always recompute when the format is the old style (no benchmark tag) or value is bogus high.
    const hasBenchmarkTag = /\/(?:\d+(?:mo|yr))/.test(currentSpread);
    const primary = parseFloat(currentSpread.split('/')[0]);
    const isBuggyHigh = isFinite(primary) && Math.abs(primary) > 200;
    if (hasBenchmarkTag && !isBuggyHigh) continue;

    const newSpread = spreadValue(tenor, coupon, curve);
    if (!newSpread || newSpread === currentSpread) continue;
    r.set('spread', newSpread);
    await r.save();
    touched++;
    console.log(`  ${r.get('cusip')}  ${currentSpread} -> ${newSpread}`);
    await new Promise((res) => setTimeout(res, 1100));
  }
  console.log(`[recompute] updated ${touched} rows`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
