'use strict';

const { query } = require('./db');

const STATEMENTS = [
  // gen_random_bytes lives in pgcrypto; gen_random_uuid is core but this is not.
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id             BIGSERIAL PRIMARY KEY,
     email          TEXT UNIQUE NOT NULL,
     password_hash  TEXT NOT NULL,
     plan           TEXT NOT NULL DEFAULT 'free',
     credits_limit  INTEGER NOT NULL DEFAULT 300,
     credits_used   INTEGER NOT NULL DEFAULT 0,
     period_start   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
     stripe_customer_id     TEXT,
     stripe_subscription_id TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
     id          BIGSERIAL PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     key_hash    TEXT UNIQUE NOT NULL,
     key_prefix  TEXT NOT NULL,
     label       TEXT NOT NULL DEFAULT 'default',
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ,
     revoked_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS api_keys_account_idx ON api_keys(account_id)`,
  `CREATE TABLE IF NOT EXISTS templates (
     id          BIGSERIAL PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     html        TEXT NOT NULL,
     options     JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (account_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS files (
     token       TEXT PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     filename    TEXT NOT NULL,
     content_type TEXT NOT NULL,
     bytes       BYTEA NOT NULL,
     size        INTEGER NOT NULL,
     expires_at  TIMESTAMPTZ NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS files_expires_idx ON files(expires_at)`,
  `CREATE TABLE IF NOT EXISTS usage_events (
     id          BIGSERIAL PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL,
     pages       INTEGER,
     duration_ms INTEGER,
     ok          BOOLEAN NOT NULL,
     error_code  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS usage_events_account_time_idx ON usage_events(account_id, created_at DESC)`,
  // Which deployment produced the event. A developer machine shares this database,
  // and its failures were being published on the public status page as ours.
  `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS origin TEXT`,
  `CREATE INDEX IF NOT EXISTS usage_events_origin_time_idx ON usage_events(origin, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id          TEXT PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ NOT NULL
   )`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS webhook_secret TEXT`,
  `UPDATE accounts SET webhook_secret = encode(gen_random_bytes(24), 'hex') WHERE webhook_secret IS NULL`,
  // Existing free accounts get the newer, larger free allowance too.
  `UPDATE accounts SET credits_limit = 300 WHERE plan = 'free' AND credits_limit = 100`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id           TEXT PRIMARY KEY,
     account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     kind         TEXT NOT NULL,
     request      JSONB NOT NULL,
     webhook_url  TEXT,
     status       TEXT NOT NULL DEFAULT 'queued',
     result       JSONB,
     error        JSONB,
     attempts     INTEGER NOT NULL DEFAULT 0,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     started_at   TIMESTAMPTZ,
     finished_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS jobs_account_idx ON jobs(account_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS stripe_events (
     id          TEXT PRIMARY KEY,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function migrate() {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
  console.log(`[migrate] applied ${STATEMENTS.length} statements`);
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
