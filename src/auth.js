'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { isInternalEmail } = require('./internal');
const { ApiError } = require('./errors');
const { config, PLANS } = require('./config');

/**
 * Hints are read by a human, in a terminal or an n8n error panel, where a bare
 * "/dashboard" is not a link and not a place they can go. Always absolute.
 */
const dashboardUrl = () => `${config.publicUrl || ''}/dashboard`;

const KEY_PREFIX = 'pm_live_';

function newApiKey() {
  const secret = crypto.randomBytes(24).toString('base64url');
  return `${KEY_PREFIX}${secret}`;
}

const hashKey = (key) => crypto.createHash('sha256').update(key, 'utf8').digest('hex');

async function createAccount(email, password) {
  const normalised = String(email).trim().toLowerCase();
  const hash = await bcrypt.hash(String(password), 10);
  const plan = PLANS.free;
  // Stamp our own accounts at birth so the public status page never has to guess
  // later. Doing it here rather than in a nightly sweep means a load test started
  // one minute from now is already excluded from the numbers it would otherwise
  // inflate.
  const { rows } = await query(
    `INSERT INTO accounts (email, password_hash, plan, credits_limit, webhook_secret, internal)
     VALUES ($1, $2, 'free', $3, encode(gen_random_bytes(24), 'hex'), $4) RETURNING *`,
    [normalised, hash, plan.credits, isInternalEmail(normalised)],
  );
  const account = rows[0];
  const key = await issueApiKey(account.id, 'default');
  return { account, apiKey: key };
}

async function issueApiKey(accountId, label = 'default') {
  const key = newApiKey();
  await query(
    `INSERT INTO api_keys (account_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)`,
    [accountId, hashKey(key), key.slice(0, 16), label],
  );
  return key;
}

/**
 * Revokes one key by its prefix. Returns the number of keys revoked.
 *
 * Refuses to revoke the account's last remaining key: a key you cannot replace
 * without one is a lockout, and the dashboard is the only other way in.
 */
async function revokeApiKey(accountId, keyPrefix) {
  const { rows: live } = await query(
    `SELECT key_prefix FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL`,
    [accountId],
  );
  if (live.length <= 1) {
    throw new ApiError(409, 'last_key', 'This is the only key on the account, so revoking it would lock you out.', {
      hint: 'Create a replacement key first, then revoke this one.',
      docs: '/docs#auth-more-keys',
    });
  }
  const { rowCount } = await query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE account_id = $1 AND key_prefix = $2 AND revoked_at IS NULL`,
    [accountId, keyPrefix],
  );
  return rowCount;
}

async function verifyLogin(email, password) {
  const { rows } = await query(`SELECT * FROM accounts WHERE email = $1`, [String(email).trim().toLowerCase()]);
  if (!rows.length) return null;
  const ok = await bcrypt.compare(String(password), rows[0].password_hash);
  return ok ? rows[0] : null;
}

/** Rolls the monthly window forward lazily so we never need a cron for quota. */
async function rollPeriod(account) {
  const start = new Date(account.period_start);
  const now = new Date();
  const sameMonth = start.getUTCFullYear() === now.getUTCFullYear() && start.getUTCMonth() === now.getUTCMonth();
  if (sameMonth) return account;
  const { rows } = await query(
    `UPDATE accounts SET credits_used = 0, period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
     WHERE id = $1 RETURNING *`,
    [account.id],
  );
  return rows[0];
}

function extractKey(req) {
  const header = req.get('authorization');
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  const xkey = req.get('x-api-key');
  if (xkey) return xkey.trim();
  return null;
}

async function authenticate(req) {
  const key = extractKey(req);
  if (!key) {
    throw new ApiError(401, 'missing_api_key', 'No API key was sent with this request.', {
      hint: 'Send the header "Authorization: Bearer <your key>".',
      docs: '/docs#authentication',
    });
  }
  if (!key.startsWith(KEY_PREFIX)) {
    throw new ApiError(401, 'invalid_api_key', 'That does not look like a PDFMint API key.', {
      hint: `PDFMint keys start with "pm_live_". If you no longer have yours, create a new one at ${dashboardUrl()} — keys are only shown once, so an existing key cannot be read back.`,
      docs: '/docs#authentication',
    });
  }
  const { rows } = await query(
    `SELECT a.*, k.id AS key_id FROM api_keys k JOIN accounts a ON a.id = k.account_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashKey(key)],
  );
  if (!rows.length) {
    throw new ApiError(401, 'invalid_api_key', 'This API key is not valid, or it has been revoked.', {
      hint: `Keys are only shown once and cannot be read back, so if you have lost it, create a new one at ${dashboardUrl()}. Revoked keys stop working immediately.`,
      docs: '/docs#authentication',
    });
  }
  let account = rows[0];
  account = await rollPeriod(account);
  // Fire-and-forget: last_used_at is for the dashboard, not for correctness.
  query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [rows[0].key_id]).catch(() => {});
  return account;
}

