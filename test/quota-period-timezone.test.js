'use strict';

// Every connection this file opens runs in Europe/Berlin, which is what the
// production database is set to. node-postgres passes PGOPTIONS to the server
// at connect time, so this must be set before src/db builds its pool.
process.env.PGOPTIONS = `${process.env.PGOPTIONS || ''} -c TimeZone=Europe/Berlin`.trim();

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const auth = require('../src/auth');
const billing = require('../src/billing');
const { migrate } = require('../src/migrate');
const { query, pool } = require('../src/db');

/**
 * The monthly counter reset on EVERY request, so no plan limit was enforced.
 *
 * period_start was written as date_trunc('month', now() AT TIME ZONE 'UTC'), a
 * timestamp without zone. Stored into a TIMESTAMPTZ column it is read in the
 * session's zone: on a Europe/Berlin database "1 Nov 00:00" became 31 Oct 23:00
 * UTC. rollPeriod() compares UTC year and month, saw October, reset the counter
 * and wrote the same wrong instant again. A database in UTC hid all of it, which
 * is why this file pins the zone itself.
 */
describe('the quota month holds on a database that is not in UTC', () => {
  const monthStartUtc = () => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  };
  const row = async (id) => (await query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];

  /** One API call as the service sees it: authenticate (which rolls the period), then charge. */
  async function request(key, accountId) {
    const account = await auth.authenticate({ get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${key}` : undefined) });
    assert.equal(String(account.id), String(accountId));
    return auth.consumeCredits(account.id, 1);
  }

  async function freshAccount() {
    const email = `quota-tz-${crypto.randomBytes(6).toString('hex')}@pdfmint.test`;
    const { account, apiKey } = await auth.createAccount(email, 'testpassword123');
    return { id: account.id, key: apiKey, account };
  }

  before(async () => {
    await migrate();
    const { rows } = await query('SHOW TimeZone');
    assert.equal(rows[0].TimeZone, 'Europe/Berlin', 'this file is only meaningful with a non-UTC session zone');
  });
  after(() => pool.end());

  test('a new account starts its period at 00:00 UTC on the 1st', async () => {
    const { account } = await freshAccount();
    assert.equal(new Date(account.period_start).toISOString(), new Date(monthStartUtc()).toISOString());
  });

  test('N requests inside one month count N, and the free allowance is enforced', async () => {
    const { id, key, account } = await freshAccount();
    const limit = Number(account.credits_limit);
    assert.ok(limit >= 2, 'the free plan must allow at least two documents for this test');

    for (let i = 1; i <= limit; i += 1) {
      const r = await request(key, id);
      assert.equal(Number(r.used), i, `request ${i} must be the ${i}th document of the month, not the first again`);
    }
    await assert.rejects(() => request(key, id), (e) => e.status === 402 && e.code === 'quota_exceeded');
    assert.equal(Number((await row(id)).credits_used), limit);
  });

  test('an account still carrying the old, zone-shifted period start is corrected once and then counts', async () => {
    const { id, key } = await freshAccount();
    // Exactly what the old code stored: a zone-less month start read as Berlin time.
    await query(
      `UPDATE accounts SET credits_used = 7,
              period_start = (date_trunc('month', now() AT TIME ZONE 'UTC'))::timestamp AT TIME ZONE 'Europe/Berlin'
        WHERE id = $1`, [id],
    );
    assert.notEqual(new Date((await row(id)).period_start).getTime(), monthStartUtc(), 'the fixture must hold the shifted instant');

    assert.equal(Number((await request(key, id)).used), 1, 'the first request after the fix starts the month over');
    assert.equal(new Date((await row(id)).period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, id)).used), 2);
    assert.equal(Number((await request(key, id)).used), 3);
  });

  test('a real month change resets the counter exactly once', async () => {
    const { id, key } = await freshAccount();
    await query(
      `UPDATE accounts SET credits_used = 9,
              period_start = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC'
        WHERE id = $1`, [id],
    );
    assert.equal(Number((await request(key, id)).used), 1, 'the new month starts from zero');
    assert.equal(new Date((await row(id)).period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, id)).used), 2, 'and is not reset a second time');
  });

  test('invoice.paid inside the current month leaves the counter alone, and writes 00:00 UTC when the month did turn', async () => {
    const { id, key } = await freshAccount();
    const customerId = `cus_test_tz_${crypto.randomBytes(6).toString('hex')}`;
    await query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1', [id, customerId]);
    await request(key, id);
    await request(key, id);

    await billing.handleEvent({ id: `evt_test_tz_${crypto.randomBytes(6).toString('hex')}`, type: 'invoice.paid', data: { object: { customer: customerId } } });
    assert.equal(Number((await row(id)).credits_used), 2, 'a renewal inside the month must not reset');

    await query(
      `UPDATE accounts SET period_start = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC'
        WHERE id = $1`, [id],
    );
    await billing.handleEvent({ id: `evt_test_tz_${crypto.randomBytes(6).toString('hex')}`, type: 'invoice.paid', data: { object: { customer: customerId } } });
    const after = await row(id);
    assert.equal(Number(after.credits_used), 0);
    assert.equal(new Date(after.period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, id)).used), 1, 'the next request counts instead of resetting again');
  });
});
