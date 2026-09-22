'use strict';

// Close-out tests for the first-party visitor statistics (V2f, round pdfmint-r0-655ce7da):
// the fail-closed operator endpoint, the VISIT_STATS_DISABLED kill switch and the real
// end-to-end counting path through the full server.
//
// Environment contract:
// (a) The full-suite classification runs execute the whole suite with
//     RATE_LIMIT_BURST=300 ALLOW_PRIVATE_NETWORK=1 so every file sees the same stable rate
//     budget (pinned baseline F6). This file inherits both from the environment and pins the
//     same values on the local server it boots, keeping its budget identical to the suite.
// (b) VISIT_STATS_DISABLED is NOT a suite env flag. src/visit-counter.js captures it at module
//     load, so it is only ever set per-process, inside the T2 test below (with a require-cache
//     bust and a fresh globalThis.__pdfmintVisitStats) and restored immediately after — never
//     exported from a shared test env, where it would switch off counting for every other file.
//
// Everything runs locally: the disposable test Postgres (the DSN the other tests read from
// DATABASE_URL; the documented disposable endpoint for this round is
// postgresql://pdfmint:pdfmint@127.0.0.1:55436/pdfmint_test) and a real `node src/server.js`
// child on a random 127.0.0.1 port. No request and no URL input ever leaves the machine.

// The disposable local test database; an explicit DATABASE_URL (the other tests' convention) wins.
process.env.DATABASE_URL ||= 'postgresql://pdfmint:pdfmint@127.0.0.1:55436/pdfmint_test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const stats = require('../src/visit-stats');
const visitCounter = require('../src/visit-counter');
const { query, pool } = require('../src/db');

// Database-backed tests only ever run against the local test database, never against production.
const DB_OK = !!process.env.DATABASE_URL && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL);

const ROOT = path.join(__dirname, '..');

// A test-only operator token, generated fresh every run. It exists only in this process and
// in the env of the local test server spawned below — never a real secret.
const TEST_TOKEN = `v2f-test-${crypto.randomBytes(24).toString('hex')}`;

// Unique per-run referrer hosts, so assertions can never match rows from an earlier run.
const TAG = crypto.randomBytes(6).toString('hex');
const REF_HOST = `v2f-${TAG}.example.org`;
const BOT_REF_HOST = `v2fbot-${TAG}.example.org`;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Matches the BOT_UA regex in src/visit-stats.js (…|monitor|…).
const MONITOR_BOT_UA = 'Mozilla/5.0 (compatible; pdfmint-monitor-bot/1.0)';

const browserHeaders = (extra = {}) => ({
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-dest': 'document',
  ...extra,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Grab a free loopback port for the child server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let server = null;

/**
 * Boot the real service (`node src/server.js`) as a child process on a random local port,
 * with the test-only operator token in its env, and wait until /healthz answers.
 */
async function startServer() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const env = {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_URL,
      VISIT_STATS_TOKEN: TEST_TOKEN,
      ALLOW_PRIVATE_NETWORK: '1',
      RATE_LIMIT_BURST: '300',
      JOBS_WORKER: '0', // the test process owns the database interactions here
    };
    // Nothing from the shell may leak into the test server.
    delete env.PUBLIC_URL; // no canonical-host 301s on 127.0.0.1
    delete env.VISIT_STATS_DISABLED; // the T2 kill switch is per-process only
    delete env.STRIPE_SECRET_KEY; // no external calls, ever
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    const base = `http://127.0.0.1:${port}`;
    let exitInfo = null;
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; });

    let healthy = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !exitInfo) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) { healthy = true; break; }
      } catch { /* not listening yet */ }
      await sleep(150);
    }
    if (healthy) return { child, base };
    const why = exitInfo
      ? `server exited early (code=${exitInfo.code} signal=${exitInfo.signal})`
      : 'server never became healthy';
    lastError = new Error(`${why}\n${out.join('')}`);
    if (!exitInfo) child.kill('SIGKILL');
    await sleep(100);
  }
  throw lastError;
}

