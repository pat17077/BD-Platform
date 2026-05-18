// Fetch UST curve for any past date from FRED's DGS* series.
// Returns the same shape as /api/curve so it slots into buildSofrCurve.

const fetch = require('node-fetch');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

const DGS_SERIES = {
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

async function _fetchOne(series, date) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY not set');
  const url = `${FRED_BASE}?series_id=${series}&api_key=${key}&file_type=json` +
              `&observation_start=${date}&observation_end=${date}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error(`FRED ${series} HTTP ${r.status}`);
  const j = await r.json();
  const obs = (j.observations || [])[0];
  if (!obs || obs.value === '.' || obs.value === '') return null;
  return parseFloat(obs.value);
}

function _prevDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function _prevBusinessDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

async function _fetchAllSeries(date) {
  // Serialize to avoid FRED rate-limiting (was hitting Akamai 429s in parallel).
  const out = {};
  for (const [tenor, series] of Object.entries(DGS_SERIES)) {
    try {
      const v = await _fetchOne(series, date);
      if (v != null) out[tenor] = { yield: v, date };
    } catch (e) {
      // swallow per-series errors; caller checks overall point count
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return out;
}

/**
 * Fetch UST curve as of a specific date, falling back to the most recent
 * preceding business day if FRED hasn't published yet (1-day delay) or the
 * requested date is a weekend/holiday.
 */
async function fetchUstCurveAsOf(date) {
  const MIN_POINTS = 8;
  let probe = date;
  let actualDate = date;
  for (let i = 0; i < 7; i++) {
    const curve = await _fetchAllSeries(probe);
    if (Object.keys(curve).length >= MIN_POINTS) {
      return { curve, asOf: actualDate, fetchedFrom: probe };
    }
    probe = _prevDay(probe);
  }
  return { curve: {}, asOf: actualDate, fetchedFrom: null };
}

async function fetchSofrAsOf(date) {
  let probe = date;
  for (let i = 0; i < 7; i++) {
    try {
      const v = await _fetchOne('SOFR', probe);
      if (v != null) return v;
    } catch (_) {}
    probe = _prevDay(probe);
  }
  return null;
}

/**
 * Fetch the UST curve that would have been used to price an auction on
 * tradeDate at 10:30 ET — i.e., the prior business day's close (T-1).
 */
async function fetchUstCurveForAuction(tradeDate) {
  return fetchUstCurveAsOf(_prevBusinessDay(tradeDate));
}

async function fetchSofrForAuction(tradeDate) {
  return fetchSofrAsOf(_prevBusinessDay(tradeDate));
}

module.exports = { fetchUstCurveAsOf, fetchSofrAsOf, fetchUstCurveForAuction, fetchSofrForAuction };
