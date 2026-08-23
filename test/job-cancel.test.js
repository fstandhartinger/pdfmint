'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { req, newAccount } = require('./helpers');
const { query } = require('../src/db');

/**
 * There was no way to cancel a job. When a document large enough to exhaust the
 * renderer was submitted asynchronously, the job sat 'running' forever, the
 * credit was gone, and the stalled-job recovery re-picked it every ten minutes
 * and took the service down again each time. The only remedy was an operator
 * editing the database by hand — which is exactly what happened once.
 */
describe('an async job can be cancelled', () => {
  test('a queued job cancels, and the credit comes back', async () => {
    const { key, email } = await newAccount();

    const started = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>cancel me</h1>', async: true },
    });
    assert.equal(started.res.status, 202, JSON.stringify(started.json));
    const id = started.json.job_id;
    assert.match(id, /^job_/);

    const { rows: before } = await query('SELECT credits_used FROM accounts WHERE email = $1', [email]);

    // Take it out of the worker's reach so the test is about cancelling, not racing.
    await query(`UPDATE jobs SET status = 'queued', started_at = NULL WHERE id = $1`, [id]);

    const cancelled = await req(`/v1/jobs/${id}`, { method: 'DELETE', key });
    assert.equal(cancelled.res.status, 200, JSON.stringify(cancelled.json));
    assert.equal(cancelled.json.status, 'cancelled');

    const after = await req(`/v1/jobs/${id}`, { key });
    assert.equal(after.json.status, 'cancelled', 'the job must read back as cancelled');
    assert.equal(after.json.error.code, 'job_cancelled');

    const { rows: post } = await query('SELECT credits_used FROM accounts WHERE email = $1', [email]);
    assert.equal(Number(post[0].credits_used), Math.max(0, Number(before[0].credits_used) - 1),
      'cancelling must give the reserved credit back');
  });

  test('cancelling a finished job is refused rather than pretended', async () => {
    const { key } = await newAccount();
    const started = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>quick</h1>', async: true } });
    const id = started.json.job_id;

    await query(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [id]);

    const r = await req(`/v1/jobs/${id}`, { method: 'DELETE', key });
    assert.equal(r.res.status, 409);
    assert.equal(r.json.error.code, 'job_already_finished');
    assert.match(r.json.error.message, /succeeded/);
  });

  test('one account cannot cancel another account\'s job', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const started = await req('/v1/pdf', { method: 'POST', key: a.key, body: { html: '<h1>mine</h1>', async: true } });
    const id = started.json.job_id;

    const r = await req(`/v1/jobs/${id}`, { method: 'DELETE', key: b.key });
    assert.equal(r.res.status, 404);
    assert.equal(r.json.error.code, 'job_not_found');

    // and A's job is untouched
    const still = await req(`/v1/jobs/${id}`, { key: a.key });
    assert.notEqual(still.json.status, 'cancelled');
  });

  test('an unknown job id is a 404, not a silent success', async () => {
    const { key } = await newAccount();
    const r = await req('/v1/jobs/job_doesnotexist', { method: 'DELETE', key });
    assert.equal(r.res.status, 404);
    assert.equal(r.json.error.code, 'job_not_found');
  });
});
