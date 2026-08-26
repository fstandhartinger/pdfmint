'use strict';

const express = require('express');
const { query } = require('./db');
const { config } = require('./config');
const render = require('./render');
const { escapeHtml } = require('./markdown');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const BOOTED_AT = new Date();

/**
 * Everything here is measured from this instance's own request log. It is
 * self-reported, and the page says so — but it is real data rather than a
 * claim, and it is the same data we would look at ourselves.
 */
/**
 * Not every failure is our failure. A page that answers 403, a host that does not
 * resolve, a selector the caller invented that never appears, an option we
 * rejected — those are the request or a third party, and counting them as service
 * failures published a success rate that misrepresented the service in its own
 * disfavour. These codes are attributed to the caller; everything else is ours.
 */
const CALLER_OR_UPSTREAM = [
  'url_unreachable', 'url_http_error', 'dns_failed', 'private_address_blocked',
  'unsupported_url_scheme', 'wait_for_timeout', 'invalid_option', 'invalid_url',
  'unknown_field', 'html_too_large', 'request_too_large', 'invalid_json',
  'unresolved_placeholders', 'template_not_found', 'ambiguous_content', 'missing_content',
  'invalid_data', 'invalid_input', 'too_many_files', 'download_failed', 'invalid_pdf',
];

async function snapshot() {
  const [day, week, hours] = await Promise.all([
    query(`SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE ok)::int AS ok,
                  count(*) FILTER (WHERE NOT ok AND error_code = ANY($2))::int AS caller,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
                  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
                  max(duration_ms) AS worst
           FROM usage_events
           WHERE created_at > now() - interval '24 hours' AND coalesce(origin, $1) = $1`,
      [config.origin, CALLER_OR_UPSTREAM]),
    query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok,
                  count(*) FILTER (WHERE NOT ok AND error_code = ANY($2))::int AS caller
           FROM usage_events
           WHERE created_at > now() - interval '7 days' AND coalesce(origin, $1) = $1`,
      [config.origin, CALLER_OR_UPSTREAM]),
    query(`SELECT date_trunc('hour', created_at) AS hour,
                  count(*)::int AS n,
                  count(*) FILTER (WHERE NOT ok AND NOT (error_code = ANY($2)))::int AS failed
           FROM usage_events
           WHERE created_at > now() - interval '24 hours' AND coalesce(origin, $1) = $1
           GROUP BY 1 ORDER BY 1`,
      [config.origin, CALLER_OR_UPSTREAM]),
  ]);
  const d = day.rows[0];
  const w = week.rows[0];
  let dbOk = true;
  try { await query('SELECT 1'); } catch { dbOk = false; }

  return {
    status: dbOk ? 'operational' : 'degraded',
    checked_at: new Date().toISOString(),
    instance_started_at: BOOTED_AT.toISOString(),
    instance_uptime_seconds: Math.round(process.uptime()),
    renderer: { ...render.stats(), browser_ready: true },
    database: dbOk ? 'reachable' : 'unreachable',
    last_24h: {
      documents: d.n,
      succeeded: d.ok,
      failed: d.n - d.ok,
      rejected_requests: d.caller,
      service_failures: d.n - d.ok - d.caller,
      success_rate: d.n ? Number(((d.ok / d.n) * 100).toFixed(2)) : null,
      service_success_rate: (d.n - d.caller) > 0
        ? Number(((d.ok / (d.n - d.caller)) * 100).toFixed(2))
        : null,
      render_ms_p50: d.p50 === null ? null : Number(d.p50),
      render_ms_p95: d.p95 === null ? null : Number(d.p95),
      render_ms_max: d.worst === null ? null : Number(d.worst),
    },
    last_7d: {
      documents: w.n,
      succeeded: w.ok,
      rejected_requests: w.caller,
      service_failures: w.n - w.ok - w.caller,
      service_success_rate: (w.n - w.caller) > 0
        ? Number(((w.ok / (w.n - w.caller)) * 100).toFixed(2))
        : null,
    },
    hourly: hours.rows.map((r) => ({ hour: r.hour, documents: r.n, failed: r.failed })),
  };
}

router.get('/status.json', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await snapshot());
}));

router.get('/status', asyncRoute(async (req, res) => {
  const s = await snapshot();
  const web = require('./web');
  const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
  const secs = s.instance_uptime_seconds;
  const uptimeText = secs > 86400
    ? `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`
    : secs > 3600 ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m` : `${Math.floor(secs / 60)}m`;

  // Always draw all 24 slots, so two busy hours do not become two fat bars.
  const byHour = new Map(s.hourly.map((h) => [new Date(h.hour).toISOString().slice(0, 13), h]));
  const peak = Math.max(1, ...s.hourly.map((h) => h.documents));
  const slots = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(Date.now() - (23 - i) * 3600 * 1000);
    const key = t.toISOString().slice(0, 13);
    const h = byHour.get(key);
    if (!h || !h.documents) {
      return `<i class="empty" title="${key}:00 UTC — no documents"></i>`;
    }
    const height = Math.max(8, Math.round((h.documents / peak) * 100));
    const colour = h.failed > 0 ? 'var(--danger)' : 'var(--accent)';
    return `<i style="height:${height}%;background:${colour}" title="${key}:00 UTC — ${h.documents} document(s), ${h.failed} failed"></i>`;
  }).join('');
  const bars = slots;

  res.set('Cache-Control', 'no-store').type('html').send(web.shell('PDFMint status', `
<header class="topbar"><a class="logo" href="/">PDF<span>Mint</span></a>
  <nav><a href="/docs">Docs</a><a href="/status.json">JSON</a><a href="/dashboard">Dashboard</a></nav></header>
<main class="dash">
  <h1>Status</h1>
  <p class="muted">Measured by the service itself and read straight from its own request log. Nothing on this page is a promise — it is what actually happened. Refresh for the current numbers, or read <a href="/status.json">/status.json</a>.</p>

  <section class="card">
    <p class="big">${s.status === 'operational' ? '<span class="ok">Operational</span>' : '<span class="bad">Degraded</span>'}</p>
    <table class="rows">
      <tr><th>Database</th><td>${escapeHtml(s.database)}</td></tr>
      <tr><th>Renders in flight</th><td>${s.renderer.active} active, ${s.renderer.queued} queued</td></tr>
      <tr><th>This instance has been up</th><td>${uptimeText} (since ${s.instance_started_at.replace('T', ' ').slice(0, 16)} UTC)</td></tr>
    </table>
    <p class="muted">PDFMint runs as a single service. A deploy restarts it, which resets the uptime figure above — it measures this process, not the service's history.</p>
  </section>

  <section class="card">
    <h2>Last 24 hours</h2>
    <table class="rows">
      <tr><th>Documents produced</th><td>${num(s.last_24h.documents)}</td></tr>
      <tr><th>Succeeded</th><td>${num(s.last_24h.succeeded)}</td></tr>
      <tr><th>Refused before rendering</th><td>${num(s.last_24h.rejected_requests)} <span class="muted">&mdash; a bad option, a page that answered 4xx, a selector that never appeared. The credit is refunded.</span></td></tr>
      <tr><th>Failures on our side</th><td>${num(s.last_24h.service_failures)}</td></tr>
      <tr><th>Success rate, excluding refused requests</th><td>${s.last_24h.service_success_rate === null ? '—' : `<strong>${s.last_24h.service_success_rate}%</strong>`}</td></tr>
      <tr><th>Success rate, counting everything</th><td>${s.last_24h.success_rate === null ? '—' : `${s.last_24h.success_rate}%`}</td></tr>
      <tr><th>Render time, median</th><td>${num(s.last_24h.render_ms_p50)} ms</td></tr>
      <tr><th>Render time, 95th percentile</th><td>${num(s.last_24h.render_ms_p95)} ms</td></tr>
      <tr><th>Render time, slowest</th><td>${num(s.last_24h.render_ms_max)} ms</td></tr>
    </table>
    <div class="spark">${bars}</div>
    <p class="muted">Bars count failures on our side only, not requests we refused. One bar per hour over the last 24 hours, tallest bar = ${peak.toLocaleString('en-US')} document${peak === 1 ? '' : 's'}. Red means at least one document failed in that hour. Hover a bar for the exact count.</p>
  </section>

  <section class="card">
    <h2>Last 7 days</h2>
    <table class="rows">
      <tr><th>Documents produced</th><td>${num(s.last_7d.documents)}</td></tr>
      <tr><th>Refused before rendering</th><td>${num(s.last_7d.rejected_requests)}</td></tr>
      <tr><th>Failures on our side</th><td>${num(s.last_7d.service_failures)}</td></tr>
      <tr><th>Success rate, excluding refused requests</th><td>${s.last_7d.service_success_rate === null ? '—' : `<strong>${s.last_7d.service_success_rate}%</strong>`}</td></tr>
    </table>
  </section>

  <section class="card">
    <h2>What we do not have</h2>
    <p>Being straight about it, because you are about to depend on this:</p>
    <ul>
      <li>No third-party uptime monitor yet. The numbers above are self-reported, and they count
          only this deployment &mdash; a development machine sharing the database used to show up here.</li>
      <li>No SLA, and no SOC 2 report.</li>
      <li>One instance, one region (Frankfurt). A deploy causes a short restart.</li>
      <li>Render failures refund the credit automatically, so a bad minute does not cost you documents.</li>
    </ul>
    <p class="muted">If something is broken, open an issue at
      <a href="https://github.com/fstandhartinger/pdfmint/issues">github.com/fstandhartinger/pdfmint/issues</a>.</p>
  </section>
</main>
<style>
.spark{display:flex;align-items:flex-end;gap:2px;height:70px;margin:1rem 0 .4rem}
.spark i{flex:1;border-radius:2px 2px 0 0;min-width:3px;display:block;align-self:flex-end}
.spark i.empty{height:3px;background:var(--rule)}
.rows th{width:52%;font-weight:500}
</style>`, {
    // Everything else shell() draws is an account page. This one is public and
    // is the honest answer to "is it up", so it is the one that may be indexed.
    robots: 'index, follow',
    canonical: '/status',
    description: 'Live PDFMint availability: documents rendered, failures and p95 latency over the last 24 hours, read from the production usage log.',
  }));
}));

module.exports = { router, snapshot };
