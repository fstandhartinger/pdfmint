'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { newAccount } = require('./helpers');
const { query } = require('../src/db');
const billing = require('../src/billing');
const { planPriceId } = require('../src/config');

/**
 * On 2026-08-25 a live, paying customer was silently downgraded to the free plan
 * while Stripe kept charging the card. One Stripe account serves several products
 * and every webhook endpoint on it receives every event, so PDFMint's endpoint was
 * handed `customer.subscription.deleted` for a *DocMint* subscription that carried
 * the same `account_id` in its metadata. applySubscription looked the account up,
 * saw a cancelled status, and cleared plan, credits and the subscription id — even
 * though the account's own PDFMint subscription was still active.
 *
 * Two independent guards are needed, so both are tested independently.
 */
describe('a subscription event only speaks for its own product and its own subscription', () => {
  const starterPrice = planPriceId('starter');

  async function row(email) {
    const { rows } = await query('SELECT * FROM accounts WHERE email = $1', [email]);
    return rows[0];
  }

  function sub(id, status, priceId, accountId) {
    return {
      id, status, customer: 'cus_scopingtest0001',
      items: { data: [{ price: { id: priceId } }] },
      metadata: { account_id: String(accountId) },
    };
  }

  test('a foreign product\'s subscription is ignored entirely', async (t) => {
    if (!starterPrice) return t.skip('STRIPE_PRICE_STARTER not configured here');
    const { email } = await newAccount();
    const me = await row(email);

    // Put the account on a real, active PDFMint plan first.
    await billing.applySubscription(sub('sub_mine_active', 'active', starterPrice, me.id));
    const paid = await row(email);
    assert.equal(paid.plan, 'starter', 'setup: the account must be on starter');
    assert.equal(paid.stripe_subscription_id, 'sub_mine_active');

    // Now the exact event that caused the outage: another product's subscription,
    // cancelled, tagged with this same account id.
    const out = await billing.applySubscription(
      sub('sub_docmint_cancelled', 'canceled', 'price_someOtherProduct999', me.id));

    assert.equal(out && out.ignored, 'foreign_price', 'a non-PDFMint price must be refused');
    const after = await row(email);
    assert.equal(after.plan, 'starter', 'the paying customer must still be on starter');
    assert.equal(after.stripe_subscription_id, 'sub_mine_active', 'the live subscription must survive');
    assert.equal(Number(after.credits_limit), Number(paid.credits_limit));
  });

  test('cancelling an older subscription does not revoke the current one', async (t) => {
    if (!starterPrice) return t.skip('STRIPE_PRICE_STARTER not configured here');
    const { email } = await newAccount();
    const me = await row(email);

    await billing.applySubscription(sub('sub_old', 'active', starterPrice, me.id));
    await billing.applySubscription(sub('sub_new', 'active', starterPrice, me.id));
    assert.equal((await row(email)).stripe_subscription_id, 'sub_new', 'setup: now on the newer subscription');

    // Stripe delivers the old subscription's cancellation late — a real ordering.
    const out = await billing.applySubscription(sub('sub_old', 'canceled', starterPrice, me.id));

    assert.equal(out && out.ignored, 'stale_subscription');
    const after = await row(email);
    assert.equal(after.plan, 'starter', 'the account must keep the plan it is paying for');
    assert.equal(after.stripe_subscription_id, 'sub_new');
  });

  test('cancelling the CURRENT subscription still downgrades, as it must', async (t) => {
    if (!starterPrice) return t.skip('STRIPE_PRICE_STARTER not configured here');
    const { email } = await newAccount();
    const me = await row(email);

    await billing.applySubscription(sub('sub_current', 'active', starterPrice, me.id));
    assert.equal((await row(email)).plan, 'starter');

    await billing.applySubscription(sub('sub_current', 'canceled', starterPrice, me.id));

    const after = await row(email);
    assert.equal(after.plan, 'free', 'a real cancellation must still take the plan away');
    assert.equal(after.stripe_subscription_id, null);
  });

  test('a cancellation for an account with no subscription still lands on free', async (t) => {
    if (!starterPrice) return t.skip('STRIPE_PRICE_STARTER not configured here');
    const { email } = await newAccount();
    const me = await row(email);
    assert.equal((await row(email)).stripe_subscription_id, null, 'setup: no subscription yet');

    await billing.applySubscription(sub('sub_unknown', 'canceled', starterPrice, me.id));

    const after = await row(email);
    assert.equal(after.plan, 'free');
    assert.equal(after.stripe_subscription_id, null);
  });
});
