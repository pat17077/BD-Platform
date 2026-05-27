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
app.use(express.urlencoded({ extended: false }));

const deskAuth = require('./desk-auth');

// Serve both UIs from the same server so the user can open
//   http://localhost:3001/        → internal desk
//   http://localhost:3001/client  → public client view
// ─── Page auth (desk / client) ───────────────────────────────────────────────
app.get('/login', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(deskAuth.deskLoginHTML());
});
app.post('/login', (req, res) => {
  const role = deskAuth.verifyDeskLogin(req.body.username, req.body.password);
  if (!role) {
    return res.status(401).set('Content-Type', 'text/html; charset=utf-8')
      .send(deskAuth.deskLoginHTML('Invalid username or password'));
  }
  deskAuth.setCookie(res, role);
  res.redirect('/');
});
app.get('/client/login', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(deskAuth.clientLoginHTML());
});
app.post('/client/login', (req, res) => {
  const role = deskAuth.verifyClientLogin(req.body.username, req.body.password);
  if (!role) {
    return res.status(401).set('Content-Type', 'text/html; charset=utf-8')
      .send(deskAuth.clientLoginHTML('Invalid username or password'));
  }
  deskAuth.setCookie(res, role);
  res.redirect('/client');
});
app.get('/logout', (_req, res) => {
  deskAuth.clearCookie(res);
  res.redirect('/login');
});

app.get('/', deskAuth.requireDeskPage, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/client', deskAuth.requireClientPage, (_req, res) => res.sendFile(path.join(__dirname, 'client.html')));

const FRED_API_KEY = process.env.FRED_API_KEY || 'YOUR_FRED_API_KEY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';
// Anthropic model selection — default to Haiku 4.5 (~10x cheaper than Sonnet)
// for summarization-style workloads. Override via env to use Sonnet if you
// want more polish.
const ANTHROPIC_MODEL_OUTLOOK      = process.env.ANTHROPIC_MODEL_OUTLOOK      || 'claude-haiku-4-5-20251001';
const ANTHROPIC_MODEL_MARKET_COLOR = process.env.ANTHROPIC_MODEL_MARKET_COLOR || 'claude-haiku-4-5-20251001';
const DISABLE_AI = process.env.DISABLE_AI === '1' || process.env.DISABLE_AI === 'true';
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
// Daily FX spot. Direction conventions vary on FRED — we normalize to "USD per
// 1 unit of foreign currency" downstream so 1 EUR = $X (always > 0, intuitive).
const FX_SERIES = {
  'EUR': { id: 'DEXUSEU', invert: false, label: 'EUR/USD' },  // already USD per EUR
  'GBP': { id: 'DEXUSUK', invert: false, label: 'GBP/USD' },  // already USD per GBP
  'NOK': { id: 'DEXNOUS', invert: true,  label: 'NOK/USD' },  // FRED is NOK per USD → invert
  'CHF': { id: 'DEXSZUS', invert: true,  label: 'CHF/USD' },  // FRED is CHF per USD → invert
  'JPY': { id: 'DEXJPUS', invert: true,  label: 'JPY/USD' },
  'CAD': { id: 'DEXCAUS', invert: true,  label: 'CAD/USD' },
};

const FOREIGN_10Y_SERIES = {
  'jp': { label: 'Japan 10y JGB',  id: 'IRLTLT01JPM156N', frequency: 'monthly' },
  'uk': { label: 'UK 10y Gilt',    id: 'IRLTLT01GBM156N', frequency: 'monthly' },
  'ca': { label: 'Canada 10y',     id: 'IRLTLT01CAM156N', frequency: 'monthly' },
  'au': { label: 'Australia 10y',  id: 'IRLTLT01AUM156N', frequency: 'monthly' },
};

// Risk-sentiment / commodity / vol series. Mix of FRED (daily) and Yahoo (free).
// Oil = direct geopolitical proxy; gold = risk-off; MOVE = Treasury option-implied
// vol (THE bond-market equivalent of MOVE — far more relevant for FI than MOVE);
// breakevens = market inflation expectations.
const RISK_SERIES = {
  'brent':       { source:'fred',  label: 'Brent crude',                id: 'DCOILBRENTEU',     unit: '$' },
  'wti':         { source:'fred',  label: 'WTI crude',                  id: 'DCOILWTICO',       unit: '$' },
  'gold':        { source:'yahoo', label: 'Gold (COMEX front-month)',   id: 'GC=F',             unit: '$' },
  'move':        { source:'yahoo', label: 'MOVE Index (Treasury vol)',  id: '^MOVE',            unit: ''  },
  'breakeven10': { source:'fred',  label: '10y breakeven inflation',    id: 'T10YIE',           unit: '%' },
  'breakeven5':  { source:'fred',  label: '5y breakeven inflation',     id: 'T5YIE',            unit: '%' },
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
// Hard 8s timeout per attempt → max ~24s total for 3 attempts, never hangs forever.
// If FRED returns an Akamai HTML error page (rate-limit / region-block), bail fast.
async function fetchFredSeries(seriesId, limit = 3, attempt = 1) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 8000 });
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const text = await res.text();
    // Akamai / FRED error pages come back as HTML — short-circuit instead of trying to parse
    if (text.startsWith('<') || ct.includes('text/html')) {
      if (attempt < 3) {
        console.warn(`[fred] ${seriesId} got HTML error (try ${attempt}) — retrying`);
        await new Promise(r => setTimeout(r, 600 * attempt));
        return fetchFredSeries(seriesId, limit, attempt + 1);
      }
      console.warn(`[fred] ${seriesId} got HTML error after retries — likely Akamai block. Skipping.`);
      return null;
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      console.warn(`[fred] ${seriesId} JSON parse failed:`, e.message);
      return null;
    }
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
// ─── Fetch FX spot rates (daily, FRED) ──────────────────────────────────────
async function fetchFxRates() {
  console.log('[fx] Fetching FX spot rates...');
  const result = {};
  for (const [code, info] of Object.entries(FX_SERIES)) {
    try {
      const obs = await fetchFredSeries(info.id, 30);
      const stats = summarizeSeries(obs);
      if (stats) {
        // Normalize to "USD per 1 unit of <code>" — large/small number sanity
        const usdPer = info.invert ? (1 / stats.current) : stats.current;
        const usdPerPrior = info.invert ? (1 / (stats.priorDay ?? stats.current)) : (stats.priorDay ?? stats.current);
        result[code] = {
          code,
          label: info.label,
          seriesId: info.id,
          inverted: info.invert,
          usdPer: +usdPer.toFixed(6),
          chg1d: +(usdPer - usdPerPrior).toFixed(6),
          asOf: stats.asOf,
          // 30-day stats on the normalized rate
          avg30: info.invert ? +(1 / stats.avg30).toFixed(6) : +stats.avg30.toFixed(6),
        };
      }
    } catch (e) {
      console.error(`[fx] Failed ${code}:`, e.message);
    }
  }
  cache.fx = result;
  cache.fxUpdated = new Date().toISOString();
  console.log('[fx] Updated:', Object.keys(result).length, 'pairs');
  return result;
}

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

