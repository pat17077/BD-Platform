// Scraper for FHLB Callable Bond Auction History (past auctions).
//
// URL: https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/callable-bond-auction-history-119
//      (iframe -> /history/faces/callable.xhtml, JSF Mojarra)
//
// The index page lists Trade Date / Bids Due / Structure summary as rows.
// Drilling down on a row is a JSF POST with the per-row action ID, which
// returns the same per-auction detail format as the CBR results page.
// We reuse parseCbrHtml() from fhlb-cbr.js to parse the drilldown response.

const fetch = require('node-fetch');
const { parseCbrHtml } = require('./fhlb-cbr');

const INDEX_URL = 'https://www.fhlb-of.com/history/faces/callable.xhtml';

function _parseMmDdYy(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) >= 70 ? '19' : '20') + yy;
  return `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

async function _getIndex() {
  const r = await fetch(INDEX_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', timeout: 15000 });
  if (!r.ok) throw new Error(`history index HTTP ${r.status}`);
  const cookies = (r.headers.raw()['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const html = await r.text();
  const vsMatch = html.match(/javax\.faces\.ViewState[^"]*"[^"]*value="([^"]+)"/);
  const actionMatch = html.match(/<form[^>]*action="([^"]+)"/);
  if (!vsMatch || !actionMatch) throw new Error('history index parse failed');
  // Each row anchor: dataTableForm:resultlist:N:j_id26
  const rowRe = /<a[^>]*onclick="[^"]*dataTableForm:resultlist:(\d+):j_id26[^"]*"[^>]*>([^<]+)<\/a>[\s\S]{0,300}?<td>([^<]+)<\/td>[\s\S]{0,300}?<td>([^<]+)<\/td>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    rows.push({ index: +m[1], tradeDate: _parseMmDdYy(m[2]), bidsDue: m[3].trim(), structuresSummary: m[4].trim() });
  }
  return {
    viewState: vsMatch[1],
    action: 'https://www.fhlb-of.com' + actionMatch[1],
    cookie: cookies,
    rows,
  };
}

async function listAuctionDates() {
  const idx = await _getIndex();
  return idx.rows.map((r) => ({ index: r.index, tradeDate: r.tradeDate, summary: r.structuresSummary }));
}

async function fetchAuctionDay(rowIndex) {
  // Each JSF POST needs a fresh ViewState; we GET the index each call to
  // keep the flow stateless. For a one-shot historical backfill this is fine.
  const idx = await _getIndex();
  const target = idx.rows.find((r) => r.index === rowIndex);
  if (!target) throw new Error(`no row at index ${rowIndex}`);

  const params = new URLSearchParams({
    dataTableForm: 'dataTableForm',
    [`dataTableForm:resultlist:${rowIndex}:j_id26`]: `dataTableForm:resultlist:${rowIndex}:j_id26`,
    'javax.faces.ViewState': idx.viewState,
  });
  const r = await fetch(idx.action, {
    method: 'POST',
    body: params.toString(),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Cookie': idx.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    redirect: 'follow',
    timeout: 15000,
  });
  if (!r.ok) throw new Error(`history drilldown HTTP ${r.status}`);
  const html = await r.text();
  // The detail page response embeds the same CBR-style auction blocks; parser
  // expects the inline iframe body, so feed it the response HTML directly.
  // We patch header detection: instead of "TradeDate" header at the top, the
  // history detail page may not include it — overlay the trade date manually.
  const items = parseCbrHtml(html).map((it) => ({ ...it, traded: target.tradeDate, sourceUrl: 'https://www.fhlb-of.com/ofweb_userWeb/pageBuilder/callable-bond-auction-history-119' }));
  return items;
}

module.exports = { listAuctionDates, fetchAuctionDay };
