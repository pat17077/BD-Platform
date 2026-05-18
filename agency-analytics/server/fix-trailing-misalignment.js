#!/usr/bin/env node
// One-shot: fix shifted trailing-column data on the issues sheet.
// Earlier migrations shifted some values out of place — URLs ended up in `yel`,
// raw JSON in `ann_to_pricing_minutes`, timestamps in `source_url`, etc.
// Heuristics:
//   - yel must be 'Y' / 'N' / ''. Anything else (URL, etc.) → clear.
//   - If a known column holds the wrong type of value, blank it.
// We do NOT try to re-place values (we don't know which row's URL goes where);
// we just clear obviously wrong data so the columns reflect the truth.

const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const URL_RE  = /^https?:\/\//;
const JSON_RE = /^\s*[{[]/;
const ISO_RE  = /^\d{4}-\d{2}-\d{2}T/;

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
    let dirty = false;
    // yel should be Y/N/empty
    const y = String(r.get('yel') || '').trim();
    if (y && y !== 'Y' && y !== 'N') {
      r.set('yel', '');
      dirty = true;
    }
    // funding_actual should be numeric or "s/fees" — clear if it's neither
    const fa = String(r.get('funding_actual') || '').trim();
    if (fa && isNaN(parseFloat(fa)) && !/^[-\d.]+\/[-\d.]+$/.test(fa)) {
      r.set('funding_actual', '');
      dirty = true;
    } else if (fa && parseFloat(fa) > 90 && !fa.includes('/')) {
      // Single-number values like "96.05" are old leftover spreads, not funding spreads
      r.set('funding_actual', '');
      dirty = true;
    }
    // ann_to_pricing_minutes should be integer minutes; if it contains JSON, clear
    const apm = String(r.get('ann_to_pricing_minutes') || '');
    if (apm && JSON_RE.test(apm)) {
      r.set('ann_to_pricing_minutes', '');
      dirty = true;
    }
    // upsize_status should be Y/N/empty; if it's a classification, clear
    const us = String(r.get('upsize_status') || '');
    if (us === 'public' || us === 'internal') {
      r.set('upsize_status', '');
      dirty = true;
    }
    // source_url should be URL; if it's a timestamp, clear
    const su = String(r.get('source_url') || '');
    if (su && ISO_RE.test(su)) {
      r.set('source_url', '');
      dirty = true;
    }
    // raw_source_json should be JSON; if it's a single digit, clear
    const rsj = String(r.get('raw_source_json') || '');
    if (rsj && rsj.length < 5 && !JSON_RE.test(rsj)) {
      r.set('raw_source_json', '');
      dirty = true;
    }
    if (dirty) {
      await r.save();
      touched++;
      if (touched % 10 === 0) console.log(`  ${touched} rows cleaned`);
      await new Promise((res) => setTimeout(res, 1100));
    }
  }
  console.log(`[fix-alignment] cleared misplaced values on ${touched} rows`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
