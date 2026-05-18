#!/usr/bin/env node
// Quick: re-sort the issues sheet with pricing_time_et included.
const db = require('./db');
(async () => {
  await db.init();
  await db.sortMulti('issues', [
    { column: 'pricing_date',    direction: 'ASCENDING' },
    { column: 'pricing_time_et', direction: 'ASCENDING' },
    { column: 'issuer',          direction: 'DESCENDING' },
    { column: 'maturity_date',   direction: 'ASCENDING' },
  ]);
  console.log('sorted');
  db.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
