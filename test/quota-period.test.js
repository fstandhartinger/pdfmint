'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { newAccount } = require('./helpers');
const { query } = require('../src/db');
const billing = require('../src/billing');

/**
 * The monthly counter was reset in two independent places: rollPeriod() on the
 * calendar 1st, and the invoice.paid webhook on the billing anniversary. A
 * customer who subscribed on the 28th therefore got a full reset on the 1st and
 * another on the 28th — up to twice the quota that was sold to them, every
 * billing cycle. The only thing being sold is the number of documents, so this
 * was giving the product away.
 *
 * invoice.paid must start a new period only when the current one has actually
 * ended, not merely because Stripe charged the card.
 */
describe('a billing renewal must not hand out a second monthly quota', () => {
  async function row(email) {
    const { rows } = await query('SELECT * FROM accounts WHERE email = $1', [email]);
    return rows[0];
  }

  test('invoice.paid inside a period already reset this month does not zero the counter', async () => {
    const { email } = await newAccount();
    const customerId = `cus_test_${Date.now()}`;

    // The state after the calendar-1st reset: period_start is this month, and
    // the customer has since spent part of the quota they paid for.
    await query(
      `UPDATE accounts
          SET stripe_customer_id = $2,
              credits_used  = 120,
              period_start  = date_trunc('month', now() AT TIME ZONE 'UTC')
        WHERE email = $1`,
      [email, customerId],
    );

    await billing.handleEvent({
      id: `evt_test_${Date.now()}`,
      type: 'invoice.paid',
      data: { object: { customer: customerId } },
    });

    const after = await row(email);
    assert.equal(
      Number(after.credits_used), 120,
      'the renewal fell inside a period that had already been reset, so the counter must stand',
    );
  });

  test('invoice.paid does start a new period when the last one is genuinely over', async () => {
    const { email } = await newAccount();
    const customerId = `cus_test_${Date.now()}_b`;

    // period_start in a previous month: this really is a new period.
    await query(
      `UPDATE accounts
          SET stripe_customer_id = $2,
              credits_used  = 4990,
              period_start  = date_trunc('month', now() AT TIME ZONE 'UTC') - interval '2 months'
        WHERE email = $1`,
      [email, customerId],
    );

    await billing.handleEvent({
      id: `evt_test_${Date.now()}_b`,
      type: 'invoice.paid',
      data: { object: { customer: customerId } },
    });

    const after = await row(email);
    assert.equal(Number(after.credits_used), 0, 'a genuinely new period must reset the counter');
    const start = new Date(after.period_start);
    const now = new Date();
    assert.equal(start.getUTCMonth(), now.getUTCMonth(), 'the new period starts in the current month');
  });
});
