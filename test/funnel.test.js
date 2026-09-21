'use strict';

// Tests for the four-stage funnel report: the pure clamping/window logic, the
// database-backed aggregation (external vs internal cohort, first-render trial
// stage, paid snapshot) against the local test database, and the operator
// endpoint (auth, shape, fail-closed 503).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const funnel = require('../src/funnel');
const { SCHEMA_SQL } = require('../src/visit-stats');
const { query, pool } = require('../src/db');

// Database-backed tests only ever run against the local test database, never against production.
const DB_OK = !!process.env.DATABASE_URL && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL);

// Every row these tests insert carries this unique prefix, so the cleanup deletes exactly them.
// Letters only: a digit run of six in an email local part would make isInternalEmail classify it.
const TAG = Array.from(crypto.randomBytes(12))
  .map((b) => 'abcdefghjkmnpqrstuvwxyz'[b % 26]).slice(0, 10).join('');
const externalEmail = (n) => `funnel${TAG}${n}@gmail.com`;
const internalEmail = (n) => `pdfmint-test-${TAG}${n}@gmail.com`;
const VISIT_PATH = `/__funnel-test-${TAG}/today`;

const inserted = { accounts: [], visits: false, seeded: false };
let seededInfo = null;

/** Insert one account with a fixed created_at; usage events optional. */
async function addAccount({ email, internal = false, plan = 'free', createdAt, renderAt }) {
  const { rows: [row] } = await query(
    `INSERT INTO accounts (email, password_hash, plan, internal, created_at)
     VALUES ($1, 'x', $2, $3, $4) RETURNING id`,
    [email, plan, internal, createdAt],
  );
  inserted.accounts.push(row.id);
  if (renderAt) {
    await query(
      `INSERT INTO usage_events (account_id, kind, pages, ok, created_at)
       VALUES ($1, 'pdf', 1, true, $2)`,
      [row.id, renderAt],
    );
  }
  return row.id;
}

async function seed({ now = Date.now() } = {}) {
  if (inserted.seeded) return;
  inserted.seeded = true;
  // Midnight-safe: if real UTC midnight is less than 15 minutes away, evaluate all "today"
  // offsets against a fake now just past the next midnight so the day bucket cannot flip.
  let effective = now;
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  if (now - dayStart > 86_340_000) effective = dayStart + 86_400_000 + 15 * 60_000;
  const at = (offsetMs) => new Date(effective - offsetMs);
  const day = 86_400_000;
  // External cohort: two registrations today (one renders today -> trial start; one never
  // renders), one registration and one first render three days ago, one paid account.
  await addAccount({ email: externalEmail(1), createdAt: at(6 * 60_000), renderAt: at(3 * 60_000) });
  await addAccount({ email: externalEmail(2), createdAt: at(2 * 60_000) });
  await addAccount({ email: externalEmail(3), createdAt: at(3 * day), renderAt: at(3 * day) });
  await addAccount({ email: externalEmail(4), plan: 'starter', createdAt: at(2 * day) });
  // A failed render must not count as a trial start.
  await query(
    `INSERT INTO usage_events (account_id, kind, pages, ok, error_code, created_at)
     VALUES ($1, 'pdf', 1, false, 'render_failed', $2)`,
    [inserted.accounts[0], at(90_000)],
  );
  // Internal cohort: one internal registration today that also renders (must stay out of the
  // external numbers entirely) and one internal paid account.
  await addAccount({ email: internalEmail(1), internal: true, createdAt: at(2 * 60_000), renderAt: at(60_000) });
  await addAccount({ email: internalEmail(2), internal: true, plan: 'pro', createdAt: at(2 * day) });
  // Visits for today (the visit stage comes from the deployed visitor statistics table).
  await query(SCHEMA_SQL);
  await query(
    `INSERT INTO visit_daily (day, path, referrer_host, views, visits)
     VALUES ((($1::timestamptz) AT TIME ZONE 'UTC')::date, $2, '', 7, 5)
     ON CONFLICT (day, path, referrer_host) DO UPDATE SET views = visit_daily.views + 7,
       visits = visit_daily.visits + 5`,
    [new Date(effective), VISIT_PATH],
  );
  inserted.visits = true;
  seededInfo = {
    effectiveNow: effective,
    todayDate: new Date(effective).toISOString().slice(0, 10),
    threeDaysAgoDate: new Date(effective - 3 * day).toISOString().slice(0, 10),
  };
  return seededInfo;
}

