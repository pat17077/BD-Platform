// Cookie-based page auth for the internal desk (/) and client (/client) pages.
//
// Two roles:
//   desk   — full access to / and /client
//   client — access to /client only
//
// Cookie: pb_auth=<role>.<hmac>   Path=/   HttpOnly   24h
// Credentials live in .env (DESK_USERNAME/PASSWORD, CLIENT_USERNAME/PASSWORD).

const crypto = require('crypto');

const COOKIE_NAME = 'pb_auth';
const COOKIE_MAX_AGE_SEC = 24 * 60 * 60;
const SECRET = process.env.DESK_SESSION_SECRET || 'change-me-in-env';

const DESK_USER     = process.env.DESK_USERNAME   || 'desk';
const DESK_PASS     = process.env.DESK_PASSWORD   || '';
const CLIENT_USER   = process.env.CLIENT_USERNAME || 'client';
const CLIENT_PASS   = process.env.CLIENT_PASSWORD || '';

function _sign(role) {
  const issued = Math.floor(Date.now() / 1000);
  const payload = `${role}.${issued}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function _verify(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [role, issuedStr, sig] = parts;
  if (role !== 'desk' && role !== 'client') return null;
  const issued = parseInt(issuedStr, 10);
  if (!isFinite(issued)) return null;
  if (Date.now() / 1000 - issued > COOKIE_MAX_AGE_SEC) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(`${role}.${issuedStr}`).digest('hex');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { role };
}

function _parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readRole(req) {
  const c = _parseCookies(req);
  const v = _verify(c[COOKIE_NAME]);
  return v ? v.role : null;
}

function _setCookie(res, role) {
  const value = _sign(role);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`);
}

function _clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function verifyDeskLogin(username, password) {
  if (username === DESK_USER && password === DESK_PASS && DESK_PASS) return 'desk';
  return null;
}

function verifyClientLogin(username, password) {
  if (username === CLIENT_USER && password === CLIENT_PASS && CLIENT_PASS) return 'client';
  // desk creds also work on the client login form
  if (username === DESK_USER && password === DESK_PASS && DESK_PASS) return 'desk';
  return null;
}

// HTML for the two login pages (kept inline — small enough that a separate file is unnecessary)
function _loginPage({ title, action, error, hint }) {
  const errBlock = error ? `<div class="err">${error}</div>` : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#0d1117; color:#e6edf3; margin:0; height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:32px 36px; width:320px; box-shadow:0 4px 16px rgba(0,0,0,0.4); }
  h1 { margin:0 0 6px 0; font-size:20px; font-weight:600; }
  .hint { color:#8b949e; font-size:13px; margin-bottom:20px; }
  label { display:block; font-size:13px; color:#8b949e; margin-bottom:4px; margin-top:12px; }
  input { width:100%; padding:8px 10px; background:#0d1117; border:1px solid #30363d; border-radius:6px; color:#e6edf3; font-size:14px; box-sizing:border-box; }
  input:focus { outline:none; border-color:#388bfd; }
  button { margin-top:18px; width:100%; padding:9px; background:#238636; border:none; border-radius:6px; color:#fff; font-size:14px; font-weight:500; cursor:pointer; }
  button:hover { background:#2ea043; }
  .err { color:#f85149; font-size:13px; margin-top:12px; }
</style></head>
<body>
  <form class="card" method="POST" action="${action}">
    <h1>${title}</h1>
    <div class="hint">${hint}</div>
    <label>Username</label>
    <input name="username" autocomplete="username" autofocus required>
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    ${errBlock}
  </form>
</body></html>`;
}

function deskLoginHTML(error) {
  return _loginPage({
    title: 'Internal Spread Desk',
    action: '/login',
    error: error || '',
    hint: 'Authorized personnel only',
  });
}

function clientLoginHTML(error) {
  return _loginPage({
    title: 'PB Securities — Client Portal',
    action: '/client/login',
    error: error || '',
    hint: 'Please sign in to continue',
  });
}

// Express middleware: requires role=desk to view the page.
function requireDeskPage(req, res, next) {
  const role = readRole(req);
  if (role === 'desk') return next();
  res.redirect('/login');
}

// Express middleware: requires any valid role (desk or client) to view the page.
function requireClientPage(req, res, next) {
  const role = readRole(req);
  if (role === 'desk' || role === 'client') return next();
  res.redirect('/client/login');
}

module.exports = {
  readRole,
  verifyDeskLogin,
  verifyClientLogin,
  deskLoginHTML,
  clientLoginHTML,
  requireDeskPage,
  requireClientPage,
  setCookie: _setCookie,
  clearCookie: _clearCookie,
};
