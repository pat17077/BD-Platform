// Node-side wrapper around quant/funding.py.
// Pattern mirrors oas.js — spawn a short-lived Python process per request
// (or batched array), feed JSON via stdin, parse JSON from stdout.

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', 'quant', 'funding.py');
const PY_BIN = process.env.AGENCY_PYTHON || 'python3';
const DEFAULT_TIMEOUT_MS = 60_000;

function _runPy(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY_BIN, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`funding.py timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(`funding.py exit ${code}: ${stderr || '(no stderr)'}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`funding output parse: ${e.message} :: ${stdout.slice(0, 300)}`));
      }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

async function computeBatch(payloads, timeoutMs = 180_000) {
  if (!payloads.length) return [];
  return _runPy(payloads, timeoutMs);
}

module.exports = { computeBatch };
