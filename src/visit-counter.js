'use strict';

// Express side of the visitor statistics (port of the Benchmark Heaven lib/visit-counter.ts and
// app/api/operator/visits/route.ts; see docs/VISITOR-STATS-CONSENT-DECISION.md). Page views are
// added to in-memory daily totals and written to the database once a minute. The middleware never
// throws and never delays a request; a failing database only means the totals stay in memory.

const crypto = require('node:crypto');
const { classifyRequest, createAccumulator, flushRows, applyRetention, visitReport, SCHEMA_SQL, MAX_KEYS } = require('./visit-stats');
const { query } = require('./db');

const FLUSH_MS = 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;
const DISABLED = process.env.VISIT_STATS_DISABLED === '1';

// Module state on globalThis so a double require (e.g. through a symlinked path) cannot count twice.
const g = globalThis;
const state = (g.__pdfmintVisitStats ??= { acc: createAccumulator(), ready: null, timer: null, flushing: null, retainedAt: 0 });

/** The table is created lazily once, before the first flush or read. A failure lets the next call retry. */
function schemaReady() {
  state.ready ??= query(SCHEMA_SQL).catch((e) => { state.ready = null; throw e; });
  return state.ready;
}

async function flushOnce() {
  const rows = state.acc.take();
  try {
    await schemaReady();
    await flushRows(query, rows);
  } catch (e) {
    state.acc.restore(rows, Date.now(), MAX_KEYS);
    console.warn('[visit-stats] flush failed:', e.message);
  }
  // Retention runs at least hourly while the process lives, with or without new page loads.
  if (Date.now() - state.retainedAt >= RETENTION_EVERY_MS) {
    try { await applyRetention(query); state.retainedAt = Date.now(); } catch (e) {
      console.warn('[visit-stats] retention failed:', e.message);
    }
  }
}

function flush() {
  state.flushing ??= flushOnce().finally(() => { state.flushing = null; });
  return state.flushing;
}

function ensureTimer() {
  if (state.timer || DISABLED) return;
  state.timer = setInterval(() => { void flush(); }, FLUSH_MS);
  state.timer.unref();
}

/** Express middleware: classify, then count the request when it finished as a delivered page (200). */
function middleware(req, res, next) {
  try {
    if (DISABLED) return next();
    const hit = classifyRequest({ method: req.method, path: req.path, headers: req.headers });
    if (!hit) return next();
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      try {
        state.acc.add(hit, Date.now(), MAX_KEYS);
        ensureTimer();
      } catch { /* counting must never break a response */ }
    });
    return next();
  } catch {
    return next();
  }
}

/** Flush what is still in memory, then aggregate. Used by the operator endpoint. */
async function readReport(days) {
  await flush();
  return visitReport(query, days);
}

/** Operator-only report endpoint (Bearer VISIT_STATS_TOKEN, see ads-report.js for the pattern). */
function install(app) {
  app.get('/api/operator/visits', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const token = process.env.VISIT_STATS_TOKEN;
    if (!token || token.length < 32) return res.status(404).json({ error: 'not_found' });
    const given = String(req.get('authorization') ?? '');
    const digest = (s) => crypto.createHash('sha256').update(s).digest();
    if (!timingSafeEq(digest(given), digest(`Bearer ${token}`))) return res.status(401).json({ error: 'unauthorized' });
    try {
      const report = await readReport(req.query.days);
      return res.json(report);
    } catch (e) {
      // Never return zeros on failure — a report that looks like "no visitors" is worse than none.
      console.warn('[visit-stats] report failed:', e.message);
      return res.status(503).json({ error: 'statistics_unavailable' });
    }
  });
  ensureTimer();
}

function timingSafeEq(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { middleware, install, readReport };
