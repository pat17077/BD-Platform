#!/usr/bin/env node
// One-shot:
//   1) Remove rows with duplicate CUSIPs (keep first occurrence).
//   2) Delete zero-coupon rows that aren't legitimate DNT (DNT keeps fees='DNT').
//   3) Re-sort issues sheet (pricing_date ASC, issuer DESC).
const db = require('./db');

(async () => {
  await db.init();
  const all = db.getRows('issues');

  // 1) Identify duplicate CUSIPs
  const seen = new Set();
  const dupes = [];
  for (const r of all) {
    if (!r.cusip) continue;
    if (seen.has(r.cusip)) dupes.push(r.cusip);
    else seen.add(r.cusip);
  }
  console.log('duplicate cusips:', dupes);

  // Delete one of each duplicate. db.deleteWhere deletes ALL matches, so we use
  // a counter to keep the first instance.
  for (const dupCusip of dupes) {
    let kept = false;
    await db.deleteWhere('issues', (r) => {
      if (r.cusip !== dupCusip) return false;
      if (!kept) { kept = true; return false; }
      return true;  // delete subsequent dupes
    });
  }

  // 2) Delete zero-coupon non-DNT rows
  const all2 = db.getRows('issues');
  const zeroes = all2.filter((r) =>
    (r.coupon === '' || r.coupon == null || String(r.coupon).trim() === '0') &&
    r.fees !== 'DNT'
  );
  console.log('zero-coupon non-DNT rows to delete:', zeroes.length);
  for (const z of zeroes) console.log('  ' + z.cusip + ' ' + z.issuer + ' ' + z.structure + ' priced=' + z.pricing_date);
  for (const z of zeroes) {
    await db.deleteWhere('issues', (r) => r.cusip === z.cusip);
  }

  // 3) Re-sort
  await db.sortMulti('issues', [
    { column: 'pricing_date',    direction: 'ASCENDING' },
    { column: 'issuer',          direction: 'DESCENDING' },
    { column: 'pricing_time_et', direction: 'ASCENDING' },
    { column: 'maturity_date',   direction: 'ASCENDING' },
  ]);
  console.log('sorted issues sheet ASC');

  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
