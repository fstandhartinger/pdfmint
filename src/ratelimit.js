'use strict';

const { ApiError } = require('./errors');

/**
 * A per-account token bucket. One instance means one process, so an in-memory
 * bucket is the honest implementation — there is nothing to share it with.
 * The numbers here are the ones quoted in the docs; keep them in sync.
 */
const CAPACITY = Number(process.env.RATE_LIMIT_BURST || 30);      // instantaneous burst
const REFILL_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);
const REFILL_PER_MS = REFILL_PER_MINUTE / 60000;

const buckets = new Map();

// Drop buckets nobody has touched for an hour so the map cannot grow without bound.
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, b] of buckets) if (b.updated < cutoff) buckets.delete(id);
}, 600_000).unref();

function take(accountId) {
  const now = Date.now();
  let b = buckets.get(accountId);
  if (!b) {
    b = { tokens: CAPACITY, updated: now };
    buckets.set(accountId, b);
  }
  b.tokens = Math.min(CAPACITY, b.tokens + (now - b.updated) * REFILL_PER_MS);
  b.updated = now;
  if (b.tokens < 1) {
    const waitMs = Math.ceil((1 - b.tokens) / REFILL_PER_MS);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), remaining: 0 };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

/** Express middleware. Runs after authentication, so it can key on the account. */
function rateLimit(req, res, next) {
  if (!req.account) return next();
  const result = take(String(req.account.id));
  res.set({
    'X-RateLimit-Limit': String(REFILL_PER_MINUTE),
    'X-RateLimit-Burst': String(CAPACITY),
    'X-RateLimit-Remaining': String(result.remaining),
  });
  if (result.ok) return next();
  res.set('Retry-After', String(result.retryAfterSeconds));
  return next(new ApiError(429, 'rate_limited',
    `Too many requests: the limit is ${REFILL_PER_MINUTE} per minute per account, with a burst of ${CAPACITY}.`, {
      hint: `Wait ${result.retryAfterSeconds} second${result.retryAfterSeconds === 1 ? '' : 's'} and retry. The Retry-After header says the same thing.`,
      docs: '/docs#limits',
    }));
}

module.exports = { rateLimit, take, CAPACITY, REFILL_PER_MINUTE };
