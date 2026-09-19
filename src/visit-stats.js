'use strict';

// First-party visitor statistics, ported from the Benchmark Heaven design
// (lib/visit-stats.mjs, decision record ops/ux-2026-09-12/CR-67.5-CONSENT-DECISION.md;
// engineering assessment for this repo: docs/VISITOR-STATS-CONSENT-DECISION.md).
// The server counts the page requests it delivers anyway. Nothing is written to or
// read from the visitor's device (no cookie, storage, script, pixel or client hint),
// no identifier is derived (no IP, no hash, no fingerprint), and only daily totals
// per page and referring host are stored. Unique visitors are therefore not measured;
// "visits" counts page loads that entered the site from outside (no same-site referrer).

const RETENTION_MONTHS = 13;
/** The operator report never shows a page or referrer row with fewer page loads than this (no single-visit facts). */
const MIN_REPORT_COUNT = 3;
/** At most this many distinct daily rows are held in memory between flushes; further new rows are skipped. */
const MAX_KEYS = 5000;

const SCHEMA_SQL = `-- First-party visitor statistics: aggregate daily page totals only.
-- No IP, user agent, cookie, identifier or visitor-level row.
CREATE TABLE IF NOT EXISTS visit_daily (
  day date NOT NULL,
  path text NOT NULL,
  referrer_host text NOT NULL DEFAULT '',
  views integer NOT NULL DEFAULT 0,
  visits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, referrer_host)
);
`;

const OWN_HOSTS = new Set([
  'pdf.mintapis.com',
  'mintapis.com',
  'pdfmint-b9tt.onrender.com',
  'pdfmint.onrender.com',
  'localhost',
  '127.0.0.1',
]);

// The user agent is read only for this test and never stored.
const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|scan|monitor|lighthouse|headless|phantom|playwright|puppeteer|selenium|curl|wget|python|httpx|axios|node-fetch|undici|go-http|java\/|okhttp|libwww|facebookexternalhit|embedly|quora|whatsapp|telegram|discord|skype|vkshare|w3c_validator|pingdom|uptime|gptbot|chatgpt|claude|anthropic|perplexity|bytespider|ccbot|amazonbot|applebot|bingpreview/i;

// Only known page routes are recorded; anything else (scanners, typos) is stored as one "(unknown route)" row.
const PAGE_ROOTS = new Set(['', 'docs', 'status', 'signup', 'login', 'dashboard', 'forgot-password', 'reset-password',
  'ads', 'privacy', 'terms', 'legal', 'zapier', 'n8n-templates', 'n8n-html-to-pdf', 'html-to-pdf-api',
  'url-to-pdf-api', 'markdown-to-pdf-api', 'invoice-pdf-api', 'merge-pdf-api', 'pdfshift-alternative',
  'pdfmonkey-alternative', 'craftmypdf-alternative']);

// API surface, webhooks, hosted files and health checks are not pages.
const NON_PAGE_PREFIXES = ['/v1', '/stripe', '/f', '/internal', '/api', '/healthz'];