// The test database is shared with earlier rounds' rows, so every DB assertion is a delta
// against a baseline report taken before this file seeds anything.
let baseline = null;
before(async () => {
  if (DB_OK) {
    await query(SCHEMA_SQL); // visit_daily is created lazily by the counter in production
    baseline = await funnel.funnelReport(query, 30);
  }
});

after(async () => {
  if (DB_OK && inserted.accounts.length) {
    await query('DELETE FROM accounts WHERE id = ANY($1)', [inserted.accounts]);
  }
  if (DB_OK && inserted.visits) {
    await query('DELETE FROM visit_daily WHERE path = $1', [VISIT_PATH]);
  }
  await pool.end();
});

test('clampDays: junk and zero mean the default, the cap is the 13-month retention', () => {
  assert.equal(funnel.clampDays(undefined), 30);
  assert.equal(funnel.clampDays('junk'), 30);
  assert.equal(funnel.clampDays(0), 30);
  assert.equal(funnel.clampDays(-5), 1);
  assert.equal(funnel.clampDays(1), 1);
  assert.equal(funnel.clampDays('400'), 395);
  assert.equal(funnel.clampDays(9999), 395);
});

test('windowDays: n UTC days, oldest first, today last', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  const days = funnel.windowDays(3, now);
  assert.deepEqual(days, ['2026-09-19', '2026-09-20', '2026-09-21']);
  assert.equal(funnel.windowDays(1, now)[0], '2026-09-21');
});

test('funnelReport rejects on a failing query instead of returning a zeroed report', async () => {
  const failing = () => Promise.reject(new Error('db down'));
  await assert.rejects(() => funnel.funnelReport(failing, 30), /db down/);
});

(DB_OK ? test : test.skip)('funnelReport aggregates the external funnel and keeps the internal cohort separate', async () => {
  const seeded = await seed();
  const report = await funnel.funnelReport(query, 30, seeded.effectiveNow);
  const dayIndex = (date) => report.daily.findIndex((r) => r.date === date);
  const today = report.daily[dayIndex(seeded.todayDate)];
  const threeDaysAgo = report.daily[dayIndex(seeded.threeDaysAgoDate)];
  const baseToday = baseline.daily.find((r) => r.date === seeded.todayDate) ?? { visits: 0, registrations: 0, trial_starts: 0 };
  const baseThreeDaysAgo = baseline.daily.find((r) => r.date === seeded.threeDaysAgoDate) ?? { visits: 0, registrations: 0, trial_starts: 0 };

  // Visits: only the visitor-counter rows count; the tagged row today adds 5 visits.
  assert.equal(today.visits, baseToday.visits + 5);
  assert.equal(threeDaysAgo.visits, baseThreeDaysAgo.visits);

  // Registrations: 2 external today, 1 three days ago; the internal signup must NOT count.
  assert.equal(today.registrations, baseToday.registrations + 2);
  assert.equal(threeDaysAgo.registrations, baseThreeDaysAgo.registrations + 1);

  // Trial starts: first successful render only (the failed render today must not count);
  // 1 external today, 1 three days ago; the internal render excluded.
  assert.equal(today.trial_starts, baseToday.trial_starts + 1);
  assert.equal(threeDaysAgo.trial_starts, baseThreeDaysAgo.trial_starts + 1);

  // Paid: current snapshot of external accounts only.
  assert.equal(report.totals.paid_accounts, baseline.totals.paid_accounts + 1);
  assert.equal(report.paid.by_plan.starter, (baseline.paid.by_plan.starter ?? 0) + 1);

  // Internal cohort: reported separately, never mixed into the external numbers.
  // Two internal registrations fall in the window (today and two days ago).
  assert.equal(report.internal.registrations, baseline.internal.registrations + 2);
  assert.equal(report.internal.trial_starts, baseline.internal.trial_starts + 1);
  assert.equal(report.internal.by_plan.pro, (baseline.internal.by_plan.pro ?? 0) + 1);

  // Shape honesty: no uniques, definitions present, no per-account rows anywhere.
  assert.equal(report.unique_visitors, null);
  assert.ok(report.unique_visitors_note.includes('Not measured'));
  assert.ok(report.definitions.trial_starts.includes('no separate paid trial'));
  assert.ok(report.paid.note.includes('not stored'));
  assert.ok(!JSON.stringify(report).includes('@gmail.com'));
  assert.ok(report.daily.every((r) => ['visits', 'registrations', 'trial_starts'].every((k) => Number.isInteger(r[k]))));
});

