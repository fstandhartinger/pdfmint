'use strict';

const crypto = require('node:crypto');
const { config } = require('./config');

// Signed form token: `<issuedAtMs>.<hmac>`, where the HMAC covers
// `${kind}:${issuedAtMs}`. A real browser needs a few seconds between the GET
// and the POST; the signup/reset bot posts within ~2 s, so a valid token is one
// that is correctly signed AND at least MIN_AGE old (and not absurdly old).
const secret = () => process.env.FORM_TOKEN_SECRET
  || crypto.createHash('sha256').update(`form-token:${config.sessionSecret || process.env.DATABASE_URL || ''}`).digest('hex');

const MIN_AGE_MS = 3000;
const MAX_AGE_MS = 2 * 3600 * 1000;

function issue(kind, at = Date.now()) {
  const sig = crypto.createHmac('sha256', secret()).update(`${kind}:${at}`).digest('hex');
  return `${at}.${sig}`;
}

function check(kind, value) {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const at = Number(value.slice(0, dot));
  const sig = value.slice(dot + 1);
  if (!Number.isFinite(at)) return false;
  const expect = crypto.createHmac('sha256', secret()).update(`${kind}:${at}`).digest('hex');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const age = Date.now() - at;
  return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
}

module.exports = { issue, check, MIN_AGE_MS, MAX_AGE_MS };