// Fetch a daily series from Yahoo Finance over an arbitrary range. Returns
// {date, value}[] with nulls/holidays filtered out. Used for both summary
// stats (fetchYahooQuote) and the MOVE sparkline / percentile endpoint.
async function fetchYahooSeries(symbol, range = '2mo') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' }, timeout: 8000 });
    if (!res.ok) { console.warn(`[yahoo] ${symbol} HTTP ${res.status}`); return null; }
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const closes = r.indicators?.quote?.[0]?.close || [];
    const ts = r.timestamp || [];
    const out = [];
    for (let i = 0; i < closes.length; i++) {
      if (Number.isFinite(closes[i]) && ts[i]) {
        out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: closes[i] });
      }
    }
    return out;
  } catch (e) {
    console.warn(`[yahoo] ${symbol} series fetch failed:`, e.message);
    return null;
  }
}

// Fetch a daily quote from Yahoo Finance (free, no auth) — used for symbols
// that aren't on FRED, e.g. ^MOVE (ICE BofA MOVE Index — bond-market option
// vol, the FI equivalent of VIX).
async function fetchYahooQuote(symbol, lookbackDays = 60) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2mo`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SpreadDesk/1.0' }, timeout: 8000 });
    if (!res.ok) { console.warn(`[yahoo] ${symbol} HTTP ${res.status}`); return null; }
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => Number.isFinite(v));
    const ts = r.timestamp || [];
    if (closes.length === 0) return null;
    const current = closes[closes.length - 1];
    const lookback = (n) => closes[Math.max(0, closes.length - 1 - n)];
    const win30 = closes.slice(-30);
    const avg30 = win30.reduce((a, b) => a + b, 0) / win30.length;
    const min30 = Math.min(...win30), max30 = Math.max(...win30);
    return {
      current: +current.toFixed(3),
      avg30:   +avg30.toFixed(3),
      min30:   +min30.toFixed(3),
      max30:   +max30.toFixed(3),
      asOf:    ts[ts.length - 1] ? new Date(ts[ts.length - 1] * 1000).toISOString().slice(0, 10) : null,
      chg1d:   +((current - lookback(1))  || 0).toFixed(3),
      chg1w:   +((current - lookback(5))  || 0).toFixed(3),
      chg1m:   +((current - lookback(21)) || 0).toFixed(3),
    };
  } catch (e) {
    console.warn(`[yahoo] ${symbol} fetch failed:`, e.message);
    return null;
  }
}

// ─── Fetch risk-sentiment / commodity indicators ────────────────────────────
async function fetchRiskIndicators() {
  console.log('[risk] Fetching risk indicators (oil, gold, MOVE, breakevens)...');
  const result = {};
  for (const [k, info] of Object.entries(RISK_SERIES)) {
    try {
      let stats = null;
      if (info.source === 'yahoo') {
        stats = await fetchYahooQuote(info.id);
      } else {
        const obs = await fetchFredSeries(info.id, 30);
        stats = summarizeSeries(obs);
      }
      if (stats) result[k] = { ...stats, label: info.label, unit: info.unit, seriesId: info.id, source: info.source };
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

// Synchronous: works on whatever's in cache. Caller must ensure caches are
// populated via cron / startup. Triggers background refresh if cold but does
// NOT block on it.
function buildInternalProducts() {
  if (!cache.curve)   _bgRefresh('curve', fetchCurve);
  if (!cache.spreads) _bgRefresh('spreads', fetchSpreads);
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
      const couponRaw = parseFloat(b.COUPON);
      // Reject obvious misparses: real FHLB coupons sit in 0.5%–15%. Step-up bonds
      // report only their first-period (often near-zero) coupon, which leaked into
      // the money-market endpoint as bogus 0.01% discount rates. Drop coupon for
      // those — the bond still appears as a callable in the inventory, just without
      // a meaningful YTW/discount calc.
      const coupon = (Number.isFinite(couponRaw) && couponRaw >= 0.5 && couponRaw <= 15)
        ? couponRaw : null;
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
        couponLabel: Number.isFinite(coupon) ? `${coupon.toFixed(2)}%`
                   : Number.isFinite(couponRaw) ? `${couponRaw.toFixed(2)}% (step/floater)`
                   : '—',
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
      // Floater detection — accept SOFR, FED FUNDS / FF, PRIME, TBILL with either
      // +spread or -spread (Prime can quote either side). The earlier regex only
      // accepted "+" and missed "FF" and "PRIME-…" — leaving them to fall through
      // to parseFloat which produced false coupons like 0.035 from spread digits.
      const floaterMatch = r.couponRaw.match(/^\s*(SOFR|SOFR30A|FED|FF|FFER|PRIME|T-BILL|TBILL)\s*([+-])\s*([0-9.]+)/i);
      let coupon = null, couponLabel = r.couponRaw, floater = null;
      if (floaterMatch) {
        const idxRaw = floaterMatch[1].toUpperCase();
        const idx = (idxRaw === 'FF' || idxRaw === 'FFER') ? 'FED'
                  : (idxRaw === 'T-BILL') ? 'TBILL'
                  : idxRaw;
        const sign = floaterMatch[2] === '-' ? -1 : 1;
        floater = { index: idx, spreadBps: sign * +floaterMatch[3] };
        couponLabel = `${idx}${sign > 0 ? '+' : ''}${floater.spreadBps} bps`;
      } else {
        const num = parseFloat(r.couponRaw);
        // Reject obvious misparses: real agency coupons are between 0.5% and 15%.
        // A "0.035" coupon is from a row where the cell contained just a spread
        // value ("FF+3.5" being parsed as " 3.5" after a regex miss → 0.035 once
        // we divide by some unintended factor) — better to drop the row than show
        // 0.034% as a discount rate downstream.
        if (Number.isFinite(num) && num >= 0.5 && num <= 15) {
          coupon = num;
          couponLabel = `${num.toFixed(3)}%`;
        }
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

let newIssuesCache = { items: null, updatedAt: null, populating: false };

function _bgPopulateNewIssues() {
  if (newIssuesCache.populating) return;
  newIssuesCache.populating = true;
  fetchAllNewIssues()
    .then(items => { newIssuesCache.items = items; newIssuesCache.updatedAt = new Date().toISOString(); })
    .catch(e => console.warn('[new-issues] background populate failed:', e.message))
    .finally(() => { newIssuesCache.populating = false; });
}

app.get('/api/internal/new-issues', requireInternal, (req, res) => {
  const stale = !newIssuesCache.items || !newIssuesCache.updatedAt ||
                (Date.now() - new Date(newIssuesCache.updatedAt)) > 30 * 60 * 1000;
  if (stale) _bgPopulateNewIssues();
  res.json({
    items: newIssuesCache.items || [],
    sources: ['FHLB Office of Finance', 'FFCB (Federal Farm Credit Banks)', 'TreasuryDirect'],
    updatedAt: newIssuesCache.updatedAt,
    stale: !newIssuesCache.updatedAt,
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

  if (DISABLE_AI) {
    console.log('[outlook] DISABLE_AI=1 — skipping Claude call, using cached/placeholder outlook');
    cache.outlook = cache.outlook || { text: '(AI disabled)', generatedAt: new Date().toISOString() };
    return cache.outlook;
  }

  console.log('[outlook] Generating AI outlook via Claude (model: ' + ANTHROPIC_MODEL_OUTLOOK + ')...');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL_OUTLOOK,
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
// All GET endpoints are non-blocking: serve cache, populate in background if cold.

// Track which background populates are in-flight so we don't queue duplicates
const _bgFetching = new Set();
function _bgRefresh(name, fn) {
  if (_bgFetching.has(name)) return;
  _bgFetching.add(name);
  fn().catch(e => console.warn(`[${name}] background populate failed:`, e.message))
      .finally(() => _bgFetching.delete(name));
}

// Public: Treasury yield curve
app.get('/api/curve', (req, res) => {
  const stale = !cache.curve || !cache.curveUpdated || (Date.now() - new Date(cache.curveUpdated)) > 3600000;
  if (stale) _bgRefresh('curve', fetchCurve);
  res.json({ curve: cache.curve || {}, updatedAt: cache.curveUpdated, stale });
});

// Public: Economic indicators
app.get('/api/econ', (req, res) => {
  const stale = !cache.economicData || !cache.economicUpdated || (Date.now() - new Date(cache.economicUpdated)) > 3600000;
  if (stale) _bgRefresh('econ', fetchEconomicData);
  res.json({ data: cache.economicData || {}, updatedAt: cache.economicUpdated, stale });
});

// Public: AI economic outlook (refreshed weekly)
app.get('/api/outlook', (req, res) => {
  const oneWeek = 7 * 24 * 3600000;
  const stale = !cache.outlook || !cache.outlookUpdated || (Date.now() - new Date(cache.outlookUpdated)) > oneWeek;
  if (stale) _bgRefresh('outlook', generateOutlook);
  if (!cache.outlook) return res.json({ text: '', stale: true, generatedAt: null });
  res.json(cache.outlook);
});

// ─── Discount note / money-market math ───────────────────────────────────────
// Convert between: discount rate (Act/360 on face), price, money-market yield
// (Act/360 on price), and bond-equivalent yield (Act/365 on price).
// Convention reference: SIFMA Standard Securities Calculation Methods.
function mmFromPrice(price, days, face = 100) {
  if (!Number.isFinite(price) || !Number.isFinite(days) || days <= 0) return null;
  const interest = face - price;
  return {
    face,
    days,
    price: +price.toFixed(6),
    discountRate: +((interest / face) * (360 / days)).toFixed(6),
    mmy:          +((interest / price) * (360 / days)).toFixed(6),
    bey:          +((interest / price) * (365 / days)).toFixed(6),
    interest:     +interest.toFixed(6),
  };
}
function mmFromDiscountRate(dr, days, face = 100) {
  if (!Number.isFinite(dr) || !Number.isFinite(days) || days <= 0) return null;
  // P = F × (1 − DR × N / 360)
  return mmFromPrice(face * (1 - dr * days / 360), days, face);
}
function mmFromMMY(mmy, days, face = 100) {
  if (!Number.isFinite(mmy) || !Number.isFinite(days) || days <= 0) return null;
  // MMY = (F − P) / P × 360 / N  →  P = F / (1 + MMY × N / 360)
  return mmFromPrice(face / (1 + mmy * days / 360), days, face);
}
function mmFromBEY(bey, days, face = 100) {
  if (!Number.isFinite(bey) || !Number.isFinite(days) || days <= 0) return null;
  return mmFromPrice(face / (1 + bey * days / 365), days, face);
}

// Public: money-market yield converter — accept input in any of 4 conventions
app.post('/api/mm/convert', (req, res) => {
  const { face = 100, days, mode, value } = req.body || {};
  if (!Number.isFinite(+days) || +days <= 0) return res.status(400).json({ error: 'days must be a positive number' });
  if (!Number.isFinite(+value)) return res.status(400).json({ error: 'value must be numeric' });
  const v = +value, n = +days, f = +face;
  let result = null;
  switch (mode) {
    case 'price':         result = mmFromPrice(v, n, f); break;
    case 'discountRate':  result = mmFromDiscountRate(v / 100, n, f); break;
    case 'mmy':           result = mmFromMMY(v / 100, n, f); break;
    case 'bey':           result = mmFromBEY(v / 100, n, f); break;
    default: return res.status(400).json({ error: 'mode must be price | discountRate | mmy | bey' });
  }
  if (!result) return res.status(400).json({ error: 'Conversion failed — check inputs' });
  // Format yields back to percentage
  res.json({
    face: result.face,
    days: result.days,
    price: result.price,
    discountRatePct: +(result.discountRate * 100).toFixed(4),
    mmyPct:          +(result.mmy * 100).toFixed(4),
    beyPct:          +(result.bey * 100).toFixed(4),
    interestPer100:  result.interest,
  });
});

// Public: money-market instrument inventory — T-bills today + GSE discos when scrapable
app.get('/api/public/money-market', (_req, res) => {
  // Use cached new-issues; populate in background if cold
  if (!newIssuesCache.items) _bgPopulateNewIssues();
  const all = newIssuesCache.items || [];
  const itemsRaw = all
    .filter(i => i.tenorYrs != null && i.tenorYrs <= 1.05)        // ≤ ~12 months
    .map(i => {
      const issued = i.issued || i.auctionDate;
      const days = (issued && i.maturity)
        ? Math.round((new Date(i.maturity) - new Date(issued)) / 86400000)
        : (i.tenorYrs != null ? Math.round(i.tenorYrs * 365.25) : null);
      // For zero-coupon bills, derive price/yields from known auction yield if present
      let calc = null;
      if (Number.isFinite(i.coupon) && days != null && i.coupon > 0) {
        // Some Bills come back with the high investment rate populated as "coupon" — that's a BEY proxy
        calc = mmFromBEY(i.coupon / 100, days);
      }
      return {
        source: i.source,
        cusip: i.cusip,
        issuer: i.issuer,
        type: i.type,
        series: i.series,
        issued, maturity: i.maturity,
        days,
        tenorYrs: i.tenorYrs,
        size: i.size,
        sizeLabel: i.sizeLabel,
        beyPct: calc ? +(calc.bey * 100).toFixed(3) : null,
        mmyPct: calc ? +(calc.mmy * 100).toFixed(3) : null,
        discountRatePct: calc ? +(calc.discountRate * 100).toFixed(3) : null,
        pricePer100: calc ? calc.price : null,
        upcoming: !!i.upcoming,
      };
    })
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
  // Only ship rows where we have at least one computed yield — empty "—" rows
  // are noise (floaters with no fixed-rate equivalent, or pre-auction T-bills
  // where the high-yield isn't published yet).
  const items = itemsRaw.filter(i => i.beyPct != null);
  res.json({
    items,
    omitted: itemsRaw.length - items.length,
    sources: ['TreasuryDirect (T-bills)', 'FHLB OF (term debt where ≤12mo)', 'FFCB (term debt where ≤12mo)'],
    notes: {
      conventions: 'Discount Rate = Act/360 on face; Money Market Yield (MMY) = Act/360 on price; Bond Equivalent Yield (BEY) = Act/365 on price.',
    },
    updatedAt: new Date().toISOString(),
  });
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
async function generateMarketColorBlurb(prompt, attempt = 1) {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.startsWith('YOUR_')) {
    console.warn('[mc] No Anthropic API key — synthesis disabled');
    return null;
  }
  try {
    // 90s timeout — Claude synthesis with this prompt typically takes 30-60s
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL_MARKET_COLOR,
        max_tokens: 5000,        // structured response with 5 asset blurbs + 3 CB outlooks + overnight + economic + tradeIdeas needs the room
        messages: [{ role: 'user', content: prompt }],
      }),
      timeout: 180000,           // 3 min — Claude streams full output in ~60-90s typical
    });
    const data = await res.json();
    if (data.error) {
      console.error('[mc] Claude API error:', data.error.type, data.error.message);
      // Retry once on rate-limit / overload
      if (attempt < 2 && (data.error.type === 'overloaded_error' || data.error.type === 'rate_limit_error')) {
        await new Promise(r => setTimeout(r, 5000));
        return generateMarketColorBlurb(prompt, attempt + 1);
      }
      return null;
    }
    const text = data?.content?.[0]?.text?.trim();
    if (!text) console.warn('[mc] Claude returned empty content:', JSON.stringify(data).slice(0, 200));
    return text || null;
  } catch (e) {
    // Auto-retry once on transient network errors (ETIMEDOUT / ECONNRESET / network timeout)
    const transient = /ETIMEDOUT|ECONNRESET|network timeout|EAI_AGAIN|socket hang up/i.test(e.message || '');
    if (transient && attempt < 2) {
      console.warn(`[mc] Claude transient error (try ${attempt}): ${e.message} — retrying once`);
      await new Promise(r => setTimeout(r, 3000));
      return generateMarketColorBlurb(prompt, attempt + 1);
    }
    console.error('[mc] Claude blurb call failed:', e.message);
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
  if (DISABLE_AI) {
    console.log('[mc] DISABLE_AI=1 — skipping Claude call');
    return { synthesis: null, generatedAt: new Date().toISOString(), disabled: true };
  }
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
  if (!cache.fx) await fetchFxRates();

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
  "overnightColor": "3-4 sentences of overnight bond-market color for a US sales desk reading this at the open. Cite the actual 1-day moves in 'overnight.ustChg1d' and 'overnight.ecbChg1d' (in bps). Mention any specific recent ECB / BoE / Fed press item from cbNewsRecent. If 'riskIndicators' shows a meaningful overnight move in oil (Brent / WTI), gold, or MOVE, name it. If 'marketNewsRecent' contains a headline about geopolitics, war / Middle East / blockades, energy supply, election, or a major data print that plausibly drove the move, name it explicitly using the actual headline title. End with one sentence on cross-border relative value (US 10y vs Eurozone 10y). Plain English.",
  "economicOutlook": "5-7 sentences on the broader US economic outlook for a non-specialist client. Cover, in this order: (a) where growth and the labor market actually are based on the economic indicators provided (cite specific numbers — CPI, PCE, unemployment, NFP, GDP); (b) what the curve and forwards say the Fed is expected to do; (c) any GEOPOLITICAL or EVENT-DRIVEN risk that's currently in 'marketNewsRecent' — explicitly name the events (war in the Middle East, blockades, sanctions, energy supply disruptions, elections, fiscal/debt-ceiling fights, trade actions) IF they appear in the headlines provided, and explain how they could affect the rate path or inflation; (d) the supporting numbers from 'riskIndicators' (oil prices, gold, MOVE, 10y breakevens) that confirm or contradict that risk; (e) net takeaway for a fixed income investor. Plain English, no jargon. Do not invent events not in the headlines provided.",
  "tradeIdeas": "Write this as a senior sales trader to their team. INTERNAL-FACING — be opinionated and specific, not balanced. Produce 3-5 numbered trade ideas in this exact JSON-array form inside the string (one entry per line, separated by '\\n'): '1) <trade>: <thesis with specific bps numbers>. Risk: <one sentence>.' Each idea must reference real numbers from the data (curve, OAS by maturity bucket, quality OAS by rating, forwards, oil/MOVE/breakevens, cross-border). At least one idea should be a relative-value pair trade (e.g., long X / short Y) citing the spread differential. At least one should reference a specific catalyst from marketNewsRecent or upcoming central-bank events. At least one should call out where the desk has natural axe given current FHLB / FFCB / Treasury new-issue characteristics if that's visible. Be concrete: 'Buy 5-7y IG at +80bp vs sell 10-15y IG at +92bp — 12bp roll-down + tighter percentile makes this a 6-8bp pickup over 3 months' rather than 'IG looks attractive'. End with a one-line bottom-line takeaway prefixed 'BOTTOM LINE:'."
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

// Strip internal-only fields (tradeIdeas) from synthesis before returning publicly.
function stripInternalSynthesis(mc) {
  if (!mc) return mc;
  const out = { ...mc };
  if (mc.synthesis) {
    const { tradeIdeas, ...rest } = mc.synthesis;
    out.synthesis = rest;
  }
  return out;
}

// GETs are non-blocking — serve cache, populate in background if cold.
// (The POST refresh below is intentionally blocking — explicit user action.)
function _bgPopulateMarketColor() {
  if (marketColorCache.populating) {
    // Defensive: clear stuck flag if stuck > 5 minutes
    if (marketColorCache.populatingSince &&
        Date.now() - marketColorCache.populatingSince > 5 * 60 * 1000) {
      console.warn('[mc] populating flag stuck > 5 min — clearing and retrying');
      marketColorCache.populating = false;
    } else {
      return;
    }
  }
  marketColorCache.populating = true;
  marketColorCache.populatingSince = Date.now();
  console.log('[mc] starting buildMarketColor...');
  // Hard outer timeout so we can never hang indefinitely even if Claude socket dangles
  const HARD_TIMEOUT_MS = 4 * 60 * 1000;
  Promise.race([
    buildMarketColor(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('outer hard timeout (4min)')), HARD_TIMEOUT_MS)),
  ])
    .then(d => {
      console.log('[mc] buildMarketColor finished, synthesis:', d?.synthesis ? 'present' : 'null');
      marketColorCache.data = d;
      marketColorCache.updatedAt = new Date().toISOString();
    })
    .catch(e => console.warn('[mc] background populate failed:', e.message))
    .finally(() => {
      marketColorCache.populating = false;
      marketColorCache.populatingSince = null;
    });
}
app.get('/api/public/market-color', (_req, res) => {
  if (!marketColorCache.data) _bgPopulateMarketColor();
  const data = marketColorCache.data || { synthesis: null, assets: [], crossBorder: [], updatedAt: null, stale: true };
  res.json(stripInternalSynthesis(data));
});
app.get('/api/internal/market-color', requireInternal, (_req, res) => {
  if (!marketColorCache.data) _bgPopulateMarketColor();
  res.json(marketColorCache.data || { synthesis: null, assets: [], crossBorder: [], updatedAt: null, stale: true });
});
app.post('/api/internal/market-color/refresh', requireInternal, (_req, res) => {
  // Kick off regeneration in background; return immediately with the previous cache.
  // The frontend can poll /api/internal/market-color to see the new synthesis arrive.
  _bgPopulateMarketColor();
  res.json({
    refreshing: true,
    previous: marketColorCache.data || null,
    note: 'Synthesis regenerating in background (typically 30–60s). Poll /api/internal/market-color for the updated payload.',
  });
});

// ─── Public: MOVE index 1y history (sparkline + percentile) ─────────────────
const _moveCache = { series: null, updatedAt: null, populating: false };
function _bgPopulateMoveHistory() {
  if (_moveCache.populating) return;
  _moveCache.populating = true;
  fetchYahooSeries('^MOVE', '1y')
    .then(series => {
      if (!series || !series.length) return;
      _moveCache.series = series;
      _moveCache.updatedAt = new Date().toISOString();
    })
    .catch(e => console.warn('[move-history] failed:', e.message))
    .finally(() => { _moveCache.populating = false; });
}
app.get('/api/public/move/history', (_req, res) => {
  const stale = !_moveCache.series || !_moveCache.updatedAt ||
                (Date.now() - new Date(_moveCache.updatedAt)) > 6 * 3600 * 1000;
  if (stale) _bgPopulateMoveHistory();
  const series = _moveCache.series || [];
  if (series.length === 0) {
    return res.json({ series: [], stale: true, updatedAt: _moveCache.updatedAt });
  }
  const values = series.map(p => p.value);
  const current = values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted.filter(v => v < current).length;
  const pctRank = Math.round((lower / sorted.length) * 100);
  res.json({
    series,
    current: +current.toFixed(2),
    min1y: +sorted[0].toFixed(2),
    max1y: +sorted[sorted.length - 1].toFixed(2),
    avg1y: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    pctRank1y: pctRank,
    n: values.length,
    updatedAt: _moveCache.updatedAt,
  });
});

// ─── Client RFQs + Messages — in-memory queues for the demo (real product
// needs persistence + per-client auth + WebSocket to the desk). Each queue is
// a ring buffer capped at 200 items. Desk reads via /api/internal/* endpoints.
let _rfqQueue = [];
let _messageQueue = [];

app.post('/api/client/rfq', (req, res) => {
  const { cusip, issuer, size, settle, notes, clientName, clientEmail } = req.body || {};
  if (!cusip) return res.status(400).json({ error: 'cusip required' });
  const rfq = {
    id: 'rfq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    cusip:       String(cusip).slice(0, 12),
    issuer:      String(issuer || '').slice(0, 120),
    size:        Number.isFinite(+size) ? +size : null,
    settle:      String(settle || '').slice(0, 20) || null,
    notes:       String(notes || '').slice(0, 500),
    clientName:  String(clientName || '').slice(0, 100),
    clientEmail: String(clientEmail || '').slice(0, 120),
    receivedAt:  new Date().toISOString(),
    status:      'pending',
  };
  _rfqQueue.unshift(rfq);
  if (_rfqQueue.length > 200) _rfqQueue.length = 200;
  console.log(`[rfq] ${rfq.id} cusip=${rfq.cusip} size=${rfq.size} from=${rfq.clientName || 'anon'}`);
  res.json({ ok: true, id: rfq.id, receivedAt: rfq.receivedAt });
});

app.get('/api/internal/rfq/queue', requireInternal, (_req, res) => {
  res.json({ items: _rfqQueue, count: _rfqQueue.length });
});

app.post('/api/client/messages', (req, res) => {
  const { text, clientName, threadId } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const msg = {
    id:        'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    threadId:  String(threadId || 'default').slice(0, 60),
    text:      String(text).trim().slice(0, 2000),
    from:      String(clientName || 'client').slice(0, 100),
    direction: 'inbound',
    receivedAt: new Date().toISOString(),
  };
  _messageQueue.unshift(msg);
  if (_messageQueue.length > 200) _messageQueue.length = 200;
  console.log(`[messages] inbound from=${msg.from} text="${msg.text.slice(0, 80)}"`);
  res.json({ ok: true, id: msg.id, receivedAt: msg.receivedAt });
});

app.get('/api/internal/messages/queue', requireInternal, (_req, res) => {
  res.json({ items: _messageQueue, count: _messageQueue.length });
});

// SSE stream — clients subscribe to receive desk replies in real time.
// Replies are broadcast to every connected client; we tag each with an
// optional `to` field that the client filters on locally (defense in depth;
// real product routes per-client via auth).
const _sseClients = new Set();
app.get('/api/client/messages/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  // Initial comment forces the browser to commit the connection
  res.write(': connected\n\n');
  _sseClients.add(res);
  req.on('close', () => { _sseClients.delete(res); });
});
function _broadcastDeskMessage(msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const r of _sseClients) {
    try { r.write(payload); } catch { _sseClients.delete(r); }
  }
}

app.post('/api/internal/messages/reply', requireInternal, (req, res) => {
  const { text, to, replyTo } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const msg = {
    id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    text: String(text).trim().slice(0, 2000),
    from: 'Spread Desk',
    to: String(to || '').slice(0, 100) || null,   // null = broadcast
    replyTo: replyTo || null,
    direction: 'outbound',
    sentAt: new Date().toISOString(),
  };
  _messageQueue.unshift(msg);
  if (_messageQueue.length > 200) _messageQueue.length = 200;
  _broadcastDeskMessage(msg);
  console.log(`[messages] desk reply to=${msg.to||'*'} text="${msg.text.slice(0,80)}"`);
  res.json({ ok: true, id: msg.id, recipients: _sseClients.size });
});

// Update RFQ status (desk acks / quotes / declines)
app.post('/api/internal/rfq/update', requireInternal, (req, res) => {
  const { id, status, note } = req.body || {};
  const r = _rfqQueue.find(x => x.id === id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (status) r.status = String(status).slice(0, 30);
  if (note)   r.deskNote = String(note).slice(0, 500);
  r.updatedAt = new Date().toISOString();
  // Push a chat-style notice so the client sees their RFQ moved
  _broadcastDeskMessage({
    id:      'msg-rfq-' + Date.now(),
    text:    `RFQ ${r.id.slice(0,12)} (${r.cusip}) → ${r.status}${note ? ': ' + note : ''}`,
    from:    'Spread Desk',
    to:      r.clientName || null,
    direction: 'outbound',
    sentAt:  new Date().toISOString(),
  });
  res.json({ ok: true });
});

// ─── Public: FX spot rates (USD per unit of foreign currency, plus inverse) ───
// NEVER blocks on FRED — serves whatever is in cache; populates in background on cold start.
app.get('/api/public/fx', (_req, res) => {
  if (!cache.fx) {
    cache.fx = {};
    fetchFxRates().catch(e => console.warn('[fx] background populate failed:', e.message));
  }
  res.json({ rates: cache.fx, updatedAt: cache.fxUpdated, stale: !cache.fxUpdated });
});

// ─── Public: client-facing inventory (no markup, no dealer cost) ─────────────
app.get('/api/public/inventory', (req, res) => {
  // buildInternalProducts is now sync — works on cached curve+spreads, triggers bg refresh if cold
  const internalProducts = buildInternalProducts();
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

  // Real per-CUSIP offerings: served from cache, populated in background if cold
  if (!newIssuesCache.items) _bgPopulateNewIssues();
  const issues = newIssuesCache.items || [];
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

  // Curated default: top 15 by spread (settling today first, then upcoming).
  // Full list returns via ?view=all (used by the Phase-2 "Browse all" tab).
  const showAll = req.query.view === 'all';
  const offeringsSorted = [...offerings].sort((a, b) => {
    if ((a.upcoming?1:0) !== (b.upcoming?1:0)) return (a.upcoming?1:0) - (b.upcoming?1:0);
    return (b.spreadBps ?? -999) - (a.spreadBps ?? -999);
  });
  const offeringsView = showAll ? offeringsSorted : offeringsSorted.slice(0, 15);

  res.json({
    products,
    offerings: offeringsView,
    offeringsTotal: offerings.length,
    offeringsView: showAll ? 'all' : 'curated',
    curve: cache.curve,
    sources: ['FHLB Office of Finance', 'TreasuryDirect', 'FRED ICE BofA OAS', 'FRED Treasury CMT'],
    updatedAt: new Date().toISOString(),
    disclaimer: 'Indicative levels only. Per-CUSIP execution prices and yields are determined at trade time and may differ from displayed values.',
  });
});

// Internal only: full spread + markup reference data
app.get('/api/internal/products', requireInternal, (req, res) => {
  const products = buildInternalProducts();  // sync, cache-only
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

let _tracePopulating = false;
function _bgPopulateTrace() {
  if (_tracePopulating) return;
  _tracePopulating = true;
  buildTracePrints()
    .then(t => { cache.trace = t; cache.traceUpdated = new Date().toISOString(); })
    .catch(e => console.warn('[trace] background populate failed:', e.message))
    .finally(() => { _tracePopulating = false; });
}
app.get('/api/internal/trace', requireInternal, (req, res) => {
  const stale = !cache.trace || !cache.traceUpdated ||
                (Date.now() - new Date(cache.traceUpdated)) > 600000;
  if (stale) _bgPopulateTrace();
  res.json({ items: cache.trace || [], updatedAt: cache.traceUpdated, stale: !cache.traceUpdated });
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

// ─── Agency New Issue Analytics (internal-only module) ───────────────────────
const agencyDb = require('./agency-analytics/server/db');
const agencyAuth = require('./agency-analytics/server/auth');
const agencyIngest = require('./agency-analytics/server/ingest');
app.use('/api/internal/agency', require('./agency-analytics/server/routes'));
app.use('/api/internal/agency', require('./agency-analytics/server/desk-routes'));
app.get('/agency', (_req, res) => res.sendFile(path.join(__dirname, 'agency-analytics', 'public', 'desk.html')));

// ─── Tidal Finance — tokenized-bond landing page ──────────────────────────────
// Feature-gated: only served when TIDAL_PUBLIC=1. Keep it set locally to build,
// and leave it UNSET on Render so the page stays hidden in production until you
// decide to launch (then just add TIDAL_PUBLIC=1 to Render — no redeploy needed).
const TIDAL_PUBLIC = process.env.TIDAL_PUBLIC === '1' || process.env.TIDAL_PUBLIC === 'true';
app.get('/tidal', (_req, res) => {
  if (!TIDAL_PUBLIC) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'tidal.html'));
});
app.get('/tidal/bond', (_req, res) => {
  if (!TIDAL_PUBLIC) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'tidal-bond.html'));
});

// Email capture from the landing page. NON-US PERSONS ONLY — we reject any
// US country selection or a failed non-US attestation, and never store the
// interest, so the waitlist stays clean while securities counsel is engaged.
app.post('/api/tidal/subscribe', async (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    const country = String(b.country || '').trim().toUpperCase();
    if (!country) return res.status(400).json({ error: 'country required' });
    // Hard block US persons (Regulation S — offshore, non-US persons only).
    if (country === 'US' || country === 'USA' || country === 'UNITED STATES' || b.not_us === false) {
      return res.status(403).json({ error: 'us_blocked' });
    }
    const audience = ['retail', 'institutional'].includes(b.audience) ? b.audience : 'unspecified';
    await agencyDb.upsertRow('subscribers', {
      email,
      audience,
      country,
      created_at: new Date().toISOString(),
      source: 'tidal-landing',
      note: String(b.note || '').slice(0, 200),
    });
    const total = agencyDb.getRows('subscribers').length;
    res.json({ ok: true, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A single live agency CUSIP so the landing page shows a concrete example
app.get('/api/tidal/sample-bond', (_req, res) => {
  try {
    const rows = (agencyDb.getRows('issues') || []).filter((r) =>
      r.cusip && !String(r.cusip).startsWith('PENDING-') &&
      r.coupon && r.coupon !== '' && r.fees !== 'DNT' &&
      (r.issuer === 'FHLB' || r.issuer === 'FFCB')
    );
    if (!rows.length) return res.json({ bond: null });
    // Most recent priced
    rows.sort((a, b) => (b.pricing_date || '').localeCompare(a.pricing_date || ''));
    const r = rows[0];
    res.json({
      bond: {
        cusip: r.cusip,
        issuer: r.issuer,
        structure: r.structure,
        coupon: r.coupon,
        spread: r.spread,
        settle_date: r.settle_date,
        maturity_date: r.maturity_date,
        first_call_date: r.first_call_date,
        min_par: r.issuer === 'FHLB' ? 10000 : 1000,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List of real callables for the retail explainer, each enriched with the
// comparison yields that make the "value per bond" story concrete.
app.get('/api/tidal/bonds', (_req, res) => {
  try {
    const curve = cache.curve || {};
    const ustAt = (years) => {
      // closest active UST tenor at or below
      const map = [[30,'30yr'],[20,'20yr'],[10,'10yr'],[7,'7yr'],[5,'5yr'],[3,'3yr'],[2,'2yr'],[1,'1yr'],[0.5,'6mo'],[0.25,'3mo']];
      for (const [y, k] of map) { if (years >= y && curve[k] && typeof curve[k].yield === 'number') return curve[k].yield; }
      return curve['1yr'] && curve['1yr'].yield;
    };
    const mmRate = (cache.economicData && cache.economicData.sofr && cache.economicData.sofr.current) ||
                   (curve['3mo'] && curve['3mo'].yield) || null;
    const tenorOf = (s) => { const m = String(s||'').match(/^(\d+(?:\.\d+)?)\s*yr/i); return m ? parseFloat(m[1]) : null; };
    const lockoutMonths = (s) => { const m = String(s||'').match(/\/\s*(\d+(?:\.\d+)?)\s*(yr|mo)/i); if(!m) return null; return m[2].toLowerCase()==='yr' ? parseFloat(m[1])*12 : parseFloat(m[1]); };
    const addMonthsIso = (iso, months) => {
      if (!iso || months == null) return null;
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + Math.round(months));
      return d.toISOString().slice(0, 10);
    };
    // first call: use stored value, else derive from settle + lockout
    const firstCallOf = (r) => {
      if (r.first_call_date) return r.first_call_date;
      const lm = lockoutMonths(r.structure);
      return addMonthsIso(r.settle_date, lm);
    };

    const rows = (agencyDb.getRows('issues') || []).filter((r) =>
      r.cusip && !String(r.cusip).startsWith('PENDING-') &&
      r.coupon && r.coupon !== '' && r.fees !== 'DNT' &&
      (r.issuer === 'FHLB' || r.issuer === 'FFCB') &&
      r.structure && r.maturity_date
    );
    rows.sort((a, b) => (b.pricing_date || '').localeCompare(a.pricing_date || ''));

    const bonds = rows.slice(0, 12).map((r) => {
      const coupon = parseFloat(r.coupon);
      const tenor = tenorOf(r.structure);
      const ust = tenor != null ? ustAt(tenor) : null;
      return {
        cusip: r.cusip,
        issuer: r.issuer,
        issuer_name: r.issuer === 'FHLB' ? 'Federal Home Loan Bank' : 'Federal Farm Credit Bank',
        structure: r.structure,
        tenor_years: tenor,
        lockout_months: lockoutMonths(r.structure),
        coupon,
        settle_date: r.settle_date,
        maturity_date: r.maturity_date,
        first_call_date: firstCallOf(r),
        min_par: r.issuer === 'FHLB' ? 10000 : 1000,
        compare: {
          ust_same_tenor: ust != null ? Math.round(ust * 100) / 100 : null,
          money_market: mmRate != null ? Math.round(mmRate * 100) / 100 : null,
          pickup_vs_ust_bp: (isFinite(coupon) && ust != null) ? Math.round((coupon - ust) * 100) : null,
        },
      };
    });
    res.json({ bonds, curve_date: cache.curveUpdated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Subscriber count (for the "join N others" social proof)
app.get('/api/tidal/stats', (_req, res) => {
  try {
    res.json({ subscribers: (agencyDb.getRows('subscribers') || []).length });
  } catch (e) {
    res.json({ subscribers: 0 });
  }
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
  await fetchFxRates();
});

// Refresh AI-generated market color blurbs once per day (Claude cost control)
cron.schedule('0 7 * * *', async () => {
  await getMarketColor(true);
});

cron.schedule('0 6 * * 1', async () => {
  await generateOutlook();
});

// Agency module — daily market snapshot at 4pm ET, new-issue scan at 5pm ET
cron.schedule('0 16 * * 1-5', async () => {
  try { await agencyIngest.ingestMarketSnapshot(); }
  catch (e) { console.error('[agency.cron] market snapshot failed:', e.message); }
}, { timezone: 'America/New_York' });

cron.schedule('0 17 * * 1-5', async () => {
  try { await agencyIngest.ingestNewIssues(); }
  catch (e) { console.error('[agency.cron] new-issues failed:', e.message); }
}, { timezone: 'America/New_York' });

// Pre-pricing announcements (FHLB callable bond auctions appear ~9:45 ET).
// Poll every 15 min between 9–11 ET on weekdays to catch announcements and
// late updates before the auction closes at 10:30 ET.
cron.schedule('*/15 9-10 * * 1-5', async () => {
  try { await agencyIngest.ingestPendingAuctions(); }
  catch (e) { console.error('[agency.cron] pending-auctions failed:', e.message); }
}, { timezone: 'America/New_York' });

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
  await fetchFxRates();
  // Preload the heavier caches so the first user request after login is instant
  console.log('[startup] Preloading new-issue + trace + market-color caches...');
  newIssuesCache.items = await fetchAllNewIssues();
  newIssuesCache.updatedAt = new Date().toISOString();
  cache.trace = await buildTracePrints();
  cache.traceUpdated = new Date().toISOString();
  // Outlook + market color are NOT preloaded on startup anymore — they were
  // running on every restart at ~$0.30 each, racking up dev costs.
  // They now lazy-load on first user request (and refresh via the cron schedule:
  // weekly outlook, daily market color at 7 AM ET).

  // Agency module: connect to Google Sheets, seed users, do not block startup on failure
  try {
    await agencyDb.init();
    await agencyAuth.ensureUsersSheetSeeded();
    console.log('[startup] Agency analytics module ready.');
  } catch (e) {
    console.error('[startup] Agency analytics module failed to init:', e.message);
    console.error('[startup]   (server will continue without it — see SHEETS_SETUP.md)');
  }

  console.log('[startup] Ready.');
})();

app.listen(PORT, () => {
  console.log(`BD Platform backend running on port ${PORT}`);
});