(DB_OK ? test : test.skip)('the operator endpoint: auth identical to /api/operator/visits, shape as specified, 503 never a zeroed report', async () => {
  const token = `test-token-${'x'.repeat(40)}`;
  process.env.VISIT_STATS_TOKEN = token;
  const app = express();
  funnel.install(app);
  await seed();
  const seeded = seededInfo;
  const unset = await (async () => {
    // Pin the 404 branch while the token env is under our control.
    delete process.env.VISIT_STATS_TOKEN;
    const probe = express();
    funnel.install(probe);
    const s = probe.listen(0, '127.0.0.1');
    await new Promise((resolve) => s.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/operator/funnel`);
    const status = res.status;
    s.close();
    process.env.VISIT_STATS_TOKEN = token;
    return status;
  })();
  // Bind to an ephemeral port for the endpoint tests.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, auth) => {
    const res = await fetch(`${base}${path}`, { headers: auth ? { authorization: auth } : {} });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };

  let bserver;
  try {
    assert.equal(unset, 404, 'unset token must 404 like /api/operator/visits');

    const noAuth = await call('/api/operator/funnel?days=30');
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('cache-control'), 'no-store');
    assert.equal(noAuth.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await call('/api/operator/funnel', 'Bearer wrong')).status, 401);

    const ok = await call('/api/operator/funnel?days=30', `Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.days, 30);
    assert.equal(ok.body.daily.length, 30);
    // The endpoint reads with the real clock: the seeded day is only inside its window when
    // no midnight shift happened. If it is present, its deltas must be exact.
    const seededRow = ok.body.daily.find((r) => r.date === seeded.todayDate);
    if (seededRow) {
      const baseToday = baseline.daily.find((r) => r.date === seeded.todayDate) ?? { registrations: 0 };
      assert.equal(seededRow.registrations, baseToday.registrations + 2);
    }
    assert.equal(ok.body.totals.paid_accounts, baseline.totals.paid_accounts + 1);
    assert.equal(ok.body.internal.trial_starts, baseline.internal.trial_starts + 1);
    assert.equal(ok.body.unique_visitors, null);

    const clamped = await call('/api/operator/funnel?days=9999', `Bearer ${token}`);
    assert.equal(clamped.status, 200);
    assert.ok(clamped.body.days <= 395);

    // Fail-closed: a broken database surfaces as 503, never as a zeroed report.
    const broken = express();
    funnel.install(broken, { query: () => Promise.reject(new Error('db down')) });
    bserver = broken.listen(0, '127.0.0.1');
    await new Promise((resolve) => bserver.once('listening', resolve));
    const bad = await fetch(`http://127.0.0.1:${bserver.address().port}/api/operator/funnel`,
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal(bad.status, 503);
    assert.deepEqual(await bad.json(), { error: 'statistics_unavailable' });
  } finally {
    server.close();
    if (bserver) bserver.close();
    delete process.env.VISIT_STATS_TOKEN;
  }
});
