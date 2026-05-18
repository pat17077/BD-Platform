#!/usr/bin/env node
// One-shot: sort the issues sheet by pricing_date ascending.
// Usage: source .env && node agency-analytics/server/sort-issues-once.js
const db = require('./db');
(async () => {
  await db.init();
  await db.sortBy('issues', 'pricing_date', 'ASCENDING');
  console.log('[sort] issues sorted by pricing_date ASCENDING');
  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
