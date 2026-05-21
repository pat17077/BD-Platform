#!/usr/bin/env node
// Insert yesterday's (5/19) FHLB results: 10yr/1yr DNT, 13yr/1yr, 15yr/3mo.
// Also auto-match the indications that exist for 10yr/1yr and 15yr/3mo.
const db = require('./db');

const TRADE = '2026-05-19';
const MOVE  = 86.07;
const S5S30 = 84.8;

const ENTRIES = [
  {
    structure: '10yr/1yr',
    settle_date: '2026-05-28',
    maturity_date: '2036-05-28',
    first_call_date: '2027-05-28',
    size: 10,
    coupon: '',
    fees: 'DNT',
    yel: 'Y',
    desk_notes: 'DNT — did not trade',
    cusip: 'PENDING-FHLB-20260519-10yr1yr-DNT',
  },
  {
    structure: '13yr/1yr',
    settle_date: '2026-06-03',
    maturity_date: '2039-06-03',
    first_call_date: '2027-06-03',
    size: 35,
    coupon: 5.70,
    fees: 7.5,
    spread:  '102/10yr',
    funding: '39.1/7.45',
    oas_par: 2,
    oas_cost: 4,
    yel: 'Y',
    cusip: 'PENDING-FHLB-20260519-13yr1yr-5.70',
  },
  {
    structure: '15yr/3mo',
    settle_date: '2026-06-03',
    maturity_date: '2041-06-03',
    first_call_date: '2026-09-03',
    size: 9,
    coupon: 5.85,
    fees: 14.8,
    spread:  '117/10yr',
    funding: '29.3/14.7',
    oas_par: -17,
    oas_cost: -10,
    yel: '',
    cusip: 'PENDING-FHLB-20260519-15yr3mo-5.85',
  },
];

(async () => {
  await db.init();
  const now = new Date().toISOString();
  for (const e of ENTRIES) {
    const row = {
      cusip: e.cusip,
      pricing_date: TRADE,
      issuer: 'FHLB',
      structure: e.structure,
      size: e.size,
      coupon: e.coupon,
      fees: e.fees,
      spread:  e.spread  || '',
      funding: e.funding || '',
      oas_par:  e.oas_par  != null ? e.oas_par  : '',
      oas_cost: e.oas_cost != null ? e.oas_cost : '',
      yel: e.yel || '',
      settle_date: e.settle_date,
      maturity_date: e.maturity_date,
      first_call_date: e.first_call_date,
      move: MOVE,
      s5s30s: S5S30,
      entered_by: 'Pat',
      data_classification: 'internal',
      desk_notes: e.desk_notes || '',
      ingested_at: now,
      version: 1,
    };
    await db.upsertRow('issues', row);
    console.log('  inserted ' + row.cusip + '  cpn=' + (row.coupon || 'DNT') + '  fees=' + row.fees);

    // Auto-match any open indication for the same (issuer, structure, settle_date)
    const inds = db.getRows('indications').filter((r) =>
      r.status === 'open' &&
      (!r.actual_cusip || r.actual_cusip === '') &&
      r.issuer === 'FHLB' && r.structure === e.structure && r.settle_date === e.settle_date
    );
    for (const ind of inds) {
      const fundingNum = parseFloat(String(row.funding || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
      const predicted = parseFloat(ind.predicted_funding_spread);
      const gap = (isFinite(fundingNum) && isFinite(predicted)) ? Math.round((fundingNum - predicted) * 100) / 100 : '';
      await db.upsertRow('indications', {
        ...ind,
        actual_cusip: row.cusip,
        actual_coupon: row.coupon,
        actual_funding_spread: isFinite(fundingNum) ? fundingNum : '',
        gap_bp: gap,
        updated_at: now,
      });
      console.log('    matched indication ' + ind.indication_id + '  gap=' + gap);
    }
  }

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