const hostOf = (value) => {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

/** Page path without query or fragment, truncated to its route shape; null for non-page requests. */
function normalisePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  if (pathname === '/status.json') return null;
  if (NON_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  let clean = pathname.replace(/\/{2,}/g, '/');
  if (clean.length > 1) clean = clean.replace(/\/+$/, '');
  // The static pages live on disk as <name>.html; count them under the clean route.
  if (/^\/index\.html$/i.test(clean)) return '/';
  if (/^\/[^/]+\.html$/i.test(clean)) clean = clean.replace(/\.html$/i, '');
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return null;
  const parts = clean.split('/').slice(1);
  if (!PAGE_ROOTS.has(parts[0] ?? '')) return '(unknown route)';
  return `/${parts.slice(0, 2).join('/')}`.slice(0, 160);
}

/**
 * Decide whether one incoming request is a page view to count.
 * @param {{ method: string, path: string, headers: Record<string, string | string[]>, hostOwn?: string | string[] }} req
 *   headers is Express's req.headers: a plain object with lowercase keys. hostOwn adds further own
 *   hosts (e.g. a deployment host) to the same-site check.
 * @returns {{ path: string, referrerHost: string, visit: boolean } | null}
 */
function classifyRequest({ method, path, headers, hostOwn }) {
  if (method !== 'GET') return null;
  const h = headers || {};
  const get = (name) => (h[name] === undefined || h[name] === null ? null : String(h[name]));
  // Objection signals the browser already sends: Global Privacy Control and Do Not Track.
  if (get('sec-gpc') === '1' || get('dnt') === '1') return null;
  // Browser prefetch/prerender of a document is not a view.
  if (/prefetch|prerender/i.test(`${get('sec-purpose') ?? ''} ${get('purpose') ?? ''}`)) return null;
  const dest = get('sec-fetch-dest');
  if (dest ? dest !== 'document' : !(get('accept') ?? '').includes('text/html')) return null;
  const ua = get('user-agent') ?? '';
  if (!ua || BOT_UA.test(ua)) return null;
  const norm = normalisePath(path);
  if (!norm) return null;
  const ref = get('referer');
  const refHost = ref ? hostOf(ref) : null;
  let ownHosts = OWN_HOSTS;
  if (hostOwn) {
    ownHosts = new Set(OWN_HOSTS);
    for (const extra of Array.isArray(hostOwn) ? hostOwn : [hostOwn]) {
      const host = hostOf(`https://${String(extra)}`);
      if (host) ownHosts.add(host);
    }
  }
  const sameSite = refHost !== null && ownHosts.has(refHost);
  return {
    path: norm,
    referrerHost: refHost && !sameSite ? refHost.slice(0, 100) : '',
    visit: !sameSite,
  };
}

/** UTC calendar day of a timestamp, YYYY-MM-DD. */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** In-memory daily totals; flushed as increments, then cleared. Holds no request-level data. */
function createAccumulator() {
  let rows = new Map();
  return {
    add(hit, now = Date.now(), maxKeys = Infinity) {
      const day = dayOf(now);
      const key = `${day}\u0000${hit.path}\u0000${hit.referrerHost}`;
      if (!rows.has(key) && rows.size >= maxKeys) return;
      const row = rows.get(key) ?? { day, path: hit.path, referrerHost: hit.referrerHost, views: 0, visits: 0 };
      row.views += 1;
      if (hit.visit) row.visits += 1;
      rows.set(key, row);
    },
    size: () => rows.size,
    take() { const out = [...rows.values()]; rows = new Map(); return out; },
    /** Put back totals whose write failed; totals older than yesterday (UTC) are dropped, not kept in memory. */
    restore(taken, now = Date.now(), maxKeys = Infinity) {
      const oldest = dayOf(now - 86_400_000);
      for (const r of taken) {
        if (r.day < oldest) continue;
        const key = `${r.day}\u0000${r.path}\u0000${r.referrerHost}`;
        const row = rows.get(key);
        if (row) { row.views += r.views; row.visits += r.visits; } else if (rows.size < maxKeys) rows.set(key, { ...r });
      }
    },
  };
}

/** Delete totals older than the retention period. */
const applyRetention = (query) =>
  query(`DELETE FROM visit_daily WHERE day < (current_date - interval '${RETENTION_MONTHS} months')`);

/** Upsert a batch of totals. `query` is pg's pool.query. */
async function flushRows(query, rows) {
  if (!rows.length) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`($${i * 5 + 1}::date, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}::int, $${i * 5 + 5}::int)`);
    params.push(r.day, r.path, r.referrerHost, r.views, r.visits);
  });
  await query(
    `INSERT INTO visit_daily (day, path, referrer_host, views, visits) VALUES ${values.join(', ')}
     ON CONFLICT (day, path, referrer_host) DO UPDATE SET views = visit_daily.views + EXCLUDED.views,
       visits = visit_daily.visits + EXCLUDED.visits`,
    params,
  );
}

/**
 * Aggregate report for the operator: totals per day, the top 25 pages and referring hosts with at least
 * MIN_REPORT_COUNT page loads, and one "(other)" row combining every remaining row (below the threshold or beyond 25).
 */
async function visitReport(query, days = 30) {
  const n = Math.max(1, Math.min(400, Math.floor(Number(days) || 30)));
  const since = `current_date - ${n - 1}`;
  const [daily, pages, referrers] = await Promise.all([
    query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(views)::int AS views, sum(visits)::int AS visits
           FROM visit_daily WHERE day >= ${since} GROUP BY day ORDER BY day`),
    query(`SELECT path, sum(views)::int AS views, sum(visits)::int AS visits
           FROM visit_daily WHERE day >= ${since} GROUP BY path ORDER BY views DESC`),
    query(`SELECT referrer_host, sum(visits)::int AS visits
           FROM visit_daily WHERE day >= ${since} AND referrer_host <> '' GROUP BY referrer_host ORDER BY visits DESC`),
  ]);
  const fold = (rows, countKey, label, keys) => {
    const shown = rows.filter((r) => r[countKey] >= MIN_REPORT_COUNT).slice(0, 25);
    const rest = rows.filter((r) => !shown.includes(r));
    if (!rest.length) return shown;
    const other = { [label]: '(other)' };
    for (const k of keys) other[k] = rest.reduce((acc, r) => acc + r[k], 0);
    return [...shown, other];
  };
  const sum = (key) => daily.rows.reduce((acc, r) => acc + r[key], 0);
  return {
    days: n,
    unique_visitors: null,
    unique_visitors_note: 'Not measured: counting unique visitors would need an identifier (cookie, IP or hash).',
    totals: { views: sum('views'), visits: sum('visits') },
    daily: daily.rows.map((r) => ({ date: r.day, views: r.views, visits: r.visits, uniques: null })),
    topPages: fold(pages.rows, 'views', 'path', ['views', 'visits']),
    topReferrers: fold(referrers.rows.filter((r) => r.visits > 0), 'visits', 'referrer_host', ['visits']),
  };
}

module.exports = {
  RETENTION_MONTHS,
  MIN_REPORT_COUNT,
  MAX_KEYS,
  SCHEMA_SQL,
  normalisePath,
  classifyRequest,
  dayOf,
  createAccumulator,
  flushRows,
  applyRetention,
  visitReport,
};
