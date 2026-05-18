#!/usr/bin/env node
// One-shot: restore today's missing/lost user-entered data.
//   1) Re-insert FHLB 20yr/1yr 5.75% YEL R1 placeholder (was lost to cross-day reconcile)
//   2) Merge 15yr/1yr placeholder -> 3130BARA7, delete placeholder (settle mismatch blocked auto-reconcile)
//   3) Restore user fields on 3130BAR90 10yr/5yr R2 (placeholder gone, only CBR auto-data remains)
const db = require('./db');

(async () => {
  await db.init();

  // ── 1. Re-insert FHLB 20yr/1yr 5.75% YEL R1 placeholder ────────────────
  const row20yr1yr = {
    cusip: 'PENDING-FHLB-20260513-20yr1yr-5.75',
    pricing_date: '2026-05-13',
    issuer: 'FHLB',
    structure: '20yr/1yr',
    size: 35,
    coupon: 5.75,
    fees: 9,
    spread: '81/20yr 126/10yr',
    funding: '36.2/9.09',
    oas_par: -21,
    oas_cost: -19,
    s5s30s: 90.8,
    yel: 'Y',
    settle_date: '2026-05-21',
    move: 71.68,
    maturity_date: '2046-05-21',
    pricing_time_et: '10:30',
    desk_notes: '',
    upsize_status: '',
    entered_by: 'Pat',
    data_classification: 'internal',
    ingested_at: new Date().toISOString(),
    version: 1,
  };
  await db.upsertRow('issues', row20yr1yr);
  console.log('  [1] inserted PENDING-FHLB-20260513-20yr1yr-5.75');

  // ── 2. Merge 15yr/1yr placeholder -> 3130BARA7, delete placeholder ────
  const real15yr1yr = db.getRows('issues').find((r) => r.cusip === '3130BARA7');
  if (!real15yr1yr) throw new Error('3130BARA7 not found');
  const merged15yr1yr = {
    ...real15yr1yr,
    spread:               '101/10yr',
    funding:              '36.5/29.5',
    oas_par:              -17,
    oas_cost:             -9,
    s5s30s:               90,
    yel:                  'Y',
    pricing_time_et:      '10:55',
    move:                 71.68,
    entered_by:           'Pat',
    data_classification:  'internal',
  };
  await db.upsertRow('issues', merged15yr1yr);
  await db.deleteWhere('issues', (r) => r.cusip === 'PENDING-FHLB-20260513-15yr1yr-5.5');
  console.log('  [2] merged 15yr/1yr placeholder -> 3130BARA7 (placeholder deleted)');

  // ── 3. Restore user fields on 3130BAR90 (10yr/5yr R2) ─────────────────
  const real10yr5yr = db.getRows('issues').find((r) => r.cusip === '3130BAR90');
  if (!real10yr5yr) throw new Error('3130BAR90 not found');
  const merged10yr5yr = {
    ...real10yr5yr,
    spread:               '15/10yr',
    funding:              '23/29.97',
    oas_par:              -12,
    oas_cost:             -7,
    s5s30s:               90,
    pricing_time_et:      '10:55',
    move:                 71.68,
    entered_by:           'Pat',
    data_classification:  'internal',
  };
  await db.upsertRow('issues', merged10yr5yr);
  console.log('  [3] restored user fields on 3130BAR90');

  // ── 4. Re-sort ─────────────────────────────────────────────────────────
  await db.sortMulti('issues', [
    { column: 'pricing_date',    direction: 'ASCENDING' },
    { column: 'pricing_time_et', direction: 'ASCENDING' },
    { column: 'issuer',          direction: 'DESCENDING' },
    { column: 'maturity_date',   direction: 'ASCENDING' },
  ]);
  console.log('  [4] sorted');

  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
