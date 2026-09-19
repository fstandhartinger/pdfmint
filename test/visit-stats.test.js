'use strict';

// Tests for the first-party visitor statistics: the pure classification and
// aggregation logic (no database), and the database-backed flush, operator
// report and operator endpoint against the test database from test-env.sh.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const stats = require('../src/visit-stats');
const visitCounter = require('../src/visit-counter');
const { query, pool } = require('../src/db');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const browserHeaders = (extra = {}) => ({
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-dest': 'document',
  ...extra,
});

// Database-backed tests only ever run against the local test database, never against production.
const DB_OK = !!process.env.DATABASE_URL && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL);

// Every row these tests insert carries this unique prefix, so the cleanup deletes exactly them.
const TAG = crypto.randomBytes(4).toString('hex');
const P = (name) => `/__visit-test-${TAG}/${name}`;
const DAY = () => stats.dayOf(Date.now());

after(async () => {
  if (DB_OK) await query('DELETE FROM visit_daily WHERE path LIKE $1', [`/__visit-test-${TAG}/%`]);
  await pool.end();
});

test('page paths are normalised to their route shape; everything else is not a page', () => {
  const n = stats.normalisePath;
  assert.equal(n('/'), '/');
  assert.equal(n('/index.html'), '/');
  assert.equal(n('/docs'), '/docs');
  assert.equal(n('/docs.html'), '/docs');
  assert.equal(n('/docs/'), '/docs');
  // The input contract is the bare pathname: no query, no fragment.
  assert.equal(n('/docs?utm_source=x'), '(unknown route)');
  assert.equal(n('/docs#top'), '(unknown route)');
  // API surface, webhooks, hosted files, health checks and files are never pages.
  for (const p of ['/f/x', '/v1/pdf', '/api/operator/visits', '/internal/x', '/healthz', '/status.json',
    '/assets/logo.png', '/sitemap.xml', '/x.jpeg']) {
    assert.equal(n(p), null, p);
  }
  assert.equal(n('/xyz'), '(unknown route)');
  assert.equal(n('/docs/section'), '/docs/section');
  assert.equal(n('/reset-password/tok-abc'), '/reset-password/tok-abc');
  // A path can never blow up the stored row.
  assert.equal(n(`/docs/${'a'.repeat(300)}`).length, 160);
});

test('only a real page request from a real browser is counted', () => {
  const c = (req) => stats.classifyRequest(req);
  assert.deepEqual(c({ method: 'GET', path: '/', headers: browserHeaders() }), { path: '/', referrerHost: '', visit: true });
  assert.equal(c({ method: 'POST', path: '/', headers: browserHeaders() }), null);
  assert.equal(c({ method: 'HEAD', path: '/', headers: browserHeaders() }), null);
  // Objection signals the browser already sends.
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ 'sec-gpc': '1' }) }), null);
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ dnt: '1' }) }), null);
  // Browser prefetch and prerender are not views.
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ 'sec-purpose': 'prefetch' }) }), null);
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ purpose: 'prefetch' }) }), null);
  // Fetch metadata: only a top-level document navigation is a page load.
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ 'sec-fetch-dest': 'iframe' }) }), null);
  assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ 'sec-fetch-dest': 'image' }) }), null);
  assert.deepEqual(c({ method: 'GET', path: '/docs', headers: browserHeaders() }), { path: '/docs', referrerHost: '', visit: true });
  // Without fetch metadata the accept header decides.
  assert.deepEqual(c({ method: 'GET', path: '/', headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } }),
    { path: '/', referrerHost: '', visit: true });
  assert.equal(c({ method: 'GET', path: '/', headers: { 'user-agent': BROWSER_UA, accept: 'application/json' } }), null);
  // No user agent, no count.
  assert.equal(c({ method: 'GET', path: '/', headers: { accept: 'text/html' } }), null);
  // Known automation and bots are filtered.
  for (const ua of ['curl/8.5.0', 'python-requests/2.31.0', 'playwright', 'puppeteer',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
    'GPTBot/1.0 (+https://openai.com/gptbot)', 'ClaudeBot/1.0; claude-ai']) {
    assert.equal(c({ method: 'GET', path: '/', headers: browserHeaders({ 'user-agent': ua }) }), null, ua);
  }
  // The API surface and static assets are never counted, even with a browser user agent.
  assert.equal(c({ method: 'GET', path: '/api/operator/visits', headers: browserHeaders() }), null);
  assert.equal(c({ method: 'GET', path: '/assets/logo.png', headers: browserHeaders() }), null);
});

