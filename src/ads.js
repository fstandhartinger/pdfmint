'use strict';

const crypto = require('node:crypto');
const { config } = require('./config');
const { query } = require('./db');
const { isInternalEmail } = require('./internal');

/**
 * First-party attribution for the authorised Google Ads measurement test.
 *
 * The whole design is a consequence of three constraints:
 *
 * 1. No third-party tags and no tracking cookies may be involved. Nothing is
 *    sent to Google; the measurement is an aggregate cohort read from our own
 *    tables, so auto-bidding signals are out of scope by construction.
 *
 * 2. Only an exact, successful signup may count. A conversion row exists only
 *    for an account that was actually created — the insert runs after
 *    createAccount succeeds, once per account (the account id is the primary
 *    key), and never on the error, duplicate-email or dashboard-reload paths.
 *
 * 3. The campaign id must not be spoofable. A signup link carries the
 *    allowlisted campaign id in the query string, but what the form POSTs is a
 *    hidden, HMAC-signed token minted by the server. Anyone inventing
 *    `?campaign=made-up-id` gets a perfectly good signup with no attribution,
 *    because only allowlisted ids are ever signed and only a valid signature
 *    creates a conversion row.
 *
 * What is deliberately NOT recorded: no email address (the account id is the
 * join key), no IP address, no gclid or other click ids, no user agent, no
 * cookies. The row is `account_id, campaign_id, qa, created_at` and nothing
 * else. The `qa` flag stamps our own signups (same rule as `accounts.internal`)
 * so aggregate reporting can exclude the house without touching the signup flow.
 */

// Campaigns the ads measurement test is allowed to attribute to. Anything not
// on this list is never signed, never verified and never written to the table,
// which is what makes arbitrary campaign spoofing impossible. Adding a campaign
// is a code change on purpose: the allowlist IS the safety boundary.
const CAMPAIGNS = Object.freeze({
  'growth-ads-pdfmint-20260910': Object.freeze({
    landingPath: '/ads/pdf',
    note: 'Google Ads measurement test configured 2026-09-10 (authorised)',
  }),
});

const DEFAULT_CAMPAIGN = 'growth-ads-pdfmint-20260910';

// A click-to-signup window of seven days covers the realistic ad journey
// without leaving tokens valid forever. Rotating SESSION_SECRET invalidates
// outstanding tokens; that is documented in IMPLEMENTATION.md.
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// Bound in an HMAC domain prefix so a signature can never be confused with one
// made for another purpose (sessions are random and unsigned; webhook secrets
// sign a different format entirely).
const TOKEN_PURPOSE = 'pdfmint-ads-v1';

function isKnownCampaign(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CAMPAIGNS, id);
}

function signPayload(campaignId, issuedAtMs) {
  return crypto
    .createHmac('sha256', (process.env.GROWTH_ADS_REPORT_TOKEN || config.sessionSecret))
    .update(`${TOKEN_PURPOSE}.${campaignId}.${issuedAtMs}`)
    .digest('base64url');
}

/**
 * Mints the hidden form token for a signup request. Returns null for a missing
 * or unknown campaign, so the caller renders a plain signup form and the signup
 * proceeds entirely unattributed.
 */
function signToken(campaignId, now = Date.now()) {
  if (!isKnownCampaign(campaignId)) return null;
  return `${campaignId}.${now}.${signPayload(campaignId, now)}`;
}

/**
 * Verifies a posted token and returns the campaign id it attests to, or null.
 * Campaign ids on the allowlist contain no dots, so three dot-separated parts
 * are unambiguous.
 */
function verifyToken(raw, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [campaignId, iatRaw, sig] = parts;
  if (!isKnownCampaign(campaignId)) return null;
  if (!/^[0-9]{10,16}$/.test(iatRaw)) return null;
  const iat = Number(iatRaw);
  if (iat > now + CLOCK_SKEW_MS || now - iat > TOKEN_TTL_MS) return null;
  const expected = signPayload(campaignId, iat);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return campaignId;
}

/**
 * Records the one conversion this account can ever have. Returns the campaign
 * id on a fresh insert, false when there was nothing valid to attribute, and
 * null when a replayed-but-valid token hit the one-per-account key without
 * adding a row.
 *
 * Callers must invoke this only after createAccount has succeeded, and must not
 * let a failure here break the signup — see the call site in web.js.
 */
async function recordSignupConversion(account, rawToken) {
  const campaignId = verifyToken(rawToken);
  if (!campaignId) return false;
  const { rowCount } = await query(
    `INSERT INTO ad_signup_conversions (account_id, campaign_id, qa)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO NOTHING`,
    [account.id, campaignId, isInternalEmail(account.email)],
  );
  return rowCount === 1 ? campaignId : null;
}

/**
 * Forward-only, idempotent, applied by src/migrate.js on boot. account_id is
 * the primary key: one account can convert exactly once, no matter how often
 * the token is replayed or the dashboard reloaded. No email, no IP, no gclid.
 */
const migration = [
  `CREATE TABLE IF NOT EXISTS ad_signup_conversions (
     account_id  BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     campaign_id TEXT NOT NULL,
     qa          BOOLEAN NOT NULL DEFAULT false,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ad_signup_conversions_campaign_time_idx
     ON ad_signup_conversions (campaign_id, created_at DESC)`,
];

module.exports = {
  CAMPAIGNS, DEFAULT_CAMPAIGN, TOKEN_TTL_MS,
  isKnownCampaign, signToken, verifyToken, recordSignupConversion,
  migration,
};
