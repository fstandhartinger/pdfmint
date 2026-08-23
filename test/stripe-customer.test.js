'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BASE, newAccount } = require('./helpers');
const { query } = require('../src/db');
const billing = require('../src/billing');

/**
 * Regression: a stored Stripe customer id can stop existing at any time — deleted
 * in the dashboard, restored from a backup, account switched. When that happened
 * the checkout threw "No such customer" and answered 500, which meant the one user
 * who wanted to pay could never pay again.
 */
describe('a stale Stripe customer id must not block a payment', { skip: !billing.enabled() && 'Stripe is not configured on this deployment' }, () => {
  async function accountRow(email) {
    const { rows } = await query('SELECT * FROM accounts WHERE email = $1', [email]);
    return rows[0];
  }

  test('checkout recovers when the stored customer no longer exists', async () => {
    const { email, cookie } = await newAccount();

    // Point the account at a customer id that is certainly not in this Stripe
    // account. This is exactly the state Florian's account was left in.
    await query('UPDATE accounts SET stripe_customer_id = $2 WHERE email = $1',
      [email, 'cus_definitelyGone000001']);
    assert.equal((await accountRow(email)).stripe_customer_id, 'cus_definitelyGone000001');

    const res = await fetch(`${BASE}/dashboard/checkout`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ plan: 'starter' }).toString(),
      redirect: 'manual',
    });

    assert.equal(res.status, 303, `checkout should redirect to Stripe, got ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const location = res.headers.get('location') || '';
    assert.match(location, /^https:\/\/checkout\.stripe\.com\//, `expected a Stripe Checkout URL, got ${location}`);

    // And the healed id must be persisted, not re-derived on every attempt.
    const after = await accountRow(email);
    assert.ok(after.stripe_customer_id, 'a new customer id must be stored');
    assert.notEqual(after.stripe_customer_id, 'cus_definitelyGone000001', 'the dead id must be replaced');
    assert.match(after.stripe_customer_id, /^cus_/);

    // Clean up the customer this test created in Stripe.
    await billing.stripe.customers.del(after.stripe_customer_id).catch(() => {});
  });

  test('checkout recovers when the stored customer exists but is deleted', async () => {
    const { email, cookie } = await newAccount();
    const doomed = await billing.stripe.customers.create({ email, metadata: { pdfmint_test: 'true' } });
    await billing.stripe.customers.del(doomed.id);
    await query('UPDATE accounts SET stripe_customer_id = $2 WHERE email = $1', [email, doomed.id]);

    const res = await fetch(`${BASE}/dashboard/checkout`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ plan: 'starter' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303, `expected a redirect, got ${res.status}`);
    assert.match(res.headers.get('location') || '', /^https:\/\/checkout\.stripe\.com\//);

    const after = await accountRow(email);
    assert.notEqual(after.stripe_customer_id, doomed.id, 'the deleted customer must be replaced');
    await billing.stripe.customers.del(after.stripe_customer_id).catch(() => {});
  });

  test('the billing portal does not 500 on a stale customer either', async () => {
    const { email, cookie } = await newAccount();
    await query('UPDATE accounts SET stripe_customer_id = $2 WHERE email = $1', [email, 'cus_definitelyGone000002']);

    const res = await fetch(`${BASE}/dashboard/portal`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    assert.notEqual(res.status, 500, `the portal must not 500: ${(await res.text()).slice(0, 300)}`);
  });

  test('a failure on a browser page is a page, not a JSON blob', async () => {
    const { cookie } = await newAccount();
    const res = await fetch(`${BASE}/dashboard/checkout`, {
      method: 'POST',
      headers: { cookie, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ plan: 'no-such-plan' }).toString(),
      redirect: 'manual',
    });
    const body = await res.text();
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'a browser must get HTML');
    assert.ok(body.trim().startsWith('<!doctype'), 'the response must be a page');
    assert.doesNotMatch(body, /^\s*\{/, 'the response must not be a raw JSON blob');
    assert.match(body, /Back to the dashboard/, 'the page must offer a way back');
    assert.match(body, /[0-9a-f]{16}/, 'the page must still show the request id for support');
  });

  test('the API keeps answering JSON even when the browser gets HTML', async () => {
    const { key: k } = await newAccount();
    const res = await fetch(`${BASE}/v1/pdf`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, Accept: 'text/html', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/, '/v1 must stay JSON regardless of Accept');
    assert.equal((await res.json()).error.code, 'missing_content');
  });
});