test('external referrers are recorded by host; same-site entries are not visits', () => {
  const withRef = (referer, hostOwn) => stats.classifyRequest({
    method: 'GET',
    path: '/',
    headers: browserHeaders(referer === undefined ? {} : { referer }),
    ...(hostOwn ? { hostOwn } : {}),
  });
  assert.deepEqual(withRef('https://www.google.com/search?q=pdf'), { path: '/', referrerHost: 'google.com', visit: true });
  for (const own of ['https://pdf.mintapis.com/docs', 'https://mintapis.com/', 'https://pdfmint-b9tt.onrender.com/x',
    'https://pdfmint.onrender.com/', 'http://localhost:3000/', 'http://127.0.0.1:3136/']) {
    assert.deepEqual(withRef(own), { path: '/', referrerHost: '', visit: false }, own);
  }
  // A host handed in via hostOwn counts as same-site; a random one stays a visit.
  assert.deepEqual(withRef('https://pdfmint-pr-42.fly.dev/', ['pdfmint-pr-42.fly.dev']), { path: '/', referrerHost: '', visit: false });
  assert.deepEqual(withRef('https://evil.example/'), { path: '/', referrerHost: 'evil.example', visit: true });
  // No referrer at all: an entry visit without a referrer host.
  assert.deepEqual(withRef(undefined), { path: '/', referrerHost: '', visit: true });
});

test('the accumulator keeps daily totals per page and referrer, hands them out and takes them back', () => {
  const acc = stats.createAccumulator();
  const now = Date.UTC(2026, 8, 19, 15, 30); // 2026-09-19 UTC
  acc.add({ path: '/', referrerHost: 'google.com', visit: true }, now);
  acc.add({ path: '/', referrerHost: 'google.com', visit: true }, now);
  acc.add({ path: '/', referrerHost: '', visit: false }, now);
  acc.add({ path: '/docs', referrerHost: '', visit: true }, now);
  assert.equal(acc.size(), 3);
  assert.deepEqual(acc.take(), [
    { day: '2026-09-19', path: '/', referrerHost: 'google.com', views: 2, visits: 2 },
    { day: '2026-09-19', path: '/', referrerHost: '', views: 1, visits: 0 },
    { day: '2026-09-19', path: '/docs', referrerHost: '', views: 1, visits: 1 },
  ]);
  assert.equal(acc.size(), 0);
});

test('a failed flush puts the totals back into memory, but old days are dropped', () => {
  const now = Date.UTC(2026, 8, 19, 15, 30);
  const acc = stats.createAccumulator();
  acc.add({ path: '/', referrerHost: 'example.org', visit: true }, now);
  const taken = acc.take();
  assert.equal(acc.size(), 0);
  acc.restore(taken, now);
  assert.equal(acc.size(), 1);
  assert.deepEqual(acc.take(), [{ day: '2026-09-19', path: '/', referrerHost: 'example.org', views: 1, visits: 1 }]);
  // Rows older than yesterday are dropped instead of being kept in memory forever.
  const yesterday = stats.dayOf(now - 86_400_000);
  acc.restore([
    { day: yesterday, path: '/', referrerHost: '', views: 2, visits: 2 },
    { day: stats.dayOf(now - 3 * 86_400_000), path: '/old', referrerHost: '', views: 9, visits: 0 },
  ], now);
  assert.equal(acc.size(), 1);
  assert.deepEqual(acc.take(), [{ day: yesterday, path: '/', referrerHost: '', views: 2, visits: 2 }]);
});

test('the memory cap skips new keys beyond the cap but never loses rows it already holds', () => {
  const now = Date.UTC(2026, 8, 19, 15, 30);
  const h = (p) => ({ path: p, referrerHost: '', visit: false });
  const acc = stats.createAccumulator();
  acc.add(h('/a'), now, 2);
  acc.add(h('/b'), now, 2);
  acc.add(h('/c'), now, 2); // skipped: the cap is reached
  acc.add(h('/a'), now, 2); // an existing row still accumulates
  assert.equal(acc.size(), 2);
  assert.deepEqual(acc.take(), [
    { day: '2026-09-19', path: '/a', referrerHost: '', views: 2, visits: 0 },
    { day: '2026-09-19', path: '/b', referrerHost: '', views: 1, visits: 0 },
  ]);
  // The same cap applies to restored rows.
  acc.restore([{ day: '2026-09-19', path: '/x', referrerHost: '', views: 1, visits: 0 },
    { day: '2026-09-19', path: '/y', referrerHost: '', views: 1, visits: 0 }], now, 1);
  assert.equal(acc.size(), 1);
});

test('retention deletes every row older than thirteen months', () => {
  let seen = null;
  stats.applyRetention((sql) => { seen = sql; });
  assert.match(seen, /DELETE FROM visit_daily/);
  assert.ok(seen.includes(`day < (current_date - interval '${stats.RETENTION_MONTHS} months')`));
});

