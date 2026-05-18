// Scraper for the FHLB Callable Bond Auctions (pre-pricing announcements) page.
//
// URL: https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/auctions-50
//      (iframe -> https://www.fhlb-of.com/fhlb-of/contrib/bond_cba.htm)
//
// Auctions are announced here ~9:45 ET each business day. CUSIPs and coupons
// are NOT yet assigned (those appear on the CBR results page once the auction
// closes ~10:30 ET). What we get:
//   - Trade date (the auction day)
//   - Bids due time (e.g., 10:30)
//   - Structure, Settlement Date, Maturity Date, Call Date, Next Pay Date,
//     Par Amt (Mil), Benchmark Desc
//
// Caveat: the page's data rows are malformed HTML — each row begins with a
// stray `</tr>` and lacks an opening `<tr>`. We work around this by splitting
// on `</tr>` and parsing the cell stream of each chunk.

const fetch = require('node-fetch');

const CBA_URL = 'https://www.fhlb-of.com/fhlb-of/contrib/bond_cba.htm';

function _parseMmDdYy(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) >= 70 ? '19' : '20') + yy;
  return `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function _cells(html) {
  const re = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

function parseCbaHtml(html) {
  // Locate the announcement table block.
  const resultMatch = html.match(/<table\s+class="resulttable"[\s\S]*?<\/table>/i);
  if (!resultMatch) return { tradeDate: null, bidsDueEt: null, items: [] };

  // Header block: "Bids Due / TradeDate / 10:30 / 05/11/26"
  const idxMatch = html.match(/<table\s+class="indextable"[\s\S]*?<\/table>/i);
  let tradeDate = null, bidsDueEt = null;
  if (idxMatch) {
    const c = _cells(idxMatch[0]);
    bidsDueEt = c[2] || null;
    tradeDate = _parseMmDdYy(c[3] || '');
  }

  const block = resultMatch[0];
  // Headers in this table dictate the column order:
  // CUSIP, Structure Desc, Settlement Date, Maturity Date, Call Date,
  // Next Pay Date, Par Amt (Mil), Coupon %, Benchmark Desc
  // Data "rows" are malformed: split on </tr> and walk the cells.
  const chunks = block.split(/<\/tr>/i);
  const items = [];
  for (const chunk of chunks) {
    const cells = _cells(chunk);
    if (cells.length < 9) continue;
    // Skip the header chunk
    if (cells[0].toUpperCase() === 'CUSIP') continue;
    const structure = cells[1];
    if (!/Yr|Mo/.test(structure)) continue;
    const settle    = _parseMmDdYy(cells[2]);
    const maturity  = _parseMmDdYy(cells[3]);
    const firstCall = _parseMmDdYy(cells[4]);
    const nextPay   = _parseMmDdYy(cells[5]);
    const parMM     = parseFloat(cells[6]);
    const benchmark = cells[8];
    if (!structure || !settle || !maturity) continue;
    items.push({
      trade_date: tradeDate,
      bids_due_et: bidsDueEt,
      source: 'FHLB',
      structure,
      settle_date: settle,
      maturity_date: maturity,
      first_call_date: firstCall,
      next_pay_date: nextPay,
      par_mm: isFinite(parMM) ? parMM : '',
      benchmark_desc: benchmark || '',
      ingested_at: new Date().toISOString(),
    });
  }
  return { tradeDate, bidsDueEt, items };
}

async function fetchCba() {
  const r = await fetch(CBA_URL, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' }, timeout: 15000 });
  if (!r.ok) throw new Error(`CBA HTTP ${r.status}`);
  const html = await r.text();
  return parseCbaHtml(html);
}

module.exports = { fetchCba, parseCbaHtml };
