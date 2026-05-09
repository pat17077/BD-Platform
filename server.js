/**
 * BD Platform Backend — server.js
 * 
 * Serves: Treasury curve, TRACE EOD data, CME rate probabilities,
 *         yield calculations, AI economic outlook via Claude API
 * 
 * Setup:

 * Free API keys:
 *   FRED: https://fred.stlouisfed.org/docs/api/api_key.html
 *   Anthropic: https://console.anthropic.com
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// Serve both UIs from the same server so the user can open
//   http://localhost:3001/        → internal desk
//   http://localhost:3001/client  → public client view
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/client', (_req, res) => res.sendFile(path.join(__dirname, 'client.html')));

const FRED_API_KEY = process.env.FRED_API_KEY || 'YOUR_FRED_API_KEY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'internal-secret-token';
const PORT = process.env.PORT || 3001;

// ─── In-memory cache ──────────────────────────────────────────────────────────
let cache = {
  curve: null,
  curveUpdated: null,
  economicData: null,
  economicUpdated: null,
  spreads: null,
  spreadsUpdated: null,
  outlook: null,
  outlookUpdated: null,
  trace: null,
  traceUpdated: null,
};

// ─── Auth middleware for internal routes ──────────────────────────────────────
function requireInternal(req, res, next) {
  const token = req.headers['x-internal-token'];
  if (token !== INTERNAL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── FRED series IDs ──────────────────────────────────────────────────────────
const CURVE_SERIES = {
  '1mo':  'DGS1MO',
  '3mo':  'DGS3MO',
  '6mo':  'DGS6MO',
  '1yr':  'DGS1',
  '2yr':  'DGS2',
  '3yr':  'DGS3',
  '5yr':  'DGS5',
  '7yr':  'DGS7',
  '10yr': 'DGS10',
  '20yr': 'DGS20',
  '30yr': 'DGS30',
};

const ECON_SERIES = {
  'fedFunds':     'FEDFUNDS',
  'cpi':          'CPIAUCSL',
  'corePce':      'PCEPILFE',
  'unemployment': 'UNRATE',
  'nfp':          'PAYEMS',
  'gdp':          'GDP',
  'sofr':         'SOFR',
};

// ICE BofA OAS series (FRED) — values are percent (e.g. 0.92 = 92 bps)
const SPREAD_SERIES = {
  'ig-1to3':   'BAMLC1A0C13Y',
  'ig-3to5':   'BAMLC2A0C35Y',
  'ig-5to7':   'BAMLC3A0C57Y',
  'ig-7to10':  'BAMLC4A0C710Y',
  'ig-10to15': 'BAMLC7A0C1015Y',
  'ig-15plus': 'BAMLC8A0C15PY',
  'hy':        'BAMLH0A0HYM2',
};

// IG quality buckets (where the credit-curve value is)
const QUALITY_OAS_SERIES = {
  'AAA': 'BAMLC0A1CAAA',
  'AA':  'BAMLC0A2CAA',
  'A':   'BAMLC0A3CA',
  'BBB': 'BAMLC0A4CBBB',
  'BB':  'BAMLH0A1HYBB',
  'B':   'BAMLH0A2HYB',
  'CCC': 'BAMLH0A3HYC',
};

// Daily central-bank policy / overnight rates
const POLICY_RATE_SERIES = {
  'fed':  { label: 'US Fed (DFF)',           id: 'DFF'      },
  'ecb':  { label: 'ECB Deposit Facility',   id: 'ECBDFR'   },
  'ecb_mro': { label: 'ECB Main Refinancing',id: 'ECBMRRFR' },
  'boe':  { label: 'BoE SONIA',              id: 'IUDSOIA'  },
  'sofr': { label: 'SOFR',                   id: 'SOFR'     },
};

// Foreign 10y benchmark yields. Eurozone is daily via ECB SDW (handled separately);
// the rest are monthly on FRED — will be flagged as monthly in the response.
const FOREIGN_10Y_SERIES = {
  'jp': { label: 'Japan 10y JGB',  id: 'IRLTLT01JPM156N', frequency: 'monthly' },
  'uk': { label: 'UK 10y Gilt',    id: 'IRLTLT01GBM156N', frequency: 'monthly' },
  'ca': { label: 'Canada 10y',     id: 'IRLTLT01CAM156N', frequency: 'monthly' },
  'au': { label: 'Australia 10y',  id: 'IRLTLT01AUM156N', frequency: 'monthly' },
};

// Risk-sentiment / commodity series (FRED daily). Oil = direct geopolitical proxy;
// gold = risk-off; VIX = equity stress; breakevens = market inflation expectations.
const RISK_SERIES = {
  'brent':    { label: 'Brent crude',          id: 'DCOILBRENTEU',     unit: '$' },
  'wti':      { label: 'WTI crude',            id: 'DCOILWTICO',       unit: '$' },
  'gold':     { label: 'Gold (LBMA AM fix)',   id: 'GOLDAMGBD228NLBM', unit: '$' },
  'vix':      { label: 'VIX',                  id: 'VIXCLS',           unit: '' },
  'breakeven10': { label: '10y breakeven inflation', id: 'T10YIE',     unit: '%' },
  'breakeven5':  { label: '5y breakeven inflation',  id: 'T5YIE',      unit: '%' },
};

// General news feeds — for catching geopolitical / market-moving events
// (war, blockades, elections, energy supply, etc.) that don't show up in
// central-bank press releases but absolutely move the bond market.
const MARKET_NEWS_FEEDS = [
  { id: 'bbc-world',    name: 'BBC World',     url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'bbc-business', name: 'BBC Business',  url: 'http://feeds.bbci.co.uk/news/business/rss.xml' },
  { id: 'cnbc-top',     name: 'CNBC',          url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'cnbc-bus',     name: 'CNBC Business', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { id: 'mw-top',       name: 'MarketWatch',   url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { id: 'wsj-world',    name: 'WSJ World',     url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews' },
];

const MATURITY_YRS = {
  '1mo':1/12,'3mo':0.25,'6mo':0.5,'1yr':1,'2yr':2,'3yr':3,
  '5yr':5,'7yr':7,'10yr':10,'20yr':20,'30yr':30
};

function igBucketKey(yrs) {
  if (yrs < 3)  return 'ig-1to3';
  if (yrs < 5)  return 'ig-3to5';
  if (yrs < 7)  return 'ig-5to7';
  if (yrs < 10) return 'ig-7to10';
  if (yrs < 15) return 'ig-10to15';
  return 'ig-15plus';
}

function summarizeSeries(obs) {
  if (!Array.isArray(obs) || obs.length === 0) return null;
  const filtered = obs.filter(o => Number.isFinite(o.value));
  if (filtered.length === 0) return null;
  const values = filtered.map(o => o.value);
  const current = values[0]; // FRED returned desc-sorted

  // 30-day window — primary frame for value vs recent regime
  const win30 = values.slice(0, Math.min(30, values.length));
  const avg30 = win30.reduce((a, b) => a + b, 0) / win30.length;
  const min30 = Math.min(...win30);
  const max30 = Math.max(...win30);
  // Position 0..1 within 30-day range. 0 = at recent tights (bonds expensive); 1 = at recent wides (bonds cheap)
  const range30 = max30 - min30;
  const pos30 = range30 > 0.0005 ? (current - min30) / range30 : 0.5;
  // Plain-English value label:
  //   pos30 ≤ 0.30 → bonds at recent tights → RICH
  //   pos30 ≥ 0.70 → bonds at recent wides  → CHEAP
  //   else → FAIR
  let valueLabel, valueCls;
  if (pos30 <= 0.30)      { valueLabel = 'Rich';  valueCls = 'cr'; }
  else if (pos30 >= 0.70) { valueLabel = 'Cheap'; valueCls = 'cg'; }
  else                    { valueLabel = 'Fair';  valueCls = 'ca'; }

  // 90-day window — regime check
  const win90 = values.slice(0, Math.min(90, values.length));
  const avg90 = win90.reduce((a, b) => a + b, 0) / win90.length;

  // Change look-backs
  const lookup = (n) => filtered[n]?.value;
  const dy = lookup(1);   // prior business-day close → 1-day change ("overnight")
  const wk = lookup(5);
  const mo = lookup(21);
  const yr = filtered[filtered.length - 1]?.value;
  const today = new Date(filtered[0].date);
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const ytdRef = filtered.find(o => new Date(o.date) < yearStart)?.value;

  return {
    current,
    n: values.length,
    asOf: obs[0].date,
    // 30-day primary
    avg30: +avg30.toFixed(3),
    min30: +min30.toFixed(3),
    max30: +max30.toFixed(3),
    vsAvg30: +(current - avg30).toFixed(3),  // positive = wider/cheaper than recent typical; negative = tighter/richer
    pos30:  +pos30.toFixed(3),
    valueLabel,
    valueCls,
    // 90-day secondary
    avg90: +avg90.toFixed(3),
    vsAvg90: +(current - avg90).toFixed(3),
    // Direction
    chg1d:  Number.isFinite(dy) ? +(current - dy).toFixed(3) : null,
    chg1w:  Number.isFinite(wk) ? +(current - wk).toFixed(3) : null,
    chg1m:  Number.isFinite(mo) ? +(current - mo).toFixed(3) : null,
    chgYtd: Number.isFinite(ytdRef) ? +(current - ytdRef).toFixed(3) : null,
    chg1y:  Number.isFinite(yr) ? +(current - yr).toFixed(3) : null,
    priorDay: Number.isFinite(dy) ? dy : null,
    priorDate: filtered[1]?.date || null,
    // Wider context (kept for tooltip / curiosity, not the headline)
    avgAll: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
    minAll: +Math.min(...values).toFixed(3),
    maxAll: +Math.max(...values).toFixed(3),
  };
}

// Higher OAS percentile = wider spread vs trailing year = bonds are CHEAPER
function valueRatingFromPctRank(pct) {
  if (pct == null) return null;
  if (pct >= 75) return { label: 'CHEAP',  cls: 'cg', pct };
  if (pct >= 50) return { label: 'FAIR+',  cls: 'cb', pct };
  if (pct >= 25) return { label: 'FAIR',   cls: 'ca', pct };
  return            { label: 'RICH',   cls: 'cr', pct };
}

// ─── Fetch single FRED series (last N observations) ───────────────────────────
async function fetchFredSeries(seriesId, limit = 3, attempt = 1) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.observations) {
      if (data.error_message && attempt < 3) {
        console.warn(`[fred] ${seriesId} error (try ${attempt}): ${data.error_message} — retrying`);
        await new Promise(r => setTimeout(r, 600 * attempt));
        return fetchFredSeries(seriesId, limit, attempt + 1);
      }
      console.warn(`[fred] ${seriesId} returned no observations:`, data.error_message || JSON.stringify(data).slice(0, 120));
      return null;
    }
    return data.observations.filter(o => o.value !== '.').map(o => ({
      date: o.date,
      value: parseFloat(o.value)
    }));
  } catch (e) {
    if (attempt < 3) {
      console.warn(`[fred] ${seriesId} fetch threw (try ${attempt}): ${e.message} — retrying`);
      await new Promise(r => setTimeout(r, 600 * attempt));
      return fetchFredSeries(seriesId, limit, attempt + 1);
    }
    console.error(`[fred] ${seriesId} fetch failed after retries:`, e.message);
    return null;
  }
}

// ─── Fetch full Treasury yield curve (with 1yr history for pct-rank) ─────────
async function fetchCurve() {
  console.log('[curve] Fetching Treasury curve from FRED (with 1yr history)...');
  const result = {};
  for (const [label, seriesId] of Object.entries(CURVE_SERIES)) {
    try {
      const obs = await fetchFredSeries(seriesId, 252);
      const stats = summarizeSeries(obs);
      if (stats) {
        result[label] = { yield: stats.current, date: stats.asOf, ...stats };
      }
    } catch (e) {
      console.error(`[curve] Failed to fetch ${seriesId}:`, e.message);
    }
  }
  cache.curve = result;
  cache.curveUpdated = new Date().toISOString();
  console.log('[curve] Updated:', Object.keys(result).length, 'points');
  return result;
}

// ─── Fetch ICE BofA OAS series (1yr history) ─────────────────────────────────
async function fetchSpreads() {
  console.log('[spreads] Fetching live OAS series from FRED...');
  const result = {};
  for (const [k, seriesId] of Object.entries(SPREAD_SERIES)) {
    try {
      const obs = await fetchFredSeries(seriesId, 252);
      const stats = summarizeSeries(obs);
      if (stats) result[k] = stats;
    } catch (e) {
      console.error(`[spreads] Failed ${k} (${seriesId}):`, e.message);
    }
  }
  cache.spreads = result;
  cache.spreadsUpdated = new Date().toISOString();
  console.log('[spreads] Updated:', Object.keys(result).length, 'series');
  return result;
}

// ─── Fetch key economic indicators ───────────────────────────────────────────
async function fetchEconomicData() {
  console.log('[econ] Fetching economic indicators from FRED...');
  const result = {};
  for (const [label, seriesId] of Object.entries(ECON_SERIES)) {
    try {
      const obs = await fetchFredSeries(seriesId, 3);
      if (obs && obs.length > 0) {
        result[label] = {
          current: obs[0].value,
          prior: obs[1]?.value || null,
          date: obs[0].date,
          change: obs[1] ? parseFloat((obs[0].value - obs[1].value).toFixed(3)) : null
        };
      }
    } catch (e) {
      console.error(`[econ] Failed to fetch ${label}:`, e.message);
    }
  }
  cache.economicData = result;
  cache.economicUpdated = new Date().toISOString();
  console.log('[econ] Updated:', Object.keys(result).length, 'indicators');
  return result;
}

// ─── Fetch quality-bucket OAS (AAA/AA/A/BBB/BB/B/CCC) ─────────────────────────
async function fetchQualityOas() {
  console.log('[quality] Fetching IG/HY quality bucket OAS from FRED...');
  const result = {};
  for (const [k, sid] of Object.entries(QUALITY_OAS_SERIES)) {
    try {
      const obs = await fetchFredSeries(sid, 252);
      const stats = summarizeSeries(obs);
      if (stats) result[k] = stats;
    } catch (e) {
      console.error(`[quality] Failed ${k}:`, e.message);
    }
  }
  cache.qualityOas = result;
  cache.qualityOasUpdated = new Date().toISOString();
  console.log('[quality] Updated:', Object.keys(result).length, 'buckets');
  return result;
}

// ─── Fetch central-bank policy rates (daily where available) ─────────────────
async function fetchPolicyRates() {
  console.log('[policy] Fetching central-bank policy rates from FRED...');
  const result = {};
  for (const [k, info] of Object.entries(POLICY_RATE_SERIES)) {
    try {
      const obs = await fetchFredSeries(info.id, 30);
      if (obs && obs.length) {
        result[k] = {
          label: info.label,
          seriesId: info.id,
          current: obs[0].value,
          prior: obs[1]?.value ?? null,
          date: obs[0].date,
          change: obs[1] ? +(obs[0].value - obs[1].value).toFixed(3) : null,
        };
      }
    } catch (e) {
      console.error(`[policy] Failed ${k}:`, e.message);
    }
  }
  cache.policyRates = result;
  cache.policyRatesUpdated = new Date().toISOString();
  console.log('[policy] Updated:', Object.keys(result).length, 'rates');
  return result;
}

// ─── Fetch Eurozone yield curve via ECB Statistical Data Warehouse (daily) ───
// Series key: B.U2.EUR.4F.G_N_A.SV_C_YM.SR_<tenor>  (AAA Euro government zero-coupon spot rates)
async function fetchEcbCurve() {
  console.log('[ecb-curve] Fetching Eurozone curve from ECB SDW...');
  const tenors = { '1yr': 'SR_1Y', '2yr': 'SR_2Y', '5yr': 'SR_5Y', '10yr': 'SR_10Y', '30yr': 'SR_30Y' };
  const result = {};
  for (const [label, key] of Object.entries(tenors)) {
    try {
      const url = `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.${key}?format=jsondata&lastNObservations=5`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) { console.warn(`[ecb-curve] ${key} HTTP ${res.status}`); continue; }
      const data = await res.json();
      const series = data?.dataSets?.[0]?.series;
      const seriesKey = series ? Object.keys(series)[0] : null;
      const obs = seriesKey ? series[seriesKey].observations : null;
      if (!obs) continue;
      const indices = Object.keys(obs).map(Number).sort((a, b) => b - a);
      const latestIdx = indices[0];
      const priorIdx  = indices[1];
      const value = obs[String(latestIdx)]?.[0];
      const prior = priorIdx != null ? obs[String(priorIdx)]?.[0] : null;
      const dim = data?.structure?.dimensions?.observation?.[0]?.values || [];
      const date = dim[latestIdx]?.id || null;
      const priorDate = priorIdx != null ? dim[priorIdx]?.id || null : null;
      if (Number.isFinite(value)) {
        result[label] = {
          yield: +value.toFixed(3),
          date,
          prior: Number.isFinite(prior) ? +prior.toFixed(3) : null,
          priorDate,
          chg1d: Number.isFinite(prior) ? +(value - prior).toFixed(3) : null,
        };
      }
    } catch (e) {
      console.warn(`[ecb-curve] ${key} failed:`, e.message);
    }
  }
  cache.ecbCurve = result;
  cache.ecbCurveUpdated = new Date().toISOString();
  console.log('[ecb-curve] Updated:', Object.keys(result).length, 'tenors');
  return result;
}

// ─── Fetch foreign 10y benchmarks (monthly via FRED) ─────────────────────────
async function fetchForeignBenchmarks() {
  console.log('[foreign] Fetching foreign 10y benchmarks (monthly)...');
  const result = {};
  for (const [k, info] of Object.entries(FOREIGN_10Y_SERIES)) {
    try {
      const obs = await fetchFredSeries(info.id, 12);
      if (obs && obs.length) {
        result[k] = {
          label: info.label, seriesId: info.id, frequency: info.frequency,
          current: obs[0].value, prior: obs[1]?.value ?? null, date: obs[0].date,
        };
      }
    } catch (e) {
      console.error(`[foreign] Failed ${k}:`, e.message);
    }
  }
  cache.foreign10y = result;
  cache.foreign10yUpdated = new Date().toISOString();
  console.log('[foreign] Updated:', Object.keys(result).length, 'benchmarks');
  return result;
}

// ─── Fetch RSS feeds from Fed / ECB / BoE for market color ───────────────────
async function fetchRssTitles(url, limit = 6) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' } });
    if (!res.ok) { console.warn(`[rss] ${url} HTTP ${res.status}`); return []; }
    const xml = await res.text();
    const items = [];
    // RSS <item> or Atom <entry>
    const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>|<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
      const block = m[1] || m[2] || '';
      const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1]
        .replace(/<!\[CDATA\[/, '').replace(/\]\]>/, '').trim();
      const date = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>|<dc:date[^>]*>([\s\S]*?)<\/dc:date>|<updated[^>]*>([\s\S]*?)<\/updated>/) || [])
        .slice(1).find(Boolean) || '';
      if (title) items.push({ title, date: date.trim() });
    }
    return items;
  } catch (e) {
    console.warn(`[rss] ${url} threw:`, e.message);
    return [];
  }
}

async function fetchCentralBankNews() {
  console.log('[cb-news] Fetching central-bank press feeds...');
  const [fed, ecb, boe] = await Promise.all([
    fetchRssTitles('https://www.federalreserve.gov/feeds/press_all.xml', 6),
    fetchRssTitles('https://www.ecb.europa.eu/rss/press.html', 6),
    fetchRssTitles('https://www.bankofengland.co.uk/rss/news', 6),
  ]);
  cache.cbNews = { fed, ecb, boe };
  cache.cbNewsUpdated = new Date().toISOString();
  console.log('[cb-news] Updated: fed=' + fed.length + ' ecb=' + ecb.length + ' boe=' + boe.length);
  return cache.cbNews;
}

// ─── Fetch general market-moving news (geopolitics, energy, macro events) ───
async function fetchMarketNews() {
  console.log('[news] Fetching market-news headlines...');
  const all = [];
  await Promise.all(MARKET_NEWS_FEEDS.map(async (feed) => {
    const items = await fetchRssTitles(feed.url, 12);
    items.forEach(i => all.push({ ...i, source: feed.name, sourceId: feed.id }));
  }));
  // Dedupe by title, sort by date desc where parseable
  const seen = new Set();
  const sorted = all
    .filter(x => x.title && (seen.has(x.title) ? false : (seen.add(x.title), true)))
    .sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));
  cache.marketNews = sorted.slice(0, 60);
  cache.marketNewsUpdated = new Date().toISOString();
  console.log('[news] Updated:', cache.marketNews.length, 'headlines from', MARKET_NEWS_FEEDS.length, 'sources');
  return cache.marketNews;
}

// ─── Fetch risk-sentiment / commodity indicators ────────────────────────────
async function fetchRiskIndicators() {
  console.log('[risk] Fetching risk indicators (oil, gold, VIX, breakevens)...');
  const result = {};
  for (const [k, info] of Object.entries(RISK_SERIES)) {
    try {
      const obs = await fetchFredSeries(info.id, 30);
      const stats = summarizeSeries(obs);
      if (stats) result[k] = { ...stats, label: info.label, unit: info.unit, seriesId: info.id };
    } catch (e) {
      console.error(`[risk] Failed ${k}:`, e.message);
    }
  }
  cache.risk = result;
  cache.riskUpdated = new Date().toISOString();
  console.log('[risk] Updated:', Object.keys(result).length, 'indicators');
  return result;
}

// ─── Compute implied forward rates from US Treasury curve ────────────────────
// Approximation: zero-coupon assumption on CMT yields. Good enough for directional
// market-implied forward path; flagged as approximate in the response.
function computeImpliedForwards() {
  const c = cache.curve || {};
  const ten = (k) => c[k]?.yield != null ? c[k].yield / 100 : null;
  const fwd = (y1, t1, y2, t2) => {
    if (y1 == null || y2 == null) return null;
    return +(((Math.pow(1 + y2, t2) / Math.pow(1 + y1, t1)) ** (1 / (t2 - t1)) - 1) * 100).toFixed(3);
  };
  return {
    'fwd 1y in 1y':   fwd(ten('1yr'), 1, ten('2yr'), 2),
    'fwd 1y in 2y':   fwd(ten('2yr'), 2, ten('3yr'), 3),
    'fwd 2y in 3y':   fwd(ten('3yr'), 3, ten('5yr'), 5),
    'fwd 5y in 5y':   fwd(ten('5yr'), 5, ten('10yr'), 10),
    method: 'Implied from UST CMT curve (zero-coupon approximation)',
  };
}

const PRODUCT_TEMPLATES = [
  {
    id:'gse-callable', cat:'gse', name:'Callable Agency', sub:'FHLB/FNMA/FHLMC callable',
    streetLow:15, streetHigh:30, streetTypical:22,
    spread:0.37,
    coupon:5.25,
    dealerValue:0.22,
    maturityRefs:['5yr','7yr','10yr','20yr','30yr'],
    note:'Off-the-run / longer calls = top of range. Best BD value in agencies.'
  },
  {
    id:'gse-bullet', cat:'gse', name:'Agency Bullet', sub:'FHLB/FNMA non-callable',
    streetLow:5, streetHigh:15, streetTypical:9,
    spread:0.09,
    coupon:4.25,
    dealerValue:0.09,
    maturityRefs:['5yr','7yr','10yr'],
    note:'On-the-run compresses to low end. Good for client, thin for us.'
  },
  {
    id:'ig-corp', cat:'corp', name:'IG Corporate', sub:'A–BBB rated, 3–10yr',
    streetLow:20, streetHigh:45, streetTypical:28,
    spread:1.30,
    coupon:4.50,
    dealerValue:0.28,
    maturityRefs:['5yr','7yr','10yr'],
    note:'Odd lots and off-the-run push to high end of range.'
  },
  {
    id:'hy-corp', cat:'corp', name:'High Yield Corp', sub:'BB/B rated',
    streetLow:40, streetHigh:80, streetTypical:58,
    spread:1.70,
    coupon:5.75,
    dealerValue:0.58,
    maturityRefs:['5yr','7yr','10yr'],
    note:'Wide market. Sourcing premium is real. Watch liquidity carefully.'
  },
  {
    id:'muni-go', cat:'muni', name:'Muni GO', sub:'AA–AAA general obligation',
    streetLow:25, streetHigh:55, streetTypical:35,
    spread:-0.55,
    coupon:3.75,
    dealerValue:0.35,
    maturityRefs:['10yr','20yr'],
    note:'Less TRACE transparency = higher range tolerance. Best % markup.'
  },
  {
    id:'muni-rev', cat:'muni', name:'Muni Revenue', sub:'A–AA revenue bonds',
    streetLow:25, streetHigh:60, streetTypical:38,
    spread:-0.59,
    coupon:3.85,
    dealerValue:0.38,
    maturityRefs:['10yr','20yr'],
    note:'Issuer complexity adds tolerance. Always check underlying credit.'
  },
  {
    id:'treasury-off', cat:'treasury', name:'Off-the-run UST', sub:'5–30yr off-the-run',
    streetLow:1, streetHigh:6, streetTypical:3,
    spread:0.00,
    coupon:4.30,
    dealerValue:0.03,
    maturityRefs:['10yr','20yr','30yr'],
    note:'Near zero margin. Use as relationship product.'
  },
  {
    id:'term-repo', cat:'repo', name:'Term Repo 1–3mo', sub:'UST/Agency collateral',
    streetLow:10, streetHigh:25, streetTypical:18,
    spread:0.10,
    coupon:5.05,
    dealerValue:0.18,
    maturityRefs:['1mo','3mo'],
    note:'Rate + collateral haircut = dealer take. Best spread for us in repo.'
  },
  {
    id:'repo-on', cat:'repo', name:'Overnight Repo', sub:'UST collateral ~SOFR',
    streetLow:4, streetHigh:12, streetTypical:8,
    spread:0.05,
    coupon:5.00,
    dealerValue:0.08,
    maturityRefs:['1mo','3mo'],
    note:'Volume game. Tight margin but excellent for client relationships.'
  },
];

// For a given product category and tenor, return the spread to UST plus the
// 30-day value snapshot (avg, range, plain-English label) where we have a live OAS.
function rungSpread(category, yrs) {
  const fromSeries = (s, sourceLabel) => ({
    oasPct: s.current,
    avg30Pct: s.avg30,
    vsAvg30Pct: s.vsAvg30,
    valueLabel: s.valueLabel,
    valueCls:   s.valueCls,
    pos30:      s.pos30,
    source: sourceLabel,
    live: true,
  });
  switch (category) {
    case 'ig-corp': {
      const k = igBucketKey(yrs);
      const s = cache.spreads?.[k];
      if (s) return fromSeries(s, `ICE BofA IG ${k} OAS`);
      return { oasPct: 0.30, source: 'fallback', live: false };
    }
    case 'hy-corp': {
      const s = cache.spreads?.['hy'];
      const tilt = (yrs - 7) * -0.02;
      if (s) return { ...fromSeries(s, 'ICE BofA HY Master OAS'), oasPct: s.current + tilt };
      return { oasPct: 3.50, source: 'fallback', live: false };
    }
    case 'gse-callable':
      return { oasPct: 0.30 + yrs * 0.015, source: 'modeled (no FRED OAS for agencies)', live: false };
    case 'gse-bullet':
      return { oasPct: 0.08 + yrs * 0.005, source: 'modeled (no FRED OAS for agencies)', live: false };
    case 'muni-go':
    case 'muni-rev':
      return { ratio: 0.85 + (yrs / 30) * 0.10, source: 'tax-equivalent UST ratio (modeled)', live: false };
    case 'treasury-off':
      return { oasPct: 0.02, source: 'modeled off-the-run discount', live: false };
    case 'term-repo':
    case 'repo-on': {
      const sofr = cache.economicData?.sofr?.current;
      return { sofrAnchor: sofr, oasPct: 0.05, source: sofr ? 'live SOFR + collateral haircut' : 'modeled', live: !!sofr };
    }
    default:
      return { oasPct: 0, source: 'none', live: false };
  }
}

async function buildInternalProducts() {
  if (!cache.curve)   await fetchCurve();
  if (!cache.spreads) await fetchSpreads();
  return PRODUCT_TEMPLATES.map(template => {
    const ladder = template.maturityRefs.map(ref => {
      const ust = cache.curve?.[ref];
      const ustYield = ust?.yield;
      const yrs = MATURITY_YRS[ref] ?? 0;
      const sp = rungSpread(template.id, yrs);

      let customerYield = null;
      if (ustYield != null) {
        if (sp.ratio != null)            customerYield = ustYield * sp.ratio;
        else if (sp.sofrAnchor != null)  customerYield = sp.sofrAnchor + sp.oasPct;
        else if (sp.oasPct != null)      customerYield = ustYield + sp.oasPct;
      }
      const spreadBps = (customerYield != null && ustYield != null)
        ? Math.round((customerYield - ustYield) * 100) : null;

      const settleDate = new Date().toISOString().slice(0, 10);
      const maturityDate = (() => {
        const d = new Date();
        const totalMonths = Math.round(yrs * 12);
        d.setMonth(d.getMonth() + totalMonths);
        return d.toISOString().slice(0, 10);
      })();
      const repCoupon = customerYield != null
        ? +(Math.round(customerYield * 8) / 8).toFixed(3)
        : template.coupon;

      // 30-day "vs recent average" value — plain English. Only present when we have a live OAS series.
      const vsAvg30Bps = sp.vsAvg30Pct != null ? Math.round(sp.vsAvg30Pct * 100) : null;
      const valueLabel = sp.valueLabel ?? null;
      const valueCls   = sp.valueCls ?? null;
      const spreadAvg30Bps = sp.avg30Pct != null ? Math.round(sp.avg30Pct * 100) : null;

      return {
        label: ref,
        coupon: repCoupon,
        ustYield: ustYield != null ? +ustYield.toFixed(2) : null,
        customerYield: customerYield != null ? +customerYield.toFixed(2) : null,
        spreadBps,
        spreadAvg30Bps,
        vsAvg30Bps,
        valueLabel,
        valueCls,
        spreadSource: sp.source,
        spreadLive: sp.live,
        dealerValue: template.dealerValue,
        settleDate,
        maturityDate,
        tenorYrs: yrs,
        customerYieldLabel: customerYield != null ? `${customerYield.toFixed(2)}%` : '—',
        couponLabel: repCoupon != null ? `${repCoupon.toFixed(3).replace(/0+$/,'').replace(/\.$/,'.0')}%` : '—',
        dealerValueLabel: template.dealerValue != null ? `$${template.dealerValue.toFixed(2)}` : '—',
        spreadLabel: spreadBps != null ? `${spreadBps >= 0 ? '+' : ''}${spreadBps} bps` : '—',
        vsAvg30Label: vsAvg30Bps != null ? `${vsAvg30Bps >= 0 ? '+' : ''}${vsAvg30Bps} bps vs 30d avg` : null,
      };
    });

    // Aggregate value: weight by how many rungs are Cheap / Fair / Rich, then label
    const labels = ladder.map(r => r.valueLabel).filter(Boolean);
    let aggLabel = null, aggCls = null;
    if (labels.length) {
      const tally = labels.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
      aggLabel = top;
      aggCls = top === 'Cheap' ? 'cg' : top === 'Rich' ? 'cr' : 'ca';
    }

    return {
      id: template.id,
      cat: template.cat,
      name: template.name,
      sub: template.sub,
      streetLow: template.streetLow,
      streetHigh: template.streetHigh,
      streetTypical: template.streetTypical,
      maturityLadder: ladder,
      clientValue: ladder[0]?.customerYield ?? null,
      dealerValue: +(template.dealerValue ?? (template.streetTypical / 100)).toFixed(2),
      note: template.note,
      valueLabel: aggLabel,
      valueCls: aggCls,
    };
  });
}

// ─── FHLB Office of Finance: real new-issue bond data ────────────────────────
// FHLB OF publishes daily fixed-width flat files at predictable URLs, e.g.
// Wedbond.dat (today's settlements), Wedcall.dat (call schedules), etc.
// File spec: https://www.fhlb-of.com/resources/filespec.pdf
const FHLB_BASE = 'https://www.fhlb-of.com/fhlb-of/data';

function fhlbDayPrefix(d = new Date()) {
  // Files only published Mon–Fri. Weekends/holidays fall back to prior business day.
  const map = { 0: 'Fri', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Fri' };
  return map[d.getDay()];
}

function parseFhlbDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Fixed-width parser: derives column boundaries from the dashes line under the header
function parseFhlbFixedWidth(text) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l => /^\s*CUSIP\b/.test(l));
  if (headerIdx < 0 || !lines[headerIdx + 1]) return [];
  const dashes = lines[headerIdx + 1];
  const cols = [];
  const re = /-+/g;
  let m;
  while ((m = re.exec(dashes)) !== null) {
    cols.push({ start: m.index, end: m.index + m[0].length, name: lines[headerIdx].slice(m.index, m.index + m[0].length).trim().toUpperCase() });
  }
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const row = {};
    cols.forEach(c => { row[c.name] = (line.slice(c.start, c.end) || '').trim(); });
    if (row.CUSIP) rows.push(row);
  }
  return rows;
}

// Match a tenor (years) to the closest UST CMT point we have
function ustYieldForTenor(yrs) {
  if (!cache.curve || yrs == null) return null;
  const have = Object.entries(MATURITY_YRS)
    .filter(([k]) => cache.curve[k]?.yield != null)
    .map(([k, y]) => ({ k, y, yld: cache.curve[k].yield }));
  if (have.length === 0) return null;
  have.sort((a, b) => Math.abs(a.y - yrs) - Math.abs(b.y - yrs));
  return { tenor: have[0].k, yield: have[0].yld };
}

async function fetchFhlbNewIssues() {
  const prefix = fhlbDayPrefix();
  try {
    const [bondRes, callRes] = await Promise.all([
      fetch(`${FHLB_BASE}/${prefix}bond.dat`),
      fetch(`${FHLB_BASE}/${prefix}call.dat`),
    ]);
    const [bondText, callText] = await Promise.all([bondRes.text(), callRes.text()]);
    const bonds = parseFhlbFixedWidth(bondText);
    const calls = parseFhlbFixedWidth(callText);

    const callMap = {};
    calls.forEach(c => {
      const cu = c.CUSIP;
      if (!cu) return;
      (callMap[cu] = callMap[cu] || []).push({
        callType: c.CALLTYPE,
        startDate: parseFhlbDate(c.STARTDT),
        endDate: parseFhlbDate(c.ENDDT),
        nextCall: parseFhlbDate(c.NEXTCALL),
        frequency: c.DATE,
      });
    });

    if (!cache.curve) await fetchCurve();

    return bonds.map(b => {
      const issued = parseFhlbDate(b.ISSUED);
      const maturity = parseFhlbDate(b.MATURITY);
      const tenorYrs = (issued && maturity)
        ? +(((new Date(maturity) - new Date(issued)) / (365.25 * 86400000)).toFixed(2))
        : null;
      const callSched = callMap[b.CUSIP] || [];
      const isCallable = (b.S === 'C' || (callSched.length > 0)) && (b.CALL || '').trim().toUpperCase() !== 'NON';
      const coupon = parseFloat(b.COUPON);
      const price = parseFloat(b.PRICE);
      const size = parseFloat(b.OUTSTANDING) || parseFloat(b.ORIGINAL);
      const ust = tenorYrs != null ? ustYieldForTenor(tenorYrs) : null;
      const spreadBps = (Number.isFinite(coupon) && ust)
        ? Math.round((coupon - ust.yield) * 100)  // par issue → YTM = coupon
        : null;
      const firstCall = callSched.length ? callSched[0].nextCall || callSched[0].startDate : null;
      const callStructure = isCallable && firstCall && maturity
        ? `${tenorYrs?.toFixed(0) ?? '?'}NC${(((new Date(firstCall) - new Date(issued)) / (365.25 * 86400000))).toFixed(0)}`
        : null;
      return {
        source: 'FHLB',
        cusip: b.CUSIP,
        issuer: 'FHLB',
        series: b.SERIES,
        type: isCallable ? 'Agency Callable' : 'Agency Bullet',
        callable: isCallable,
        callType: b.CALL,
        callStructure,                        // e.g., "5NC1"
        callSchedule: callSched,
        traded: parseFhlbDate(b.TRADED),
        issued, maturity,
        tenorYrs,
        coupon: Number.isFinite(coupon) ? coupon : null,
        price:  Number.isFinite(price)  ? price  : null,
        size:   Number.isFinite(size)   ? size   : null,
        ustBenchmark: ust ? `UST ${ust.tenor} @ ${ust.yield.toFixed(2)}%` : null,
        spreadBps,                            // YTM-to-UST spread (bps)
        couponLabel: Number.isFinite(coupon) ? `${coupon.toFixed(2)}%` : '—',
        sizeLabel:   Number.isFinite(size)   ? `$${(size/1e6).toFixed(1)}MM` : '—',
        spreadLabel: spreadBps != null ? `${spreadBps >= 0 ? '+' : ''}${spreadBps} bps` : '—',
      };
    });
  } catch (e) {
    console.error('[fhlb] new-issue fetch failed:', e.message);
    return [];
  }
}

// ─── FFCB (Federal Farm Credit Banks) — recent term debt ─────────────────────
// Scrapes the public term-debt activity HTML page. Each row carries CUSIP,
// issue/maturity, size, coupon (fixed or SOFR+spread), first call.
const FFCB_TERM_URL = 'https://www.farmcredit-ffcb.com/ffcb_live/dataCenter/termDebtActivity.html';

function parseFfcbDate(s) {
  // "05/14/26" → "2026-05-14"
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) >= 70 ? '19' : '20') + yy;
  return `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function parseFfcbHtml(html) {
  // Strip tags from a TD's inner HTML, collapse whitespace
  const stripTd = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let t;
    while ((t = tdRe.exec(m[1])) !== null) cells.push(stripTd(t[1]));
    if (cells.length < 8) continue;                // skip header / non-data rows
    if (!/^[0-9]{4}[A-Z0-9]{4}[0-9A-Z]$/.test(cells[0])) continue;
    rows.push({
      cusip:        cells[0],
      issueDate:    parseFfcbDate(cells[2]),
      maturityDate: parseFfcbDate(cells[3]),
      amountMM:     parseFloat(cells[4].replace(/,/g, '')),
      couponRaw:    cells[5],
      firstCall:    parseFfcbDate(cells[6]),
      program:      cells[7] || 'Bond',
    });
  }
  return rows;
}

async function fetchFfcbNewIssues() {
  try {
    const res = await fetch(FFCB_TERM_URL, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' } });
    if (!res.ok) { console.warn('[ffcb] HTTP', res.status); return []; }
    const html = await res.text();
    const rows = parseFfcbHtml(html);
    if (!cache.curve) await fetchCurve();

    // Keep recent issuance only (last 30 days) — that's the "new issue" frame
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const recent = rows.filter(r => r.issueDate && new Date(r.issueDate) >= cutoff);

    return recent.map(r => {
      const tenorYrs = (r.issueDate && r.maturityDate)
        ? +(((new Date(r.maturityDate) - new Date(r.issueDate)) / (365.25 * 86400000)).toFixed(2))
        : null;
      // Floater detection: coupon like "SOFR+8.5"
      const floaterMatch = r.couponRaw.match(/^\s*(SOFR|FED|Prime|TBILL)\s*\+\s*([0-9.]+)/i);
      let coupon = null, couponLabel = r.couponRaw, floater = null;
      if (floaterMatch) {
        floater = { index: floaterMatch[1].toUpperCase(), spreadBps: +floaterMatch[2] };
        couponLabel = `${floater.index}+${floater.spreadBps} bps`;
      } else {
        const num = parseFloat(r.couponRaw);
        if (Number.isFinite(num)) { coupon = num; couponLabel = `${num.toFixed(3)}%`; }
      }
      const ust = tenorYrs != null ? ustYieldForTenor(tenorYrs) : null;
      const spreadBps = (Number.isFinite(coupon) && ust)
        ? Math.round((coupon - ust.yield) * 100) : null;
      const isCallable = !!r.firstCall;
      const callStructure = (isCallable && tenorYrs != null && r.issueDate)
        ? `${Math.round(tenorYrs)}NC${(((new Date(r.firstCall) - new Date(r.issueDate)) / (365.25 * 86400000))).toFixed(0)}`
        : null;
      return {
        source: 'FFCB',
        cusip: r.cusip,
        issuer: 'Federal Farm Credit Banks',
        series: r.program || 'Bond',
        type: floater ? 'Agency Floater' : (isCallable ? 'Agency Callable' : 'Agency Bullet'),
        callable: isCallable,
        callType: isCallable ? 'OPT' : '',
        callStructure,
        callSchedule: isCallable ? [{ nextCall: r.firstCall, frequency: 'OPT' }] : [],
        traded: r.issueDate,
        issued: r.issueDate,
        maturity: r.maturityDate,
        tenorYrs,
        coupon,                              // null for floaters
        floater,                             // {index, spreadBps} when applicable
        price: 100,
        size: Number.isFinite(r.amountMM) ? r.amountMM * 1e6 : null,
        ustBenchmark: ust ? `UST ${ust.tenor} @ ${ust.yield.toFixed(2)}%` : null,
        spreadBps,
        couponLabel,
        sizeLabel:   Number.isFinite(r.amountMM) ? `$${r.amountMM}MM` : '—',
        spreadLabel: spreadBps != null ? `${spreadBps >= 0 ? '+' : ''}${spreadBps} bps` :
                     (floater ? couponLabel : '—'),
      };
    });
  } catch (e) {
    console.error('[ffcb] fetch failed:', e.message);
    return [];
  }
}

async function fetchTreasuryAnnounced() {
  try {
    const res = await fetch('https://www.treasurydirect.gov/TA_WS/securities/announced?format=json');
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    if (!cache.curve) await fetchCurve();
    return data
      .filter(a => ['Bill', 'Note', 'Bond', 'TIPS', 'FRN'].includes(a.securityType))
      .filter(a => a.auctionDate && new Date(a.auctionDate) >= new Date(Date.now() - 86400000))
      .sort((a, b) => new Date(a.auctionDate) - new Date(b.auctionDate))
      .slice(0, 15)
      .map(a => {
        const issued = (a.issueDate || '').slice(0, 10) || null;
        const maturityRaw = a.maturityDate || '';
        const maturity = maturityRaw.slice(0, 10) || null;
        const tenorYrs = (issued && maturity)
          ? +(((new Date(maturity) - new Date(issued)) / (365.25 * 86400000)).toFixed(2))
          : null;
        const coupon = parseFloat(a.interestRate);
        const size = parseFloat(a.offeringAmount);
        const ust = tenorYrs != null ? ustYieldForTenor(tenorYrs) : null;
        return {
          source: 'TreasuryDirect',
          cusip: a.cusip || '—',
          issuer: 'US Treasury',
          series: a.securityTerm || a.securityType,
          type: a.securityType === 'TIPS' ? 'Treasury TIPS'
              : a.securityType === 'FRN'  ? 'Treasury FRN'
              : a.securityType === 'Bill' ? 'Treasury Bill'
              : `Treasury ${a.securityType}`,
          callable: false,
          callType: '', callStructure: null, callSchedule: [],
          traded: (a.announcementDate || '').slice(0, 10) || null,
          auctionDate: (a.auctionDate || '').slice(0, 10) || null,
          issued, maturity, tenorYrs,
          coupon: Number.isFinite(coupon) ? coupon : null,
          price: null,
          size: Number.isFinite(size) ? size : null,
          ustBenchmark: ust ? `UST ${ust.tenor} @ ${ust.yield.toFixed(2)}%` : null,
          spreadBps: null,                                       // benchmark itself
          couponLabel: Number.isFinite(coupon) ? `${coupon.toFixed(3)}%` : 'TBD',
          sizeLabel:   Number.isFinite(size)   ? `$${(size/1e9).toFixed(2)}B` : '—',
          spreadLabel: 'benchmark',
          upcoming: true,
        };
      });
  } catch (e) {
    console.error('[treasury-announced] fetch failed:', e.message);
    return [];
  }
}

async function fetchAllNewIssues() {
  const [fhlb, ffcb, tsy] = await Promise.all([
    fetchFhlbNewIssues(),
    fetchFfcbNewIssues(),
    fetchTreasuryAnnounced(),
  ]);
  return [...fhlb, ...ffcb, ...tsy];
}

let newIssuesCache = { items: null, updatedAt: null };

app.get('/api/internal/new-issues', requireInternal, async (req, res) => {
  const stale = !newIssuesCache.items || !newIssuesCache.updatedAt ||
                (Date.now() - new Date(newIssuesCache.updatedAt)) > 30 * 60 * 1000;
  if (stale) {
    newIssuesCache.items = await fetchAllNewIssues();
    newIssuesCache.updatedAt = new Date().toISOString();
  }
  res.json({
    items: newIssuesCache.items,
    sources: ['FHLB Office of Finance', 'FFCB (Federal Farm Credit Banks)', 'TreasuryDirect'],
    updatedAt: newIssuesCache.updatedAt,
  });
});

// ─── Generate AI economic outlook via Claude ──────────────────────────────────
async function generateOutlook() {
  if (!cache.curve || !cache.economicData) {
    await Promise.all([fetchCurve(), fetchEconomicData()]);
  }

  const curveText = Object.entries(cache.curve)
    .map(([t, d]) => `${t}: ${d.yield}%`)
    .join(', ');

  const econText = Object.entries(cache.economicData)
    .map(([k, d]) => `${k}: ${d.current}${d.change !== null ? ` (${d.change > 0 ? '+' : ''}${d.change} vs prior)` : ''}`)
    .join('\n');

  const prompt = `You are a senior fixed income strategist at a broker-dealer. Based on the following current market data, write a concise, professional economic outlook for institutional and retail fixed income clients.

TREASURY YIELD CURVE (latest):
${curveText}

KEY ECONOMIC INDICATORS:
${econText}

Write a structured outlook with these exact sections. Use professional but accessible language. Be specific about numbers. Do not use bullet points — write in prose paragraphs.

1. MARKET SNAPSHOT (2-3 sentences on current curve shape and what it signals)
2. FED POLICY OUTLOOK (2-3 sentences on where rates are headed and why)
3. INFLATION & GROWTH (2 sentences on CPI/PCE trend and labor market)
4. FIXED INCOME STRATEGY (3-4 sentences on where value is in fixed income right now — specific sectors, durations)
5. KEY RISKS TO WATCH (2-3 sentences on the main risks to the rate outlook)

Keep the total under 400 words. Write today's date as the publication date.`;

  console.log('[outlook] Generating AI outlook via Claude...');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || 'Outlook unavailable.';

    cache.outlook = {
      text,
      curveSnapshot: cache.curve,
      econSnapshot: cache.economicData,
      generatedAt: new Date().toISOString()
    };
    cache.outlookUpdated = new Date().toISOString();
    console.log('[outlook] Generated successfully');
    return cache.outlook;
  } catch (e) {
    console.error('[outlook] Claude API error:', e.message);
    return null;
  }
}

// ─── Yield math utilities ─────────────────────────────────────────────────────
function pvBond(annualRate, face, couponPct, settleDate, endDate, redemptionPer100) {
  const yrs = (new Date(endDate) - new Date(settleDate)) / (365.25 * 86400000);
  if (yrs <= 0) return null;
  const periods = Math.max(1, Math.round(yrs * 2));
  const r = annualRate / 2;
  const cpn = (couponPct / 100) * face / 2;
  const redeem = face * (redemptionPer100 / 100);
  let pv = redeem / Math.pow(1 + r, periods);
  for (let t = 1; t <= periods; t++) pv += cpn / Math.pow(1 + r, t);
  return pv;
}

function solveYield(priceDollars, face, couponPct, settleDate, endDate, redemptionPer100) {
  const yrs = (new Date(endDate) - new Date(settleDate)) / (365.25 * 86400000);
  if (yrs <= 0) return null;

  let lo = -0.9999, hi = 50.0;
  const pvLo = pvBond(lo, face, couponPct, settleDate, endDate, redemptionPer100);
  const pvHi = pvBond(hi, face, couponPct, settleDate, endDate, redemptionPer100);
  if (pvLo === null || pvHi === null) return null;
  if ((pvLo - priceDollars) * (pvHi - priceDollars) > 0) return null;

  let curLo = lo, curHi = hi, curPvLo = pvLo;
  for (let i = 0; i < 200; i++) {
    const mid = (curLo + curHi) / 2;
    const pvMid = pvBond(mid, face, couponPct, settleDate, endDate, redemptionPer100);
    if (Math.abs(pvMid - priceDollars) < 0.001) return +(mid * 100).toFixed(4);
    if ((pvMid - priceDollars) * (curPvLo - priceDollars) < 0) { curHi = mid; }
    else { curLo = mid; curPvLo = pvMid; }
  }
  const result = (curLo + curHi) / 2 * 100;
  if (result < -50 || result > 200) return null;
  return +result.toFixed(4);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Public: Treasury yield curve
app.get('/api/curve', async (req, res) => {
  if (!cache.curve || !cache.curveUpdated ||
      (Date.now() - new Date(cache.curveUpdated)) > 3600000) {
    await fetchCurve();
  }
  res.json({ curve: cache.curve, updatedAt: cache.curveUpdated });
});

// Public: Economic indicators (summary only for client)
app.get('/api/econ', async (req, res) => {
  if (!cache.economicData || !cache.economicUpdated ||
      (Date.now() - new Date(cache.economicUpdated)) > 3600000) {
    await fetchEconomicData();
  }
  res.json({ data: cache.economicData, updatedAt: cache.economicUpdated });
});

// Public: AI economic outlook (cached, refreshed weekly)
app.get('/api/outlook', async (req, res) => {
  const oneWeek = 7 * 24 * 3600000;
  if (!cache.outlook || !cache.outlookUpdated ||
      (Date.now() - new Date(cache.outlookUpdated)) > oneWeek) {
    await generateOutlook();
  }
  if (!cache.outlook) return res.status(503).json({ error: 'Outlook unavailable' });
  res.json(cache.outlook);
});

// Public: Yield calculator (YTM, YTC, YTW, full call schedule)
app.post('/api/yield/calculate', (req, res) => {
  const { face, price, coupon, settle, maturity, firstCall, callFreqMonths, callPrice } = req.body;

  if (!face || !price || !coupon || !settle || !maturity || !firstCall) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const priceDollars = price * (face / 100);

  const ytm = solveYield(priceDollars, face, coupon, settle, maturity, 100);
  const ytfc = solveYield(priceDollars, face, coupon, settle, firstCall, callPrice || 100);

  const callDates = [];
  let cur = firstCall;
  const mat = new Date(maturity);
  while (new Date(cur) < mat) {
    callDates.push(cur);
    cur = addMonths(cur, callFreqMonths || 6);
  }

  const schedule = callDates
    .map(cd => {
      const y = solveYield(priceDollars, face, coupon, settle, cd, callPrice || 100);
      return y !== null ? { date: cd, yield: y, type: 'call' } : null;
    })
    .filter(Boolean);

  if (ytm !== null) schedule.push({ date: maturity, yield: ytm, type: 'maturity' });

  const ytw = schedule.reduce((best, d) => (!best || d.yield < best.yield) ? d : best, null);

  res.json({ ytm, ytfc, ytw, schedule, priceDollars });
});

// ─── Market-color (client-facing): per-asset-class blurbs + cross-border ────
async function generateMarketColorBlurb(prompt) {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.startsWith('YOUR_')) {
    console.warn('[mc] No Anthropic API key — synthesis disabled');
    return null;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[mc] Claude API error:', data.error.type, data.error.message);
      return null;
    }
    const text = data?.content?.[0]?.text?.trim();
    if (!text) console.warn('[mc] Claude returned empty content:', JSON.stringify(data).slice(0, 200));
    return text || null;
  } catch (e) {
    console.error('[mc] Claude blurb call threw:', e.message);
    return null;
  }
}

const ASSET_CLASS_DEFS = [
  { id: 'ust',         name: 'US Treasuries',     bucket: null,         hint: 'curve shape, term premium, fiscal/auction supply, Fed path' },
  { id: 'gse',         name: 'Agencies (GSE)',    bucket: null,         hint: 'spread to UST, callable optionality, supply from FHLB/FNMA/Freddie' },
  { id: 'ig-corp',     name: 'IG Corporates',     bucket: 'ig-7to10',   hint: 'OAS level, credit-curve quality dispersion, primary supply' },
  { id: 'hy-corp',     name: 'High Yield',        bucket: 'hy',         hint: 'spread compression vs IG, default expectations, retail flows' },
  { id: 'muni',        name: 'Munis',             bucket: null,         hint: 'tax-equivalent value, ratios to UST, SALT cap dynamics, supply' },
  { id: 'repo',        name: 'Repo / Cash',       bucket: null,         hint: 'SOFR vs Fed funds, RRP balances, collateral demand' },
];

async function buildMarketColor() {
  // Fan-out to ensure all live data is fresh
  if (!cache.curve) await fetchCurve();
  if (!cache.spreads) await fetchSpreads();
  if (!cache.qualityOas) await fetchQualityOas();
  if (!cache.policyRates) await fetchPolicyRates();
  if (!cache.ecbCurve) await fetchEcbCurve();
  if (!cache.foreign10y) await fetchForeignBenchmarks();
  if (!cache.cbNews) await fetchCentralBankNews();
  if (!cache.marketNews) await fetchMarketNews();
  if (!cache.risk) await fetchRiskIndicators();

  const fwds = computeImpliedForwards();
  const ust10 = cache.curve?.['10yr'];
  const us2y10s = (cache.curve?.['2yr']?.yield != null && cache.curve?.['10yr']?.yield != null)
    ? +(cache.curve['10yr'].yield - cache.curve['2yr'].yield).toFixed(3) : null;

  // Cross-border: hedged-equivalent yield for foreign investor in US 10y
  // Hedge cost ≈ short-rate differential (USD short - foreign short). Cross-currency basis omitted.
  const usShort = cache.curve?.['1mo']?.yield ?? cache.economicData?.sofr?.current;
  const ezShort = cache.policyRates?.ecb?.current;
  const ukShort = cache.policyRates?.boe?.current;
  const crossBorder = [];
  if (cache.ecbCurve?.['10yr']?.yield != null && Number.isFinite(usShort) && Number.isFinite(ezShort)) {
    const eu10 = cache.ecbCurve['10yr'].yield;
    const hedgeCost = +(usShort - ezShort).toFixed(2);
    const hedgedUS = ust10?.yield != null ? +(ust10.yield - hedgeCost).toFixed(2) : null;
    crossBorder.push({
      region: 'Eurozone',
      foreignYield: eu10,
      foreignSource: 'ECB SDW · daily AAA Euro government 10y',
      usYield: ust10?.yield ?? null,
      grossPickup: ust10?.yield != null ? +(ust10.yield - eu10).toFixed(2) : null,
      hedgeCostPct: hedgeCost,
      hedgeMethod: 'short-rate differential (SOFR/UST 1mo − ECB DFR)',
      netHedgedPickup: hedgedUS != null ? +(hedgedUS - eu10).toFixed(2) : null,
      hedgedUS,
    });
  }
  if (cache.foreign10y?.uk?.current != null && Number.isFinite(usShort) && Number.isFinite(ukShort)) {
    const uk10 = cache.foreign10y.uk.current;
    const hedgeCost = +(usShort - ukShort).toFixed(2);
    const hedgedUS = ust10?.yield != null ? +(ust10.yield - hedgeCost).toFixed(2) : null;
    crossBorder.push({
      region: 'UK',
      foreignYield: uk10,
      foreignSource: `FRED ${cache.foreign10y.uk.seriesId} · ${cache.foreign10y.uk.frequency} (asOf ${cache.foreign10y.uk.date})`,
      usYield: ust10?.yield ?? null,
      grossPickup: ust10?.yield != null ? +(ust10.yield - uk10).toFixed(2) : null,
      hedgeCostPct: hedgeCost,
      hedgeMethod: 'short-rate differential (SOFR − SONIA)',
      netHedgedPickup: hedgedUS != null ? +(hedgedUS - uk10).toFixed(2) : null,
      hedgedUS,
    });
  }
  if (cache.foreign10y?.jp?.current != null && Number.isFinite(usShort)) {
    const jp10 = cache.foreign10y.jp.current;
    crossBorder.push({
      region: 'Japan',
      foreignYield: jp10,
      foreignSource: `FRED ${cache.foreign10y.jp.seriesId} · ${cache.foreign10y.jp.frequency} (asOf ${cache.foreign10y.jp.date})`,
      usYield: ust10?.yield ?? null,
      grossPickup: ust10?.yield != null ? +(ust10.yield - jp10).toFixed(2) : null,
      hedgeCostPct: null,
      hedgeMethod: 'JPY hedge cost requires TONA — not on FRED daily; gross pickup shown',
      netHedgedPickup: null,
      hedgedUS: null,
    });
  }
  if (cache.foreign10y?.ca?.current != null) {
    const ca10 = cache.foreign10y.ca.current;
    crossBorder.push({
      region: 'Canada',
      foreignYield: ca10,
      foreignSource: `FRED ${cache.foreign10y.ca.seriesId} · ${cache.foreign10y.ca.frequency} (asOf ${cache.foreign10y.ca.date})`,
      usYield: ust10?.yield ?? null,
      grossPickup: ust10?.yield != null ? +(ust10.yield - ca10).toFixed(2) : null,
      hedgeCostPct: null,
      hedgeMethod: 'CAD hedge cost requires CORRA — not on FRED daily; gross pickup shown',
      netHedgedPickup: null,
      hedgedUS: null,
    });
  }

  // Per-asset-class numeric snapshots — 30-day frame (no jargon)
  const assets = ASSET_CLASS_DEFS.map(a => {
    const snap = a.bucket ? cache.spreads?.[a.bucket] : null;
    return {
      id: a.id,
      name: a.name,
      hint: a.hint,
      snap: snap ? {
        currentBps:   Math.round(snap.current * 100),
        avg30Bps:     Math.round(snap.avg30 * 100),
        avg90Bps:     Math.round(snap.avg90 * 100),
        vsAvg30Bps:   Math.round(snap.vsAvg30 * 100),
        rangeMin30Bps: Math.round(snap.min30 * 100),
        rangeMax30Bps: Math.round(snap.max30 * 100),
        chg1wBps:     snap.chg1w != null ? Math.round(snap.chg1w * 100) : null,
        chg1mBps:     snap.chg1m != null ? Math.round(snap.chg1m * 100) : null,
        valueLabel:   snap.valueLabel,
        valueCls:     snap.valueCls,
        asOf:         snap.asOf,
      } : null,
    };
  });

  // Compact overnight-change view of the curves — what moved last session
  const ustOvernight = Object.entries(cache.curve || {}).reduce((acc, [k, v]) => {
    if (Number.isFinite(v?.chg1d)) acc[k] = { yield: v.yield, chg1dBps: Math.round(v.chg1d * 100), priorDate: v.priorDate };
    return acc;
  }, {});
  const ecbOvernight = Object.entries(cache.ecbCurve || {}).reduce((acc, [k, v]) => {
    if (Number.isFinite(v?.chg1d)) acc[k] = { yield: v.yield, chg1dBps: Math.round(v.chg1d * 100), priorDate: v.priorDate };
    return acc;
  }, {});
  const oasOvernight = Object.entries(cache.spreads || {}).reduce((acc, [k, v]) => {
    if (Number.isFinite(v?.chg1d)) acc[k] = { currentBps: Math.round(v.current * 100), chg1dBps: Math.round(v.chg1d * 100) };
    return acc;
  }, {});

  // Compact risk-indicator view for the prompt (level + 1d / 1w deltas)
  const riskCompact = Object.entries(cache.risk || {}).reduce((acc, [k, v]) => {
    acc[k] = {
      label: v.label,
      current: v.current,
      unit: v.unit,
      chg1d: v.chg1d,
      chg1w: v.chg1w,
      chg1m: v.chg1m,
      asOf: v.asOf,
    };
    return acc;
  }, {});

  // Build a single Claude prompt that returns one JSON object with blurbs per
  // asset class, central-bank outlook, overnight color, and economic outlook — keeps cost down.
  const data = {
    asOf: new Date().toISOString().slice(0, 10),
    ust: cache.curve,
    us2s10s: us2y10s,
    impliedForwards: fwds,
    spreads: cache.spreads,
    qualityOas: cache.qualityOas,
    policyRates: cache.policyRates,
    foreign10y: cache.foreign10y,
    ecbCurve: cache.ecbCurve,
    crossBorder,
    overnight: {
      ustChg1d: ustOvernight,
      ecbChg1d: ecbOvernight,
      oasChg1d: oasOvernight,
    },
    riskIndicators: riskCompact,
    cbNewsRecent: {
      fed: (cache.cbNews?.fed || []).slice(0, 4),
      ecb: (cache.cbNews?.ecb || []).slice(0, 4),
      boe: (cache.cbNews?.boe || []).slice(0, 4),
    },
    marketNewsRecent: (cache.marketNews || []).slice(0, 30).map(h => ({
      title: h.title, source: h.source, date: h.date,
    })),
    economic: cache.economicData,
  };

  const prompt = `You are a senior fixed income strategist writing concise market color for a SALES platform read by financial advisors and end-investor clients (not bond traders). Use ONLY the data provided below — do not invent specific events not present in the news titles.

VOICE / VOCABULARY RULES (these are what makes it client-friendly):
- DO NOT use the word "percentile" or "p<number>" anywhere. Talk in plain English.
- Frame value vs the trailing 30-DAY average and 30-day range — that's the meaningful "is this a good entry now?" window for someone reviewing portfolios monthly. The 90-day average is provided for regime context if useful.
- Use phrases like "X bps wider/tighter than its 30-day average", "near the cheaper end of where it's traded the last month", "Cheap / Fair / Rich vs the recent month".
- DO cite specific bps numbers and percentages. Be concrete, not vague.
- Treat 90-day or 1y context as background regime info, not the headline.

CRITICAL OUTPUT RULES:
- Reply with ONLY the JSON object below. NO markdown code fences. NO commentary before/after.
- Use only straight ASCII double quotes for JSON strings. If you need to quote something inside a string, use single quotes.
- No trailing commas.

Schema:
{
  "assetBlurbs": {
    "ust": "2-3 sentences on US Treasury market — curve shape, last-month move, what it signals for entry today",
    "gse":  "2-3 sentences — agency spread environment, callable supply, value vs UST in the last 30 days",
    "ig-corp": "2-3 sentences — IG spreads vs 30-day average, where credit-curve value is by rating, last-month direction",
    "hy-corp": "2-3 sentences — HY spread vs 30-day frame, IG-HY compression, retail flow color",
    "muni": "2-3 sentences — muni vs UST ratio context, supply, tax-equivalent value",
    "repo": "2-3 sentences — SOFR vs Fed funds, recent repo collateral conditions"
  },
  "centralBanks": {
    "fed":  { "stance": "1 sentence on current Fed stance using the live policy rate", "implied": "1 sentence on what the UST forwards say about the rate path — in plain English", "watch": "1 specific catalyst from the news titles or upcoming events listed" },
    "ecb":  { "stance": "...", "implied": "...", "watch": "..." },
    "boe":  { "stance": "...", "implied": "...", "watch": "..." }
  },
  "overnightColor": "3-4 sentences of overnight bond-market color for a US sales desk reading this at the open. Cite the actual 1-day moves in 'overnight.ustChg1d' and 'overnight.ecbChg1d' (in bps). Mention any specific recent ECB / BoE / Fed press item from cbNewsRecent. If 'riskIndicators' shows a meaningful overnight move in oil (Brent / WTI), gold, or VIX, name it. If 'marketNewsRecent' contains a headline about geopolitics, war / Middle East / blockades, energy supply, election, or a major data print that plausibly drove the move, name it explicitly using the actual headline title. End with one sentence on cross-border relative value (US 10y vs Eurozone 10y). Plain English.",
  "economicOutlook": "5-7 sentences on the broader US economic outlook for a non-specialist client. Cover, in this order: (a) where growth and the labor market actually are based on the economic indicators provided (cite specific numbers — CPI, PCE, unemployment, NFP, GDP); (b) what the curve and forwards say the Fed is expected to do; (c) any GEOPOLITICAL or EVENT-DRIVEN risk that's currently in 'marketNewsRecent' — explicitly name the events (war in the Middle East, blockades, sanctions, energy supply disruptions, elections, fiscal/debt-ceiling fights, trade actions) IF they appear in the headlines provided, and explain how they could affect the rate path or inflation; (d) the supporting numbers from 'riskIndicators' (oil prices, gold, VIX, 10y breakevens) that confirm or contradict that risk; (e) net takeaway for a fixed income investor. Plain English, no jargon. Do not invent events not in the headlines provided."
}

DATA:
${JSON.stringify(data, null, 2)}`;

  const raw = await generateMarketColorBlurb(prompt);
  let synthesis = null;
  if (raw) {
    // Strip markdown code fences if Claude wrapped the JSON
    let cleaned = raw.replace(/^[\s\S]*?```(?:json)?\s*\n/, '').replace(/\n?```[\s\S]*$/, '').trim();
    if (!cleaned.startsWith('{')) cleaned = raw.trim();
    // Extract balanced JSON object using a depth walker (handles strings + escapes)
    const start = cleaned.indexOf('{');
    if (start >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) {
        try {
          synthesis = JSON.parse(cleaned.slice(start, end + 1));
        } catch (e) {
          console.warn('[mc] JSON parse failed:', e.message);
          // Log a 200-char window around the error position so we can see what broke
          const m = e.message.match(/position (\d+)/);
          const pos = m ? +m[1] : 0;
          console.warn('[mc] context @' + pos + ':', cleaned.slice(Math.max(0, pos - 80), pos + 80));
        }
      }
    }
    if (!synthesis) {
      // Last-resort fallback so the client always shows something — store raw text
      synthesis = { raw: raw.slice(0, 4000), parseError: true };
    }
  }

  return {
    asOf: data.asOf,
    updatedAt: new Date().toISOString(),
    ust: { curve: cache.curve, spread2s10s: us2y10s, impliedForwards: fwds },
    assets,
    qualityOas: cache.qualityOas,
    policyRates: cache.policyRates,
    foreign10y: cache.foreign10y,
    ecbCurve: cache.ecbCurve,
    crossBorder,
    cbNews: cache.cbNews,
    risk: cache.risk,
    marketNews: (cache.marketNews || []).slice(0, 20),
    synthesis,
    sources: [
      'Federal Reserve / FRED (UST CMT, SOFR, DFF, ICE BofA OAS, quality buckets, foreign 10y monthly)',
      'ECB Statistical Data Warehouse (Eurozone daily yield curve)',
      'Federal Reserve press RSS',
      'ECB press RSS',
      'Bank of England RSS',
      'Anthropic Claude (synthesis only — never replaces hard data)',
    ],
    notes: {
      foreignDailyAvailable: ['Eurozone (ECB SDW)'],
      foreignMonthlyOnly:    ['Japan', 'UK', 'Canada', 'Australia (FRED IRLTLT01* monthly)'],
      hedgeCostMethod:       'short-rate differential approximation (USD vs foreign O/N rate). Cross-currency basis swap not included; typical adjustment <10bps.',
      impliedForwardsMethod: 'derived from UST CMT curve, zero-coupon assumption — directional only.',
      bojNewsBlocked:        'BoJ press feed declines our requests; Japan policy rate from FRED only.',
    },
  };
}

let marketColorCache = { data: null, updatedAt: null };
async function getMarketColor(force = false) {
  const stale = force || !marketColorCache.data ||
                (Date.now() - new Date(marketColorCache.updatedAt)) > 6 * 60 * 60 * 1000;
  if (stale) {
    marketColorCache.data = await buildMarketColor();
    marketColorCache.updatedAt = new Date().toISOString();
  }
  return marketColorCache.data;
}

app.get('/api/public/market-color', async (_req, res) => {
  const data = await getMarketColor(false);
  res.json(data);
});
app.post('/api/internal/market-color/refresh', requireInternal, async (_req, res) => {
  const data = await getMarketColor(true);
  res.json(data);
});

// ─── Public: client-facing inventory (no markup, no dealer cost) ─────────────
app.get('/api/public/inventory', async (req, res) => {
  const internalProducts = await buildInternalProducts();
  // Strip everything that's internal-desk-only: markup, dealer $/bond, street ranges
  const products = internalProducts.map(p => ({
    id: p.id,
    cat: p.cat,
    name: p.name,
    sub: p.sub,
    note: p.note,
    valueLabel: p.valueLabel,
    valueCls: p.valueCls,
    maturityLadder: (p.maturityLadder || []).map(r => ({
      label: r.label,
      coupon: r.coupon,
      ustYield: r.ustYield,
      customerYield: r.customerYield,
      spreadBps: r.spreadBps,
      spreadAvg30Bps: r.spreadAvg30Bps,
      vsAvg30Bps: r.vsAvg30Bps,
      vsAvg30Label: r.vsAvg30Label,
      valueLabel: r.valueLabel,
      valueCls: r.valueCls,
      spreadSource: r.spreadSource,
      spreadLive: r.spreadLive,
      customerYieldLabel: r.customerYieldLabel,
      couponLabel: r.couponLabel,
      spreadLabel: r.spreadLabel,
    })),
  }));

  // Real per-CUSIP offerings: today's FHLB settlements + upcoming Treasury auctions
  const issues = await fetchAllNewIssues();
  const offerings = issues.map(i => ({
    source: i.source,
    cusip: i.cusip,
    issuer: i.issuer,
    series: i.series,
    type: i.type,
    callable: i.callable,
    callStructure: i.callStructure,
    callSchedule: i.callSchedule,
    issued: i.issued,
    maturity: i.maturity,
    auctionDate: i.auctionDate,
    tenorYrs: i.tenorYrs,
    coupon: i.coupon,
    price: i.price,
    size: i.size,
    ustBenchmark: i.ustBenchmark,
    spreadBps: i.spreadBps,
    upcoming: i.upcoming || false,
    couponLabel: i.couponLabel,
    sizeLabel: i.sizeLabel,
    spreadLabel: i.spreadLabel,
    // Customer-paid yield: par-issue → YTM = coupon (placeholder for real offer-side prices)
    customerYield: Number.isFinite(i.coupon) ? +i.coupon.toFixed(2) : null,
    customerYieldLabel: Number.isFinite(i.coupon) ? `${i.coupon.toFixed(2)}%` : 'TBD',
  }));

  res.json({
    products,
    offerings,
    curve: cache.curve,
    sources: ['FHLB Office of Finance', 'TreasuryDirect', 'FRED ICE BofA OAS', 'FRED Treasury CMT'],
    updatedAt: new Date().toISOString(),
    disclaimer: 'Indicative levels only. Per-CUSIP execution prices and yields are determined at trade time and may differ from displayed values.',
  });
});

// Internal only: full spread + markup reference data
app.get('/api/internal/products', requireInternal, async (req, res) => {
  const products = await buildInternalProducts();
  res.json({ products, updatedAt: new Date().toISOString(), spreads: cache.spreads });
});

// ─── TRACE: real Treasury auctions + live OAS-derived corp prints ────────────
async function fetchTreasuryAuctions() {
  try {
    const res = await fetch('https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json');
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(a => ['Bill', 'Note', 'Bond', 'TIPS', 'FRN'].includes(a.securityType))
      .filter(a => a.auctionDate)
      .sort((a, b) => new Date(b.auctionDate) - new Date(a.auctionDate))
      .slice(0, 12)
      .map(a => {
        const price = parseFloat(a.pricePer100);
        let y = parseFloat(a.highYield);
        if (!Number.isFinite(y)) y = parseFloat(a.highInvestmentRate);
        if (!Number.isFinite(y)) y = parseFloat(a.interestRate);
        return {
          cusip: a.cusip || '—',
          issuer: `US Treasury ${a.securityType}`,
          type: a.securityTerm || a.securityType,
          par: 1000000,
          price: Number.isFinite(price) ? price : 100,
          yield: Number.isFinite(y) ? y : 0,
          time: (a.auctionDate || '').slice(0, 10),
          source: 'TreasuryDirect (live)'
        };
      });
  } catch (e) {
    console.error('[trace] TreasuryDirect fetch failed:', e.message);
    return [];
  }
}

function liveOasCorpPrints() {
  if (!cache.spreads || !cache.curve) return [];
  const issuers = [
    { name: 'JPM 4.50% 2030',  cusip: '46625HJL2', bucket: 'ig-5to7',   tenor: '5yr',  par: 2000000 },
    { name: 'AAPL 4.10% 2031', cusip: '037833DR9', bucket: 'ig-7to10',  tenor: '7yr',  par: 1500000 },
    { name: 'MSFT 3.75% 2034', cusip: '594918BV6', bucket: 'ig-7to10',  tenor: '10yr', par: 1000000 },
    { name: 'XOM 4.85% 2044',  cusip: '30231GBT2', bucket: 'ig-15plus', tenor: '20yr', par: 750000  },
    { name: 'BAC 5.20% 2028',  cusip: '06051GKD7', bucket: 'ig-3to5',   tenor: '3yr',  par: 2500000 },
    { name: 'F 7.35% 2030',    cusip: '345370CR9', bucket: 'hy',        tenor: '5yr',  par: 500000  },
    { name: 'CCL 6.00% 2029',  cusip: '143658BR3', bucket: 'hy',        tenor: '5yr',  par: 350000  },
  ];
  const now = Date.now();
  return issuers.map((b, i) => {
    const ust = cache.curve[b.tenor]?.yield ?? 4.20;
    const oas = cache.spreads[b.bucket]?.current ?? 1.00;
    const y = +(ust + oas).toFixed(2);
    // Approximate price for a par-coupon bond at this yield (simple)
    const px = +(100 - (y - 4.5) * 2.5).toFixed(3);
    const t = new Date(now - i * 11 * 60 * 1000);
    return {
      cusip: b.cusip,
      issuer: b.name,
      type: b.bucket.startsWith('ig') ? 'IG Corp' : 'HY Corp',
      par: b.par,
      price: px,
      yield: y,
      time: t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      source: `Live FRED ${cache.spreads[b.bucket] ? 'OAS-derived' : 'modeled'}`
    };
  });
}

async function buildTracePrints() {
  const [tsy, corps] = [await fetchTreasuryAuctions(), liveOasCorpPrints()];
  return [...tsy, ...corps];
}

app.get('/api/internal/trace', requireInternal, async (req, res) => {
  const stale = !cache.trace || !cache.traceUpdated ||
                (Date.now() - new Date(cache.traceUpdated)) > 600000;
  if (stale) {
    cache.trace = await buildTracePrints();
    cache.traceUpdated = new Date().toISOString();
  }
  res.json({ items: cache.trace, updatedAt: cache.traceUpdated });
});

// Internal only: force refresh outlook
app.post('/api/internal/outlook/refresh', requireInternal, async (req, res) => {
  await Promise.all([fetchCurve(), fetchEconomicData()]);
  const outlook = await generateOutlook();
  res.json(outlook);
});

// Internal only: full economic data
app.get('/api/internal/econ/full', requireInternal, async (req, res) => {
  if (!cache.economicData) await fetchEconomicData();
  res.json({ data: cache.economicData, curve: cache.curve, updatedAt: cache.economicUpdated });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Cron: refresh curve every hour, outlook every Monday 6am ─────────────────
cron.schedule('0 * * * *', async () => {
  await fetchCurve();
  await fetchEconomicData();
  await fetchSpreads();
  await fetchQualityOas();
  await fetchPolicyRates();
  await fetchEcbCurve();
  await fetchForeignBenchmarks();
  await fetchCentralBankNews();
  await fetchMarketNews();
  await fetchRiskIndicators();
});

// Refresh AI-generated market color blurbs once per day (Claude cost control)
cron.schedule('0 7 * * *', async () => {
  await getMarketColor(true);
});

cron.schedule('0 6 * * 1', async () => {
  await generateOutlook();
});

// ─── Initial data load on startup ─────────────────────────────────────────────
(async () => {
  console.log('[startup] Loading initial data...');
  await fetchCurve();
  await fetchEconomicData();
  await fetchSpreads();
  await fetchQualityOas();
  await fetchPolicyRates();
  await fetchEcbCurve();
  await fetchForeignBenchmarks();
  await fetchCentralBankNews();
  await fetchMarketNews();
  await fetchRiskIndicators();
  await generateOutlook();
  console.log('[startup] Ready.');
})();

app.listen(PORT, () => {
  console.log(`BD Platform backend running on port ${PORT}`);
});
