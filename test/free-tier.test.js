'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { req, newAccount } = require('./helpers');
const { query } = require('../src/db');
const { PLANS } = require('../src/config');

/**
 * The free tier is deliberately small: enough to paste the first curl, wire up
 * an n8n node and see a real PDF, not enough to run a workflow on indefinitely.
 * It was 300, which almost no n8n user ever exhausted, so the only thing being
 * sold was never reached.
 *
 * The distinction worth protecting: running out of a quota you had and never
 * having one at all are different events, and must not share an error code.
 */
describe('the free tier', () => {
  test('is 10 documents a month, at no cost', () => {
    assert.equal(PLANS.free.credits, 10);
    assert.equal(PLANS.free.priceUsd, 0);
  });

  test('a new free account really can render', async () => {
    const { key } = await newAccount('free');
    const r = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<h1>free</h1>' } });
    assert.equal(r.res.status, 200);
    assert.equal(r.buffer.subarray(0, 5).toString('latin1'), '%PDF-');

    const me = await req('/v1/me', { key });
    assert.equal(me.json.credits_limit, 10, 'the published number must be what the account gets');
  });

  test('spending all ten gives quota_exceeded, because the quota existed', async () => {
    const { key, email } = await newAccount('free');
    await query('UPDATE accounts SET credits_used = credits_limit WHERE email = $1', [email]);

    const r = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>over</h1>' } });
    assert.equal(r.res.status, 402);
    assert.equal(r.json.error.code, 'quota_exceeded');
    assert.match(r.json.error.message, /10 documents/);
  });

  test('an account with no allowance at all is told that instead', async () => {
    const { key, email } = await newAccount('free');
    await query('UPDATE accounts SET credits_limit = 0, credits_used = 0 WHERE email = $1', [email]);

    const r = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>none</h1>' } });
    assert.equal(r.res.status, 402);
    assert.equal(r.json.error.code, 'plan_required',
      'never having had a quota is not the same event as exhausting one');
  });

  test('the paid plans still cost money and still include documents', () => {
    for (const [id, plan] of Object.entries(PLANS)) {
      if (id === 'free') continue;
      assert.ok(plan.priceUsd > 0, `${id} must be paid`);
      assert.ok(plan.credits > PLANS.free.credits, `${id} must beat the free tier`);
    }
  });
});