test('flushed totals are upserted: flushing the same rows twice doubles the counters', { skip: !DB_OK }, async () => {
  await query(stats.SCHEMA_SQL);
  await query('DELETE FROM visit_daily WHERE path LIKE $1', [`/__visit-test-${TAG}/%`]);
  const rows = [
    { day: DAY(), path: P('flush-a'), referrerHost: '', views: 2, visits: 1 },
    { day: DAY(), path: P('flush-b'), referrerHost: 'ref-upsert.example', views: 1, visits: 1 },
  ];
  await stats.flushRows(query, rows);
  await stats.flushRows(query, rows);
  await stats.flushRows(query, []); // an empty batch is a no-op
  const { rows: got } = await query(
    'SELECT path, referrer_host, views, visits FROM visit_daily WHERE path LIKE $1 ORDER BY path',
    [`/__visit-test-${TAG}/%`],
  );
  assert.deepEqual(got, [
    { path: P('flush-a'), referrer_host: '', views: 4, visits: 2 },
    { path: P('flush-b'), referrer_host: 'ref-upsert.example', views: 2, visits: 2 },
  ]);
});

test('the operator report folds quiet rows into (other) and never names a single-visit page or referrer', { skip: !DB_OK }, async () => {
  await query(stats.SCHEMA_SQL);
  await query('DELETE FROM visit_daily'); // this table holds nothing but test data
  const day = DAY();
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ day, path: P(`page-${i}`), referrerHost: '', views: 10, visits: 4 });
  for (let i = 25; i < 28; i++) rows.push({ day, path: P(`page-${i}`), referrerHost: '', views: 5, visits: 2 });
  rows.push({ day, path: P('quiet-1'), referrerHost: '', views: 1, visits: 1 });
  rows.push({ day, path: P('quiet-2'), referrerHost: '', views: 2, visits: 1 });
  rows.push({ day, path: P('referred'), referrerHost: 'ref-a.example', views: 4, visits: 4 });
  rows.push({ day, path: P('one-ref'), referrerHost: 'ref-b.example', views: 1, visits: 1 });
  await stats.flushRows(query, rows);

  const report = await stats.visitReport(query, 7);
  assert.deepEqual(Object.keys(report).sort(),
    ['daily', 'days', 'topPages', 'topReferrers', 'totals', 'unique_visitors', 'unique_visitors_note']);
  assert.equal(report.days, 7);
  assert.equal(report.unique_visitors, null);
  assert.ok(report.unique_visitors_note.length > 10);
  assert.deepEqual(report.totals, { views: 273, visits: 113 });
  assert.deepEqual(report.daily, [{ date: day, views: 273, visits: 113, uniques: null }]);

  // Exactly the 25 busiest pages are named; everything quieter or beyond 25 folds into (other).
  const named = report.topPages.filter((r) => r.path !== '(other)');
  assert.equal(named.length, 25);
  assert.deepEqual(new Set(named.map((r) => r.path)), new Set([...Array(25).keys()].map((i) => P(`page-${i}`))));
  assert.ok(named.every((r) => r.views === 10 && r.visits === 4));
  assert.ok(report.topPages.every((r) => r.path === '(other)' || r.views >= stats.MIN_REPORT_COUNT));
  assert.deepEqual(report.topPages.at(-1), { path: '(other)', views: 23, visits: 13 });

  // A referrer with a single visit is never named either.
  assert.deepEqual(report.topReferrers, [
    { referrer_host: 'ref-a.example', visits: 4 },
    { referrer_host: '(other)', visits: 1 },
  ]);
});

test('the operator endpoint refuses a missing or short token and a wrong bearer', async () => {
  const app = express();
  visitCounter.install(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/operator/visits`;
  try {
    delete process.env.VISIT_STATS_TOKEN;
    assert.equal((await fetch(url)).status, 404);
    process.env.VISIT_STATS_TOKEN = 'x'.repeat(31);
    assert.equal((await fetch(url)).status, 404);
    process.env.VISIT_STATS_TOKEN = 'v'.repeat(48);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${'w'.repeat(48)}` } })).status, 401);
  } finally {
    server.close();
    delete process.env.VISIT_STATS_TOKEN;
  }
});

test('with the real token the endpoint flushes and serves the report, and never counts itself', { skip: !DB_OK }, async () => {
  await query(stats.SCHEMA_SQL);
  const app = express();
  visitCounter.install(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/operator/visits`;
  const token = `visit-stats-test-${crypto.randomBytes(16).toString('hex')}`;
  process.env.VISIT_STATS_TOKEN = token;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    const report = await res.json();
    assert.ok(Array.isArray(report.daily));

    // The endpoint's own requests are API calls, not pages: a second read is identical.
    const res2 = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res2.status, 200);
    const report2 = await res2.json();
    assert.deepEqual(report2.totals, report.totals);
    assert.ok(!report2.topPages.some((p) => String(p.path).includes('/api/')));
  } finally {
    server.close();
    delete process.env.VISIT_STATS_TOKEN;
  }
});
