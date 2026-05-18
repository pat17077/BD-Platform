#!/usr/bin/env node
// One-shot: re-shape existing issue rows.
//   - Structure column → "Xyr/Ymo" or "Xyr/Yyr" notation
//   - Size column → divide by 1e6, write in MM
//   - move_prior_close → MOVE close on the latest weekday strictly before pricing_date
//   - FFCB pricing_date reset: if settle in the past use settle_date as pricing_date,
//     if settle in the future use today (we just observed it). Reverts T-1 backfill.
//   - Rename column header size_dollars → size_mm
// Run AFTER killing the server (to free the Sheets quota).
// Usage: source .env && node agency-analytics/server/migrate-rows-v2.js
const path = require('path');
const fetch = require('node-fetch');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

function _today() { return new Date().toISOString().slice(0, 10); }

function _structureNotation(item) {
  const tenor = item.tenorYrs;
  const firstCall = (item.callSchedule && item.callSchedule[0] &&
    (item.callSchedule[0].startDate || item.callSchedule[0].nextCall)) || null;
  const issued = item.issued || item.issueDate;
  if (tenor == null || !firstCall || !issued) {
    return item.callStructure || item.type || (item.callable ? 'callable' : 'bullet');
  }
  const fc = new Date(firstCall + 'T00:00:00Z');
  const iss = new Date(issued + 'T00:00:00Z');
  if (isNaN(fc) || isNaN(iss)) return item.callStructure || 'callable';
  const months = (fc.getUTCFullYear() - iss.getUTCFullYear()) * 12
                + (fc.getUTCMonth() - iss.getUTCMonth());
  const finalYr = Math.round(tenor);
  if (months < 12) return `${finalYr}yr/${months}mo`;
  return `${finalYr}yr/${Math.round(months / 12)}yr`;
}

function _priorMoveClose(series, pricingDate) {
  if (!Array.isArray(series) || !series.length || !pricingDate) return null;
  let best = null;
  for (const p of series) {
    if (p && p.date && p.date < pricingDate && typeof p.value === 'number') {
      if (best == null || p.date > best.date) best = p;
    }
  }
  return best ? best.value : null;
}

(async () => {
  // 1. Pull MOVE 1y history (requires the server NOT to be running, or use the
  //    live API. We use Yahoo directly via the existing server's endpoint if
  //    up; otherwise instruct the user to start the server first.)
  let moveSeries = [];
  try {
    const port = process.env.PORT || 3001;
    const r = await fetch(`http://127.0.0.1:${port}/api/public/move/history`, { timeout: 15000 });
    if (r.ok) {
      const j = await r.json();
      moveSeries = (j && Array.isArray(j.series)) ? j.series : [];
    } else {
      console.error(`MOVE fetch HTTP ${r.status}`);
    }
  } catch (e) { console.error('MOVE fetch err:', e.message); }
  if (!moveSeries.length) {
    console.error('FATAL: server is not running. Start it first (./start.sh) so we can fetch MOVE history.');
    process.exit(2);
  }
  console.log(`[migrate] MOVE series: ${moveSeries.length} entries (${moveSeries[0].date} → ${moveSeries[moveSeries.length-1].date})`);

  // 2. Connect to sheet
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
  const headers = sheet.headerValues;
  console.log('[migrate] current headers:', headers.slice(0, 12).join(', '), '...');

  const sizeHeader = headers.includes('size_mm') ? 'size_mm' : 'size_dollars';
  const rows = await sheet.getRows();
  const today = _today();
  let touched = 0;

  for (const r of rows) {
    let raw = {};
    try { raw = JSON.parse(r.get('raw_source_json') || '{}'); } catch (_) {}

    const issuer = r.get('issuer');
    const settle = r.get('settle_date');

    // pricing_date reset (FFCB only — FHLB has true trade date from source)
    let newPricing = r.get('pricing_date');
    if (issuer === 'FFCB' && settle) {
      newPricing = settle > today ? today : settle;
    }

    // structure
    const newStruct = _structureNotation(raw);

    // size: parse current value; if > 1000 assume it's dollars not MM yet
    const sizeRaw = parseFloat(r.get(sizeHeader));
    let newSize = sizeRaw;
    if (isFinite(sizeRaw) && sizeRaw > 1000) newSize = sizeRaw / 1e6;

    // MOVE: prior close before pricing_date
    const newMove = _priorMoveClose(moveSeries, newPricing);

    const before = {
      pricing_date: r.get('pricing_date'),
      structure: r.get('structure'),
      size: r.get(sizeHeader),
      move: r.get('move_prior_close'),
    };
    const after = {
      pricing_date: newPricing,
      structure: newStruct,
      size: newSize,
      move: newMove,
    };

    let dirty = false;
    if (newPricing && newPricing !== before.pricing_date) { r.set('pricing_date', newPricing); dirty = true; }
    if (newStruct && newStruct !== before.structure) { r.set('structure', newStruct); dirty = true; }
    if (isFinite(newSize) && String(newSize) !== before.size) { r.set(sizeHeader, newSize); dirty = true; }
    if (newMove != null && String(newMove) !== before.move) { r.set('move_prior_close', newMove); dirty = true; }

    if (dirty) {
      await r.save();
      touched++;
      console.log(`  ${r.get('cusip')}: pd ${before.pricing_date}→${after.pricing_date}, struct ${before.structure}→${after.structure}, size ${before.size}→${after.size}, move ${before.move||'-'}→${after.move}`);
      await new Promise((res) => setTimeout(res, 1100));
    }
  }
  console.log(`[migrate] updated ${touched} rows`);

  // 3. Rename header size_dollars → size_mm (if not already)
  if (sizeHeader === 'size_dollars') {
    const newHeaders = headers.map((h) => h === 'size_dollars' ? 'size_mm' : h);
    await sheet.setHeaderRow(newHeaders);
    console.log('[migrate] header renamed: size_dollars → size_mm');
  }

  // 4. Resort
  await doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: 0,
      endColumnIndex: 27,
    },
    sortSpecs: [{ dimensionIndex: 2, sortOrder: 'ASCENDING' }],
  });
  console.log('[migrate] resorted by pricing_date');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
