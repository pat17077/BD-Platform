#!/usr/bin/env node
const db = require('./db');
(async () => {
  await db.init();
  await db.sortMulti('issues', [
    { column: 'pricing_date', direction: 'ASCENDING' },
    { column: 'issuer',       direction: 'DESCENDING' },
    { column: 'maturity_date',direction: 'ASCENDING' },
  ]);
  console.log('sorted');
  db.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
