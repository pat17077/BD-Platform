// Two-user authentication for the agency module.
//
// Passwords are bcrypt-hashed and stored in .env (not in the sheet).
// Sessions are stored in-memory only — they don't survive a restart, which is
// fine for a two-user prototype. Sessions expire after SESSION_TTL_MS.
//
// Auth flow:
//   POST /api/internal/agency/login { username, password }  -> { token }
//   Subsequent requests: Authorization: Bearer <token>
//   POST /api/internal/agency/logout
//
// The middleware `requireAgencyAuth` rejects requests without a valid session.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const _sessions = new Map(); // token -> { username, expiresAt }

function _users() {
  return [
    { name: process.env.AGENCY_USER1_NAME, hash: process.env.AGENCY_USER1_HASH },
    { name: process.env.AGENCY_USER2_NAME, hash: process.env.AGENCY_USER2_HASH },
  ].filter((u) => u.name && u.hash);
}

async function verifyCredentials(username, password) {
  if (!username || !password) return null;
  const user = _users().find((u) => u.name === username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.hash);
  return ok ? { username: user.name } : null;
}

function _newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(username) {
  const token = _newToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  _sessions.set(token, { username, expiresAt });
  return { token, expiresAt };
}

function destroySession(token) {
  return _sessions.delete(token);
}

function _readToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function requireAgencyAuth(req, res, next) {
  const token = _readToken(req);
  if (!token) return res.status(401).json({ error: 'missing token' });
  const sess = _sessions.get(token);
  if (!sess) return res.status(401).json({ error: 'invalid token' });
  if (sess.expiresAt < Date.now()) {
    _sessions.delete(token);
    return res.status(401).json({ error: 'expired' });
  }
  req.agencyUser = sess.username;
  next();
}

async function ensureUsersSheetSeeded() {
  const existing = new Set(db.getRows('users').map((r) => r.username));
  for (const u of _users()) {
    if (!existing.has(u.name)) {
      await db.upsertRow('users', {
        username: u.name,
        created_at: new Date().toISOString(),
        last_login_at: '',
        role: 'analyst',
      });
      console.log(`[agency.auth] seeded user: ${u.name}`);
    }
  }
}

async function recordLogin(username) {
  // Audit + last_login bookkeeping are nice-to-have; never block login on them
  // (db.init() might still be in progress if the user hit /login during startup).
  try {
    await db.upsertRow('users', {
      username,
      created_at: (db.findRow('users', (r) => r.username === username) || {}).created_at || new Date().toISOString(),
      last_login_at: new Date().toISOString(),
      role: 'analyst',
    });
    await db.audit(username, 'login', {});
  } catch (e) {
    console.warn('[agency.auth] recordLogin skipped (db not ready):', e.message);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of _sessions) {
    if (s.expiresAt < now) _sessions.delete(t);
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  verifyCredentials,
  createSession,
  destroySession,
  requireAgencyAuth,
  ensureUsersSheetSeeded,
  recordLogin,
};