/**
 * Reserves `n` credits atomically. Returns the remaining balance, or throws 402.
 */
async function consumeCredits(accountId, n = 1) {
  const { rows } = await query(
    `UPDATE accounts SET credits_used = credits_used + $2
     WHERE id = $1 AND credits_used + $2 <= credits_limit
     RETURNING credits_used, credits_limit, plan`,
    [accountId, n],
  );
  if (!rows.length) {
    const { rows: cur } = await query(`SELECT credits_used, credits_limit, plan FROM accounts WHERE id = $1`, [accountId]);
    const a = cur[0] || { credits_used: 0, credits_limit: 0, plan: 'free' };
    // An account with no plan never had a quota, so telling it the quota is
    // "exceeded" would be a false statement about what happened.
    if (Number(a.credits_limit) === 0) {
      throw new ApiError(402, 'plan_required',
        'This account has no plan, so it cannot render anything yet.', {
          hint: `This account has an allowance of 0 documents. Choose a plan at ${dashboardUrl()}.`,
          docs: '/docs#quota',
          details: { plan: a.plan, credits_used: a.credits_used, credits_limit: a.credits_limit },
        });
    }
    throw new ApiError(402, 'quota_exceeded',
      `You have used all ${a.credits_limit} documents included in your ${a.plan} plan this month.`, {
        hint: `The quota resets on the 1st of next month. To raise it now, upgrade at ${dashboardUrl()}.`,
        docs: '/docs#quota',
        details: { plan: a.plan, credits_used: a.credits_used, credits_limit: a.credits_limit },
      });
  }
  return { used: rows[0].credits_used, limit: rows[0].credits_limit, remaining: rows[0].credits_limit - rows[0].credits_used };
}

async function refundCredits(accountId, n = 1) {
  await query(`UPDATE accounts SET credits_used = GREATEST(0, credits_used - $2) WHERE id = $1`, [accountId, n]).catch(() => {});
}

/* -------------------------------------------------------------- sessions */

async function createSession(accountId) {
  const id = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [id, accountId]);
  return id;
}

/**
 * A freshly-minted key is handed to the dashboard once, through the session row
 * rather than the URL. A key in a query string ends up in browser history, in
 * Referer headers and in every proxy log between here and the user.
 */
const pendingKeys = new Map();

function stashKeyForSession(sessionId, key) {
  pendingKeys.set(sessionId, { key, at: Date.now() });
  setTimeout(() => pendingKeys.delete(sessionId), 10 * 60 * 1000).unref();
}

function takeKeyForSession(sessionId) {
  const entry = pendingKeys.get(sessionId);
  if (!entry) return null;
  pendingKeys.delete(sessionId);
  return Date.now() - entry.at < 10 * 60 * 1000 ? entry.key : null;
}

async function accountForSession(sessionId) {
  if (!sessionId) return null;
  const { rows } = await query(
    `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  if (!rows.length) return null;
  return rollPeriod(rows[0]);
}

const destroySession = (id) => query(`DELETE FROM sessions WHERE id = $1`, [id]).catch(() => {});

module.exports = {
  createAccount, issueApiKey, revokeApiKey, verifyLogin, authenticate, consumeCredits, refundCredits,
  createSession, accountForSession, destroySession, hashKey, newApiKey, KEY_PREFIX,
  stashKeyForSession, takeKeyForSession,
};
