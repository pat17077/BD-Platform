// Scraper for the FHLB Office of Finance Callable Bond Auction Results page.
//
// URL: https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/auction-results-51
//      (iframe -> https://www.fhlb-of.com/fhlb-of/contrib/bond_cbr.htm)
//
// This is the canonical source for TODAY's FHLB callable auctions. It gives us:
//   - Trade Date (the actual pricing/auction date, separate from settle)
//   - Settle Date
//   - Maturity Date
//   - First Call Date (and Call Style — American vs European)
//   - Par Amount in MM
//   - Coupon
//   - Concession ($/1000) = dealer takedown — lets us compute OAS-at-cost properly
//   - Winners / Covers (dealer panel)
//   - Benchmark tenor + yield
//
// The page only contains the most-recent trade day. For historical FHLB issues
// we still rely on the existing /api/internal/new-issues scraper.

const fetch = require('node-fetch');

const CBR_URL = 'https://www.fhlb-of.com/fhlb-of/contrib/bond_cbr.htm';

function _parseMmDdYy(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) >= 70 ? '19' : '20') + yy;
  return `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function _parseStructure(s) {
  // e.g. "10 Yr nc 6 Mo (A)" -> { tenorYrs: 10, ncMonths: 6, callStyle: 'A' }
  // also "5 Yr nc 1 Yr (A)" -> { tenorYrs: 5, ncMonths: 12 }
  if (!s) return null;
  const m = s.match(/(\d+)\s*Yr\s*nc\s*(\d+)\s*(Mo|Yr)\s*\(([AE])\)/i);
  if (!m) return null;
  const tenor = +m[1];
  const ncN = +m[2];
  const ncUnit = m[3].toUpperCase();
  const ncMonths = ncUnit === 'YR' ? ncN * 12 : ncN;
  return { tenorYrs: tenor, ncMonths, callStyle: m[4].toUpperCase() };
}

function _cellsFromRow(row) {
  const cellRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
  const out = [];
  let m;
  while ((m = cellRe.exec(row)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

function _findKv(rows, key) {
  // Find a row containing `key:` and return the value cell next to it.
  // Case-insensitive, ignores trailing spaces/colons, handles `<td>` or `<th>`.
  const k = key.toLowerCase().replace(/[():\s]/g, '');
  for (const r of rows) {
    const cells = _cellsFromRow(r);
    for (let i = 0; i < cells.length; i++) {
      const norm = cells[i].toLowerCase().replace(/[():\s]/g, '');
      if (norm === k) return cells[i + 1] || null;
    }
  }
  return null;
}

function _stripCurrency(s) {
  if (s == null) return null;
  // "$10.000" -> 10.000, "4.820 %" -> 4.820
  const cleaned = String(s).replace(/[$,\s%]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function parseCbrHtml(html) {
  // The page header has trade date; each auction block follows a row that
  // contains "Structure:" with the structure text in the next cell, and a row
  // with "CUSIP No:" with the CUSIP.
  // We split the body into blocks delimited by Structure rows and parse each
  // block independently.

  // Trade date is in the page header (a row containing TradeDate column header
  // with the date as its value in the next row).
  const headerTradeDate = (() => {
    const m = html.match(/TradeDate[\s\S]{0,400}?<td[^>]*>\s*<\/td>?\s*<td[^>]*>([0-9/]+)<\/td>/i)
              || html.match(/Trade\s*Date[\s\S]{0,200}?(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (m) return _parseMmDdYy(m[1]);
    return null;
  })();

  // Split the document by "Structure:" anchors. The CBR page uses <th> for
  // both label and value; the history detail page uses <td> for both. Match
  // either, capturing the value cell that follows the "Structure:" label.
  const blocks = [];
  const structureAnchor = /<(?:th|td)[^>]*>\s*Structure:\s*<\/(?:th|td)>\s*<(?:th|td)[^>]*>([^<]+)<\/(?:th|td)>([\s\S]*?)(?=<(?:th|td)[^>]*>\s*Structure:\s*<\/(?:th|td)>|<\/tbody>|<\/table>|$)/gi;
  let m;
  while ((m = structureAnchor.exec(html)) !== null) {
    blocks.push({ structureText: m[1].trim(), body: m[2] });
  }

  const out = [];
  for (const b of blocks) {
    const struct = _parseStructure(b.structureText);
    if (!struct) continue;
    const rows = b.body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    // CUSIP is on the same row as the structure header (we just consumed),
    // so also extract from the surrounding context if needed.
    let cusip = _findKv(rows, 'CUSIP No');
    if (!cusip) {
      // Look in the structure-row context — the structure anchor regex captured
      // just the structureText, but the CUSIP cell follows in the same row.
      const ctxMatch = b.body.match(/^([\s\S]{0,400})/);
      if (ctxMatch) {
        const cm = ctxMatch[1].match(/CUSIP\s*No:?[\s\S]{0,80}?<(?:th|td)[^>]*>\s*([A-Z0-9]{9})/i);
        if (cm) cusip = cm[1];
      }
    }
    const settle     = _parseMmDdYy(_findKv(rows, 'Settlement Date'));
    const maturity   = _parseMmDdYy(_findKv(rows, 'Maturity Date'));
    const firstCall  = _parseMmDdYy(_findKv(rows, 'First Call Date'));
    const firstPay   = _parseMmDdYy(_findKv(rows, 'First Pay Date'));
    const couponStr  = _findKv(rows, 'Coupon');
    const parStr     = _findKv(rows, 'Par Amount (Mil)');
    const concStr    = _findKv(rows, 'Conc ($/1000)');
    const payFreq    = _findKv(rows, 'Pay Frequency');
    const callStyle  = _findKv(rows, 'Call Style');
    const benchmark  = _findKv(rows, 'Benchmark');
    const winners    = _findKv(rows, 'Winners');

    if (!cusip || !settle || !maturity) continue;

    const coupon = _stripCurrency(couponStr);
    const parMM  = _stripCurrency(parStr);
    const concPer1000 = _stripCurrency(concStr);
    // Concession is in $ per $1000 face → fees in $ = par_face × conc/1000
    const fees_dollars = (isFinite(parMM) && isFinite(concPer1000))
      ? (parMM * 1e6) * (concPer1000 / 1000)
      : null;
    // DNT (Did Not Trade): auction listed but no winners, no coupon, no concession
    const didNotTrade = !winners && !isFinite(coupon) && !isFinite(concPer1000);

    // Bench parse: "4.214 7Y Tsy" -> tenor 7Y, yield 4.214
    let ustBenchmark = null, benchTenor = null, benchYield = null;
    if (benchmark) {
      const bm = benchmark.match(/([\d.]+)\s*(\d+\s*[YyMm])\s*(Tsy|Treasury)/i);
      if (bm) { benchYield = parseFloat(bm[1]); benchTenor = bm[2].toUpperCase().replace(/\s+/g, ''); ustBenchmark = `UST ${benchTenor} @ ${benchYield.toFixed(2)}%`; }
    }
    const spreadBps = (isFinite(coupon) && isFinite(benchYield))
      ? Math.round((coupon - benchYield) * 100) : null;

    out.push({
      source: 'FHLB',
      cusip,
      issuer: 'FHLB',
      type: 'Agency Callable',
      callable: true,
      callType: callStyle === 'American' ? 'AMR' : 'EUR',
      // We don't have an explicit "callStructure" string from CBR, but our
      // _structureNotation in ingest.js will recompute it from tenorYrs +
      // callSchedule.startDate anyway. Provide a hint for fallback.
      callStructure: `${struct.tenorYrs} Yr nc ${struct.ncMonths < 12 ? `${struct.ncMonths} Mo` : `${struct.ncMonths/12} Yr`} (${struct.callStyle})`,
      callSchedule: [{
        callType: callStyle || 'American',
        startDate: firstCall,
        endDate: maturity,
        nextCall: firstCall,
        frequency: callStyle === 'European' ? 'EUR' : 'CONT',
      }],
      traded: headerTradeDate,
      issued: settle,
      maturity,
      firstCall,
      firstPay,
      tenorYrs: struct.tenorYrs,
      coupon: isFinite(coupon) ? coupon : null,
      price: 100,
      size: isFinite(parMM) ? parMM * 1e6 : null,
      feesUSD: fees_dollars,
      concPer1000: isFinite(concPer1000) ? concPer1000 : null,
      payFrequency: payFreq,
      ustBenchmark,
      spreadBps,
      couponLabel: isFinite(coupon) ? `${coupon.toFixed(3)}%` : '',
      sizeLabel: isFinite(parMM) ? `$${parMM.toFixed(1)}MM` : '—',
      spreadLabel: spreadBps != null ? `${spreadBps >= 0 ? '+' : ''}${spreadBps} bps` : '—',
      winners: winners || '',
      didNotTrade,
      sourceUrl: 'https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/auction-results-51',
    });
  }
  return out;
}

async function fetchCbr() {
  const r = await fetch(CBR_URL, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' }, timeout: 15000 });
  if (!r.ok) throw new Error(`CBR HTTP ${r.status}`);
  const html = await r.text();
  return parseCbrHtml(html);
}

module.exports = { fetchCbr, parseCbrHtml };
