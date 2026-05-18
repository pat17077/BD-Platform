#!/usr/bin/env node
// Usage: node agency-analytics/server/hash-password.js <password>
// Prints a bcrypt hash to paste into .env as AGENCY_USER1_HASH or AGENCY_USER2_HASH.

const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node hash-password.js <password>');
  process.exit(1);
}
if (pw.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

const hash = bcrypt.hashSync(pw, 10);
console.log(hash);
