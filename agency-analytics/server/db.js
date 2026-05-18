// Google Sheets persistence layer with in-memory mirror.
//
// Design:
//   - One workbook, one tab per "table"
//   - On init(), creates any missing tabs and writes header rows (bootstrap)
//   - In-memory cache mirrors every tab as an array of row objects (header-keyed)
//   - Reads serve from memory (fast)
//   - Writes go through Sheets first, then append to memory (write-through)
//   - Background poll every 60s reconciles in case sheet was edited externally
//
// All times are stored as ISO strings. JSON fields are stringified.

const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { SCHEMA, PRIMARY_KEYS } = require('./schema');

const POLL_INTERVAL_MS = 60_000;
const MIN_WRITE_GAP_MS = 1100; // Sheets API caps writes ~60/min/user; 1100ms gap = ~54/min

let _doc = null;
let _cache = {};            // { tabName: [ { col: val, ... }, ... ] }
let _initialized = false;
let _pollTimer = null;
let _pollInFlight = false;
let _lastWriteAt = 0;
let _writeChain = Promise.resolve();

async function _throttleWrite(fn) {
  // Serialize all writes through a chain so multiple concurrent callers don't burst.
  const job = _writeChain.then(async () => {
    const elapsed = Date.now() - _lastWriteAt;
    if (elapsed < MIN_WRITE_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_WRITE_GAP_MS - elapsed));
    }
    try {
      const out = await fn();
      _lastWriteAt = Date.now();
      return out;
    } catch (e) {
      _lastWriteAt = Date.now();
      throw e;
    }
  });
  _writeChain = job.catch(() => {}); // chain continues even on failure
  return job;
}

function _loadServiceAccount() {
  const p = path.resolve(process.env.AGENCY_SERVICE_ACCOUNT_PATH || './agency-analytics/data/service-account.json');
  return require(p);
}

function _jwt() {
  const sa = _loadServiceAccount();
  return new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function _ensureTab(name, headers) {
  let sheet = _doc.sheetsByTitle[name];
  if (!sheet) {
    sheet = await _doc.addSheet({
      title: name,
      headerValues: headers,
      gridProperties: { rowCount: 1000, columnCount: Math.max(headers.length + 2, 10) },
    });
    console.log(`[agency.db] created tab: ${name}`);
    return sheet;
  }
  if (sheet.columnCount < headers.length) {
    await sheet.resize({ rowCount: Math.max(sheet.rowCount, 1000), columnCount: headers.length + 2 });
  }
  await sheet.loadHeaderRow().catch(async () => {
    await sheet.setHeaderRow(headers);
  });
  const existing = sheet.headerValues || [];
  const missing = headers.filter((h) => !existing.includes(h));
  if (missing.length) {
    await sheet.setHeaderRow(headers);
    console.log(`[agency.db] updated headers on ${name}: added ${missing.join(', ')}`);
  }
  return sheet;
}

async function _refreshTab(name) {
  const sheet = _doc.sheetsByTitle[name];
  if (!sheet) return;
  const rows = await sheet.getRows();
  _cache[name] = rows.map((r) => {
    const o = {};
    for (const h of SCHEMA[name]) o[h] = r.get(h);
    return o;
  });
}

async function init() {
  if (_initialized) return _doc;
  _doc = new GoogleSpreadsheet(process.env.AGENCY_SHEET_ID, _jwt());
  await _doc.loadInfo();
  console.log(`[agency.db] connected: ${_doc.title}`);

  for (const [tab, headers] of Object.entries(SCHEMA)) {
    await _ensureTab(tab, headers);
  }
  await _doc.loadInfo();

  for (const tab of Object.keys(SCHEMA)) {
    await _refreshTab(tab);
    console.log(`[agency.db]   ${tab}: ${_cache[tab].length} rows`);
  }

  _pollTimer = setInterval(async () => {
    if (_pollInFlight) return;
    _pollInFlight = true;
    try {
      for (const tab of Object.keys(SCHEMA)) {
        await _refreshTab(tab);
      }
    } catch (e) {
      console.error('[agency.db] poll error:', e.message);
    } finally {
      _pollInFlight = false;
    }
  }, POLL_INTERVAL_MS);

  _initialized = true;
  console.log('[agency.db] ready');
  return _doc;
}

function getRows(tab) {
  if (!_cache[tab]) return [];
  return _cache[tab].slice();
}

function findRow(tab, predicate) {
  return getRows(tab).find(predicate) || null;
}

function _pkMatches(tab, row, candidate) {
  const pk = PRIMARY_KEYS[tab];
  if (!pk) return false;
  return pk.every((k) => String(row[k]) === String(candidate[k]));
}

async function upsertRow(tab, row) {
  if (!SCHEMA[tab]) throw new Error(`unknown tab: ${tab}`);
  const sheet = _doc.sheetsByTitle[tab];
  if (!sheet) throw new Error(`sheet missing: ${tab}`);

  const normalized = {};
  for (const h of SCHEMA[tab]) {
    const v = row[h];
    if (v === undefined || v === null) normalized[h] = '';
    else if (typeof v === 'object') normalized[h] = JSON.stringify(v);
    else normalized[h] = String(v);
  }

  const cached = _cache[tab] || [];
  const cachedIdx = cached.findIndex((r) => _pkMatches(tab, r, normalized));

  if (cachedIdx >= 0) {
    await _throttleWrite(async () => {
      const sheetRows = await sheet.getRows();
      const existing = sheetRows.find((r) => {
        const ro = {};
        for (const k of PRIMARY_KEYS[tab] || []) ro[k] = r.get(k);
        return _pkMatches(tab, ro, normalized);
      });
      if (existing) {
        for (const [k, v] of Object.entries(normalized)) existing.set(k, v);
        await existing.save();
      } else {
        await sheet.addRow(normalized);
      }
    });
    _cache[tab][cachedIdx] = normalized;
  } else {
    await _throttleWrite(() => sheet.addRow(normalized));
    _cache[tab].push(normalized);
  }
  return normalized;
}

async function insertRow(tab, row) {
  if (!SCHEMA[tab]) throw new Error(`unknown tab: ${tab}`);
  const sheet = _doc.sheetsByTitle[tab];
  if (!sheet) throw new Error(`sheet missing: ${tab}`);
  const normalized = {};
  for (const h of SCHEMA[tab]) {
    const v = row[h];
    if (v === undefined || v === null) normalized[h] = '';
    else if (typeof v === 'object') normalized[h] = JSON.stringify(v);
    else normalized[h] = String(v);
  }
  await _throttleWrite(() => sheet.addRow(normalized));
  if (!_cache[tab]) _cache[tab] = [];
  _cache[tab].push(normalized);
  return normalized;
}

async function audit(username, action, details) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await insertRow('audit_log', {
    id,
    timestamp: new Date().toISOString(),
    username: username || '(system)',
    action,
    details_json: details || {},
  });
}

