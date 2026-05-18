// Node-side wrapper around quant/oas.py.
//
// Spawns the Python script per request (or batched array). The Python process
// is short-lived — we do not keep a long-running worker.
//
// Inputs come from already-fetched data (curve snapshot, call schedule, issue
// fields), so this function does not hit Sheets or external APIs.

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', 'quant', 'oas.py');
const PY_BIN = process.env.AGENCY_PYTHON || 'python3';
const DEFAULT_TIMEOUT_MS = 20_000;

function _runPy(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY_BIN, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`oas.py timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(`oas.py exit ${code}: ${stderr || '(no stderr)'}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`oas.py output parse error: ${e.message} :: ${stdout.slice(0, 300)}`));
      }
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function _curvePoints(curveSnapshot) {
  // Convert the curve_snapshots tab rows for one date into the script's input shape.
  // Acceptable curveSnapshot: array of { tenor, yield_pct }
  const TENOR_YEARS = {
    '1mo': 1/12, '3mo': 0.25, '6mo': 0.5,
    '1y': 1, '2y': 2, '3y': 3, '5y': 5,
    '7y': 7, '10y': 10, '20y': 20, '30y': 30,
  };
  return curveSnapshot
    .map((r) => ({ tenor_years: TENOR_YEARS[r.tenor], yield_pct: parseFloat(r.yield_pct) }))
    .filter((p) => p.tenor_years != null && !isNaN(p.yield_pct))
    .sort((a, b) => a.tenor_years - b.tenor_years);
}

function _feeAdjustedCost(fees_dollars, size_dollars) {
  // Fees are in dollars; size is in dollars face. Cost = 100 - (fees / size) * 100
  const fee = parseFloat(fees_dollars);
  const size = parseFloat(size_dollars);
  if (!fee || !size || size <= 0) return null;
  return 100.0 - (fee / size) * 100.0;
}

async function computeForIssue(issue, callSchedule, curveSnapshot, opts = {}) {
  const curve = _curvePoints(curveSnapshot);
  if (!curve.length) throw new Error('no curve points for OAS');

  const cost = _feeAdjustedCost(issue.fees_dollars, issue.size_dollars);
  const payload = {
    cusip: issue.cusip,
    issue_date:    issue.pricing_date  || issue.settle_date,
    settle_date:   issue.settle_date   || issue.pricing_date,
    maturity_date: issue.maturity_date,
    coupon_pct:    parseFloat(issue.coupon),
    frequency:     opts.frequency || 'semiannual',
    day_count:     opts.day_count || '30/360',
    call_schedule: (callSchedule || []).map((c) => ({
      date: c.call_date,
      price: parseFloat(c.call_price) || 100.0,
    })),
    curve,
    target_prices: cost != null ? { par: 100.0, cost } : { par: 100.0 },
    hw_mean_reversion: opts.hw_mean_reversion || 0.03,
    hw_sigma:          opts.hw_sigma || 0.01,
  };

  return _runPy(payload, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
}

async function computeBatch(payloads, timeoutMs = 60_000) {
  if (!payloads.length) return [];
  return _runPy(payloads, timeoutMs);
}

module.exports = { computeForIssue, computeBatch };
