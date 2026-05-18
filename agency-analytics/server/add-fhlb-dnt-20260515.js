#!/usr/bin/env node
// One-shot: record Friday's FHLB 15yr/6mo DNT (did-not-trade).
const db = require('./db');

(async () => {
  await db.init();
  const settle = '2026-05-20';
  const row = {
    cusip: 'PENDING-FHLB-20260515-15yr6mo-DNT',
    pricing_date: '2026-05-15',
    issuer: 'FHLB',
    structure: '15yr/6mo',
    size: 15,
    coupon: '',                  // DNT
    fees: 'DNT',
    spread: '',
    funding: '',
    yel: 'Y',
    yel_effective_date: '2026-05-20',
    settle_date: settle,
    maturity_date: '2041-05-20',  // settle + 15y
    first_call_date: '2026-11-20', // settle + 6mo
    s5s30s: 87.7,
    move: 69.63,
    entered_by: 'Pat',
    data_classification: 'internal',
    ingested_at: new Date().toISOString(),
    version: 1,
    desk_notes: 'DNT — did not trade',
  };
  await db.upsertRow('issues', row);
  console.log('  inserted DNT row:', row.cusip);

  await db.sortMulti('issues', [
    { column: 'pricing_date',    direction: 'ASCENDING' },
    { column: 'issuer',          direction: 'DESCENDING' },
    { column: 'pricing_time_et', direction: 'ASCENDING' },
    { column: 'maturity_date',   direction: 'ASCENDING' },
  ]);
  console.log('  sorted');

  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
