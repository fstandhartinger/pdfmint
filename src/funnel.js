'use strict';

// Four-stage funnel report for the operator: how many external visits became
// registrations, how many registrations actually rendered a document (the free
// tier is the trial — this product has no separate paid trial), and how many
// accounts are on a paid plan. Companion to the visitor statistics
// (src/visit-stats.js), which owns the visit numbers; this module only
// aggregates what is already stored, and it stores nothing of its own: every
// statement here is a SELECT. No identifier, email or account id ever leaves
// the database — the report is counts and dates only.

const crypto = require('node:crypto');
const { query } = require('./db');

// Keep in sync with visit-stats.js (not imported there on purpose: the visitor
// statistics own that string and this module must not refactor them).
const UNIQUE_VISITORS_NOTE =
  'Not measured: counting unique visitors would need an identifier (cookie, IP or hash).';

// visit_daily keeps 13 months (visit-stats.js RETENTION_MONTHS); asking for more
// can only produce leading all-zero days, so the window stops at ~13 months.
const MAX_DAYS = 395;
const DEFAULT_DAYS = 30;

/** Clamp the ?days query parameter: junk or zero means the 30-day default. */
function clampDays(value) {
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(Number(value) || DEFAULT_DAYS)));
}

const PAID_NOTE =
  'Payment timestamps are not stored in the database, so the paid stage is the current ' +
  'snapshot of external accounts on a paid plan, not a per-day conversion series.';

const DEFINITIONS = {
  visits: 'external human page loads entering from outside (first-party visitor counter; ' +
    'bots, GPC and DNT excluded; see /api/operator/visits)',
  registrations: 'external accounts created that day (accounts stamped internal — test, ' +
    'agent or owner addresses, see src/internal.js — never count)',
  trial_starts: "external accounts whose first successful render (pdf/image/merge, ok) " +
    "happened that day. The free tier is the trial: the product has no separate paid trial.",
  paid: 'current snapshot of external accounts on a paid plan (starter/pro/scale); ' +
    'per-day attribution is not possible because plan changes are not dated',
  internal_cohort: 'the same counts for internal (test/agent/owner) accounts, reported ' +
    'separately and never in the external funnel. Visits are anonymous page loads with no ' +
    'account linkage and are external by construction, so they are never split.',
};

/** UTC calendar day of a timestamp, YYYY-MM-DD (matches visit-stats.js). */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The n window days as UTC YYYY-MM-DD, oldest first (today last). */
function windowDays(n, now = Date.now()) {
  const out = [];
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(),
    new Date(now).getUTCDate());
  for (let i = n - 1; i >= 0; i -= 1) out.push(dayOf(start - i * 86_400_000));
  return out;
}

/** Rows keyed by their UTC day string; missing days stay absent. */
async function perDay(query, sql, params) {
  const { rows } = await query(sql, params);
  return new Map(rows.map((r) => [r.day, Number(r.count)]));
}

/**
 * Aggregate the funnel over the last `days` UTC days. `query` is pg's pool.query;
 * every statement is read-only.
 */
async function funnelReport(query, days = DEFAULT_DAYS, now = Date.now()) {
  const n = clampDays(days);
  const span = n - 1;
  // Midnight UTC of the first window day, built as a true timestamptz via a double
  // AT TIME ZONE round-trip so the boundary does not depend on the session timezone either.
  const since = `((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - (${span} * interval '1 day'))`;

  const [visitRows, regRows, trialRows, paidExternal, paidInternal, regInternal, trialInternal]
    = await Promise.all([
      perDay(query,
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(visits)::int AS count
         FROM visit_daily WHERE day >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date - ${span}::int
         GROUP BY day ORDER BY day`),
      perDay(query,
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS count
         FROM accounts WHERE NOT internal AND created_at >= ${since}
         GROUP BY 1 ORDER BY 1`),
      perDay(query,
        `WITH first_render AS (
           SELECT account_id, min(created_at) AS first_at
           FROM usage_events WHERE ok AND kind IN ('pdf', 'image', 'merge')
           GROUP BY account_id
         )
         SELECT (f.first_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS count
         FROM first_render f JOIN accounts a ON a.id = f.account_id
         WHERE NOT a.internal AND f.first_at >= ${since}
         GROUP BY 1 ORDER BY 1`),
      query(`SELECT plan, count(*)::int AS count FROM accounts
             WHERE NOT internal AND plan <> 'free' GROUP BY plan ORDER BY plan`),
      query(`SELECT plan, count(*)::int AS count FROM accounts
             WHERE internal AND plan <> 'free' GROUP BY plan ORDER BY plan`),
      query(`SELECT count(*)::int AS count FROM accounts
             WHERE internal AND created_at >= ${since}`),
      query(`WITH first_render AS (
           SELECT account_id, min(created_at) AS first_at
           FROM usage_events WHERE ok AND kind IN ('pdf', 'image', 'merge')
           GROUP BY account_id
         )
         SELECT count(*)::int AS count
         FROM first_render f JOIN accounts a ON a.id = f.account_id
         WHERE a.internal AND f.first_at >= ${since}`),
    ]);

  const byPlan = (result) => Object.fromEntries(result.rows.map((r) => [r.plan, r.count]));
  const daily = windowDays(n, now).map((date) => ({
    date,
    visits: visitRows.get(date) ?? 0,
    registrations: regRows.get(date) ?? 0,
    trial_starts: trialRows.get(date) ?? 0,
  }));
  const sum = (key) => daily.reduce((acc, r) => acc + r[key], 0);
  const paidExternalTotal = paidExternal.rows.reduce((acc, r) => acc + r.count, 0);

  return {
    days: n,
    totals: {
      visits: sum('visits'),
      registrations: sum('registrations'),
      trial_starts: sum('trial_starts'),
      paid_accounts: paidExternalTotal,
    },
    daily,
    paid: { paid_accounts: paidExternalTotal, by_plan: byPlan(paidExternal), note: PAID_NOTE },
    internal: {
      registrations: regInternal.rows[0].count,
      trial_starts: trialInternal.rows[0].count,
      paid_accounts: paidInternal.rows.reduce((acc, r) => acc + r.count, 0),
      by_plan: byPlan(paidInternal),
    },
    definitions: DEFINITIONS,
    unique_visitors: null,
    unique_visitors_note: UNIQUE_VISITORS_NOTE,
    notes: [
      PAID_NOTE,
      'Visits come from the first-party visitor statistics (visit_daily); they are external ' +
        'by construction and are never split into an internal cohort.',
      'The visitor counter flushes its in-memory totals at most 60 s late, so the newest ' +
        'page loads can lag up to a minute in the visits column.',
    ],
  };
}

/** Operator-only funnel endpoint (Bearer VISIT_STATS_TOKEN; same pattern as visit-counter.js). */
function install(app, deps = {}) {
  const read = deps.query ?? query;
  app.get('/api/operator/funnel', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const token = process.env.VISIT_STATS_TOKEN;
    if (!token || token.length < 32) return res.status(404).json({ error: 'not_found' });
    const given = String(req.get('authorization') ?? '');
    const digest = (s) => crypto.createHash('sha256').update(s).digest();
    const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!safeEq(digest(given), digest(`Bearer ${token}`))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const report = await funnelReport(read, req.query.days);
      return res.json(report);
    } catch (e) {
      // Never return zeros on failure — a report that looks like "no funnel" is worse than none.
      console.warn('[funnel] report failed:', e.message);
      return res.status(503).json({ error: 'statistics_unavailable' });
    }
  });
}

module.exports = { clampDays, windowDays, funnelReport, install, DEFINITIONS };
