/**
 * BD Platform Backend — server.js
 * 
 * Serves: Treasury curve, TRACE EOD data, CME rate probabilities,
 *         yield calculations, AI economic outlook via Claude API
 * 
 * Setup:
 *   npm install express cors node-fetch node-cron
 *   FRED_API_KEY=your_key ANTHROPIC_API_KEY=your_key node server.js
 * 
 * Free API keys:
 *   FRED: https://fred.stlouisfed.org/docs/api/api_key.html
 *   Anthropic: https://console.anthropic.com
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

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
  outlook: null,
  outlookUpdated: null,
  traceEod: null,
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

// ─── Fetch single FRED series (last N observations) ───────────────────────────
async function fetchFredSeries(seriesId, limit = 3) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.observations) return null;
  return data.observations.filter(o => o.value !== '.').map(o => ({
    date: o.date,
    value: parseFloat(o.value)
  }));
}

// ─── Fetch full Treasury yield curve ─────────────────────────────────────────
async function fetchCurve() {
  console.log('[curve] Fetching Treasury curve from FRED...');
  const result = {};
  for (const [label, seriesId] of Object.entries(CURVE_SERIES)) {
    try {
      const obs = await fetchFredSeries(seriesId, 1);
      if (obs && obs.length > 0) {
        result[label] = { yield: obs[0].value, date: obs[0].date };
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

// Internal only: full spread + markup reference data
app.get('/api/internal/products', requireInternal, (req, res) => {
  res.json({ products: INTERNAL_PRODUCTS, updatedAt: new Date().toISOString() });
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

// ─── Internal products reference data ────────────────────────────────────────
const INTERNAL_PRODUCTS = [
  { id:'gse-callable', cat:'gse', name:'Callable Agency', sub:'FHLB/FNMA/FHLMC callable',
    streetLow:15, streetHigh:30, streetTypical:22, clientValue:'A', dealerValue:'A',
    note:'Off-the-run / longer calls = top of range. Best BD value in agencies.' },
  { id:'gse-bullet', cat:'gse', name:'Agency Bullet', sub:'FHLB/FNMA non-callable',
    streetLow:5, streetHigh:15, streetTypical:9, clientValue:'A', dealerValue:'B',
    note:'On-the-run compresses to low end. Good for client, thin for us.' },
  { id:'ig-corp', cat:'corp', name:'IG Corporate', sub:'A–BBB rated, 3–10yr',
    streetLow:20, streetHigh:45, streetTypical:28, clientValue:'A', dealerValue:'A',
    note:'Odd lots and off-the-run push to high end of range.' },
  { id:'hy-corp', cat:'corp', name:'High Yield Corp', sub:'BB/B rated',
    streetLow:40, streetHigh:80, streetTypical:58, clientValue:'B', dealerValue:'A',
    note:'Wide market. Sourcing premium is real. Watch liquidity carefully.' },
  { id:'muni-go', cat:'muni', name:'Muni GO', sub:'AA–AAA general obligation',
    streetLow:25, streetHigh:55, streetTypical:35, clientValue:'B', dealerValue:'A',
    note:'Less TRACE transparency = higher range tolerance. Best % markup.' },
  { id:'muni-rev', cat:'muni', name:'Muni Revenue', sub:'A–AA revenue bonds',
    streetLow:25, streetHigh:60, streetTypical:38, clientValue:'C', dealerValue:'A',
    note:'Issuer complexity adds tolerance. Always check underlying credit.' },
  { id:'treasury-off', cat:'treasury', name:'Off-the-run UST', sub:'5–30yr off-the-run',
    streetLow:1, streetHigh:6, streetTypical:3, clientValue:'A', dealerValue:'C',
    note:'Near zero margin. Use as relationship product.' },
  { id:'term-repo', cat:'repo', name:'Term Repo 1–3mo', sub:'UST/Agency collateral',
    streetLow:10, streetHigh:25, streetTypical:18, clientValue:'A', dealerValue:'A',
    note:'Rate + collateral haircut = dealer take. Best spread for us in repo.' },
  { id:'repo-on', cat:'repo', name:'Overnight Repo', sub:'UST collateral ~SOFR',
    streetLow:4, streetHigh:12, streetTypical:8, clientValue:'A', dealerValue:'B',
    note:'Volume game. Tight margin but excellent for client relationships.' },
];

// ─── Cron: refresh curve every hour, outlook every Monday 6am ─────────────────
cron.schedule('0 * * * *', async () => {
  await fetchCurve();
  await fetchEconomicData();
});

cron.schedule('0 6 * * 1', async () => {
  await generateOutlook();
});

// ─── Initial data load on startup ─────────────────────────────────────────────
(async () => {
  console.log('[startup] Loading initial data...');
  await fetchCurve();
  await fetchEconomicData();
  await generateOutlook();
  console.log('[startup] Ready.');
})();

app.listen(PORT, () => {
  console.log(`BD Platform backend running on port ${PORT}`);
});