function stop() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
  _initialized = false;
}

async function deleteWhere(tab, predicate) {
  if (!SCHEMA[tab]) throw new Error(`unknown tab: ${tab}`);
  const sheet = _doc.sheetsByTitle[tab];
  if (!sheet) throw new Error(`sheet missing: ${tab}`);
  const sheetRows = await sheet.getRows();
  const toDelete = [];
  for (const r of sheetRows) {
    const ro = {};
    for (const h of SCHEMA[tab]) ro[h] = r.get(h);
    if (predicate(ro)) toDelete.push(r);
  }
  // Delete from bottom up so row indices stay valid
  toDelete.sort((a, b) => b.rowNumber - a.rowNumber);
  let deleted = 0;
  for (const r of toDelete) {
    await _throttleWrite(() => r.delete());
    deleted++;
  }
  if (deleted) await _refreshTab(tab);
  return deleted;
}

async function sortMulti(tab, specs) {
  // specs: [{ column: 'pricing_date', direction: 'ASCENDING' }, ...]
  if (!SCHEMA[tab]) throw new Error(`unknown tab: ${tab}`);
  const sheet = _doc.sheetsByTitle[tab];
  if (!sheet) throw new Error(`sheet missing: ${tab}`);
  await sheet.loadHeaderRow().catch(() => {});
  const rowCount = sheet.rowCount;
  if (rowCount <= 2) return;
  const sortSpecs = specs.map((s) => {
    const idx = SCHEMA[tab].indexOf(s.column);
    if (idx < 0) throw new Error(`unknown column: ${s.column}`);
    return { dimensionIndex: idx, sortOrder: s.direction || 'ASCENDING' };
  });
  await _throttleWrite(() => _doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1,
      endRowIndex: rowCount,
      startColumnIndex: 0,
      endColumnIndex: SCHEMA[tab].length,
    },
    sortSpecs,
  }));
  await _refreshTab(tab);
}

async function sortBy(tab, columnName, direction = 'ASCENDING') {
  if (!SCHEMA[tab]) throw new Error(`unknown tab: ${tab}`);
  const sheet = _doc.sheetsByTitle[tab];
  if (!sheet) throw new Error(`sheet missing: ${tab}`);
  const colIdx = SCHEMA[tab].indexOf(columnName);
  if (colIdx < 0) throw new Error(`unknown column: ${columnName}`);
  // Skip if 0 or 1 data rows — nothing to sort
  await sheet.loadHeaderRow().catch(() => {});
  const rowCount = sheet.rowCount;
  if (rowCount <= 2) return;
  await _throttleWrite(() => _doc._makeSingleUpdateRequest('sortRange', {
    range: {
      sheetId: sheet.sheetId,
      startRowIndex: 1,
      endRowIndex: rowCount,
      startColumnIndex: 0,
      endColumnIndex: SCHEMA[tab].length,
    },
    sortSpecs: [{ dimensionIndex: colIdx, sortOrder: direction }],
  }));
  await _refreshTab(tab);
}

module.exports = { init, getRows, findRow, upsertRow, insertRow, deleteWhere, audit, stop, sortBy, sortMulti, SCHEMA };