function stopServer(s) {
  if (!s) return;
  s.child.kill('SIGTERM');
  setTimeout(() => { try { s.child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
}

after(async () => {
  // T2 restore: drop the cache-busted module, its global state (including any flush timer
  // the control request started) and the per-process kill-switch env var.
  if (globalThis.__pdfmintVisitStats?.timer) clearInterval(globalThis.__pdfmintVisitStats.timer);
  delete require.cache[require.resolve('../src/visit-counter')];
  delete globalThis.__pdfmintVisitStats;
  delete process.env.VISIT_STATS_DISABLED;

  stopServer(server);
  if (DB_OK) {
    // Exact own-row cleanup: only this run's unique referrer hosts are removed.
    await query('DELETE FROM visit_daily WHERE referrer_host = $1 OR referrer_host = $2', [REF_HOST, BOT_REF_HOST]);
  }
  await pool.end();
});

test('T1: a failing report query answers 503 statistics_unavailable, never a zeroed report', { skip: !DB_OK }, async () => {
  server = await startServer();
  const auth = { authorization: `Bearer ${TEST_TOKEN}` };
  const operator = async () => {
    const res = await fetch(`${server.base}/api/operator/visits`, { headers: auth });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };

  // Healthy control: with the table in place the endpoint answers 200 with a real report.
  // This read also caches the counter's initialised schema, so the dropped table below is a
  // genuine report failure instead of being silently re-created by the lazy schema path.
  await query(stats.SCHEMA_SQL);
  const healthy = await operator();
  assert.equal(healthy.status, 200);
  assert.ok(Array.isArray(healthy.body.daily));

  // Break the report: the table the report query reads is gone.
  await query('DROP TABLE visit_daily');
  try {
    const broken = await operator();
    assert.equal(broken.status, 503);
    assert.deepEqual(broken.body, { error: 'statistics_unavailable' });
    assert.equal(broken.headers.get('cache-control'), 'no-store');
    assert.equal(broken.headers.get('x-robots-tag'), 'noindex, nofollow');
  } finally {
    await query(stats.SCHEMA_SQL); // leave the table in place for everything else
  }
});

test('T3: a browser page load is counted end-to-end; the monitor-bot UA is not counted', { skip: !DB_OK }, async () => {
  if (!server) server = await startServer();
  const loadPage = async (ua, referer) => {
    // The query marker keeps this page load unique per run; classification only sees the path.
    const res = await fetch(`${server.base}/privacy?ref=${TAG}`, {
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml',
        'sec-fetch-dest': 'document',
        referer,
      },
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  };
  await loadPage(BROWSER_UA, `https://${REF_HOST}/search?q=pdfmint`);
  await loadPage(MONITOR_BOT_UA, `https://${BOT_REF_HOST}/search?q=pdfmint`);

  // Flush through the same exported path the operator endpoint uses (readReport -> flush).
  // The operator report's k-anonymity fold (MIN_REPORT_COUNT) only affects the report; the
  // assertion below is on the raw visit_daily table rows.
  const flushed = await fetch(`${server.base}/api/operator/visits`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  assert.equal(flushed.status, 200);
  const day = stats.dayOf(Date.now());

  // The counted browser visit: today, /privacy, this run's unique referrer host.
  let row = null;
  for (let i = 0; i < 20 && !row; i++) {
    const { rows } = await query(
      'SELECT views, visits FROM visit_daily WHERE day = $1 AND path = $2 AND referrer_host = $3',
      [day, '/privacy', REF_HOST],
    );
    row = rows[0] ?? null;
    if (!row) await sleep(100);
  }
  assert.ok(row, `no visit_daily row for referrer ${REF_HOST}`);
  assert.ok(row.views >= 1, 'views must be at least 1');
  assert.ok(row.visits >= 1, 'the external referrer makes it a visit');

  // Negative control: the monitor bot loaded the same page but must not be counted.
  const bot = await query(
    'SELECT 1 FROM visit_daily WHERE day = $1 AND path = $2 AND referrer_host = $3',
    [day, '/privacy', BOT_REF_HOST],
  );
  assert.equal(bot.rowCount, 0);
});

test('T2: VISIT_STATS_DISABLED=1 makes the middleware record nothing (per-process kill switch)', async () => {
  const counterPath = require.resolve('../src/visit-counter');
  const bust = () => {
    delete require.cache[counterPath];
    delete globalThis.__pdfmintVisitStats;
  };
  const serve = async (counter) => {
    const app = express();
    app.use(counter.middleware);
    app.get('/privacy', (req, res) => res.status(200).type('html').send('<html><body>privacy</body></html>'));
    const s = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => s.once('listening', resolve));
    return s;
  };

  let disabledApp = null;
  let enabledApp = null;
  try {
    // With the kill switch: the same browser-like page load that T3 counts records nothing.
    bust();
    process.env.VISIT_STATS_DISABLED = '1';
    disabledApp = await serve(require('../src/visit-counter'));
    const disabled = await fetch(`http://127.0.0.1:${disabledApp.address().port}/privacy`, { headers: browserHeaders() });
    assert.equal(disabled.status, 200);
    await sleep(50);
    const disabledState = globalThis.__pdfmintVisitStats;
    assert.ok(disabledState, 'a fresh counter state must exist after the cache-busted require');
    assert.equal(disabledState.acc.size(), 0);

    // Control: without the kill switch, the identical request IS recorded by the middleware.
    bust();
    delete process.env.VISIT_STATS_DISABLED;
    enabledApp = await serve(require('../src/visit-counter'));
    const enabled = await fetch(`http://127.0.0.1:${enabledApp.address().port}/privacy`, { headers: browserHeaders() });
    assert.equal(enabled.status, 200);
    await sleep(50);
    assert.equal(globalThis.__pdfmintVisitStats.acc.size(), 1);
  } finally {
    if (disabledApp) disabledApp.close();
    if (enabledApp) enabledApp.close();
    delete process.env.VISIT_STATS_DISABLED;
  }
});
