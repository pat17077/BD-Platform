#!/usr/bin/env node
// One-shot: insert today's 11 auctions into the issues sheet.
// Usage: source .env && node agency-analytics/server/bulk-insert-today.js
const db = require('./db');

const TRADE = '2026-05-13';
const MOVE  = 71.68;

function addYears(iso, y) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + Math.floor(y));
  if (y % 1) d.setUTCMonth(d.getUTCMonth() + Math.round((y % 1) * 12));
  return d.toISOString().slice(0, 10);
}
function placeholderCusip(issuer, structure, coupon) {
  return `PENDING-${issuer}-${TRADE.replace(/-/g,'')}-${structure.replace(/\//g,'')}-${coupon}`;
}
function tenorOf(structure) {
  const m = structure.match(/^(\d+(?:\.\d+)?)\s*yr/i);
  return m ? parseFloat(m[1]) : null;
}

const ENTRIES = [
  // ── FHLB Round 1 (10:30 AM, s5s30s 90.8) ─────────────────────────────
  {
    issuer:'FHLB', structure:'7yr/1yr',   size:15, coupon:4.90,  fees:11.3,
    funding:'15.7/11.28',  spread:'59/7yr',   oas_par: 6, oas_cost: 11, yel:'Y',
    settle:'2026-05-27', time:'10:30', s5s30s:90.8,
  },
  {
    issuer:'FHLB', structure:'7yr/3yr',   size:22, coupon:4.61,  fees:25,
    funding:'24.6/25.04',  spread:'30/7yr',   oas_par: 1, oas_cost: 7,  yel:'',
    settle:'2026-06-01', time:'10:30', s5s30s:90.8,
  },
  {
    issuer:'FHLB', structure:'10yr/1yr',  size:50, coupon:5.08,  fees:17.8,
    funding:'16.4/17.88',  spread:'59/10yr',  oas_par:-7, oas_cost:-2, yel:'Y',
    settle:'2026-05-21', time:'10:30', s5s30s:90.8,
    notes:'announced 35MM, traded right away and upsized by +15MM',
    upsize_status:'upsized +15MM',
  },
  {
    issuer:'FHLB', structure:'15yr/6mo',  size: 3, coupon:5.52,  fees:28.6,
    funding:'33.3/28.7',   spread:'103/10yr', oas_par:-25, oas_cost:-13, yel:'',
    settle:'2026-05-20', time:'10:30', s5s30s:90.8,
  },
  {
    issuer:'FHLB', structure:'20yr/1yr',  size:35, coupon:5.75,  fees:9,
    funding:'36.2/9.09',   spread:'81/20yr 126/10yr', oas_par:-21, oas_cost:-19, yel:'Y',
    settle:'2026-05-21', time:'10:30', s5s30s:90.8,
  },
  // ── FHLB Round 2 (10:55 AM, s5s30s 90) ───────────────────────────────
  {
    issuer:'FHLB', structure:'10yr/5yr',  size: 8, coupon:4.64,  fees:30,
    funding:'23/29.97',    spread:'15/10yr',  oas_par:-12, oas_cost:-7, yel:'',
    settle:'2026-05-27', time:'10:55', s5s30s:90,
  },
  {
    issuer:'FHLB', structure:'15yr/1yr',  size: 8, coupon:5.50,  fees:29.4,
    funding:'36.5/29.5',   spread:'101/10yr', oas_par:-17, oas_cost:-9, yel:'Y',
    settle:'2026-05-27', time:'10:55', s5s30s:90,
  },
  {
    issuer:'FHLB', structure:'20yr/2yr',  size:10, coupon:'',    fees:'DNT',
    funding:'', spread:'', oas_par:'', oas_cost:'', yel:'Y',
    settle:'2026-05-27', time:'10:55', s5s30s:90,
    notes:'DNT — did not trade',
  },
  // ── FFCB Round 1 (11:15 AM, s5s30s 89.9; same-day settle convention) ─
  {
    issuer:'FFCB', structure:'3yr/1yr',  size:140, coupon:4.24, fees:15,
    funding:'1.55/15.05',  spread:'19/3yr',   oas_par:-5, oas_cost: 3, yel:'',
    settle:TRADE, time:'11:15', s5s30s:89.9,
  },
  {
    issuer:'FFCB', structure:'4yr/3mo',  size:110, coupon:4.54, fees:17.5,
    funding:'4.65/17.52',  spread:'49/3yr 39/5yr', oas_par:-6, oas_cost: 9, yel:'',
    settle:TRADE, time:'11:15', s5s30s:89.9,
  },
  {
    issuer:'FFCB', structure:'5yr/6mo',  size:110, coupon:4.61, fees:20,
    funding:'2.47/20.01',  spread:'46/5yr',   oas_par:-5, oas_cost: 7, yel:'',
    settle:TRADE, time:'11:15', s5s30s:89.9,
  },
];

(async () => {
  await db.init();
  let inserted = 0;
  for (const e of ENTRIES) {
    const tenor = tenorOf(e.structure);
    const maturity = addYears(e.settle, tenor);
    const cusip = placeholderCusip(e.issuer, e.structure, e.coupon || 'DNT');
    const row = {
      cusip,
      pricing_date: TRADE,
      issuer: e.issuer,
      structure: e.structure,
      size: e.size,
      coupon: e.coupon,
      fees: e.fees,
      spread: e.spread,
      funding: e.funding,
      oas_par: e.oas_par,
      oas_cost: e.oas_cost,
      s5s30s: e.s5s30s,
      yel: e.yel || '',
      settle_date: e.settle,
      move: MOVE,
      maturity_date: maturity,
      pricing_time_et: e.time,
      desk_notes: e.notes || '',
      upsize_status: e.upsize_status || '',
      entered_by: 'Pat',
      data_classification: 'internal',
      ingested_at: new Date().toISOString(),
      version: 1,
    };
    await db.upsertRow('issues', row);
    inserted++;
    console.log(`  ${cusip}  ${e.issuer} ${e.structure}  cpn=${e.coupon || 'DNT'}  ✓`);
  }
  await db.sortMulti('issues', [
    { column: 'pricing_date',    direction: 'ASCENDING' },
    { column: 'pricing_time_et', direction: 'ASCENDING' },
    { column: 'issuer',          direction: 'DESCENDING' },
    { column: 'maturity_date',   direction: 'ASCENDING' },
  ]);
  console.log(`[bulk-insert] ${inserted} rows inserted`);
  db.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
