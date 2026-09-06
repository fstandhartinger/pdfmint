'use strict';
/**
 * C2/C3/C4 billing guards — the regression suite for the three faults found on
 * 2026-09-06 by walking the real customer journey:
 *
 *   C2  an account that already subscribed got a SECOND subscription instead of an
 *       upgrade, sibling products on the shared Stripe account could downgrade it,
 *       and a webhook that failed half way was swallowed as a duplicate on retry.
 *   C3  the dashboard printed "Payment received" because the URL said
 *       `?checkout=success`. A query parameter is not a receipt.
 *   C4  the Checkout page showed the portfolio's business name, so a buyer could
 *       not tell who was charging them.
 *
 * This file needs no database, no network and no Stripe key: src/billing.js is
 * loaded in a VM with mocked `stripe`, `./db` and `./config`, and every call it
 * makes is recorded. It therefore runs anywhere, including in CI and against a
 * copy of the file pulled out of a production container.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const BILLING = process.env.BILLING_UNDER_TEST || path.join(__dirname, '..', 'src', 'billing.js');
const SOURCE = fs.readFileSync(BILLING, 'utf8');
const PLAN_IDS = ['free', 'starter', 'pro', 'scale'];

function load(opts = {}) {
  const sizes = { free: 10, starter: 5000, pro: 50000, scale: 250000 };
  const PLANS = Object.fromEntries(PLAN_IDS.map((id) => [id, {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    credits: sizes[id],
    quota: sizes[id],
    priceUsd: { free: 0, starter: 9, pro: 29, scale: 99 }[id],
    stripePriceEnv: id === 'free' ? null : `STRIPE_PRICE_${id.toUpperCase()}`,
  }]));
  const priceOf = (id) => (id === 'free' ? null : `price_test_${id}`);

  const calls = { checkoutCreate: [], subUpdate: [], portal: [], expire: [], sessionRetrieve: null };
  const dbUpdates = [];
  const seenEvents = new Set();
  let failDb = false;
  let subscriptions = JSON.parse(JSON.stringify(opts.subscriptions || []));
  let sessions = JSON.parse(JSON.stringify(opts.sessions || []));
  let seq = 0;

  const account = Object.assign({
    id: 71, email: 'guards@example.test', plan: 'free',
    credits_limit: PLANS.free.credits, credits_used: 0,
    quota_month: PLANS.free.quota, used_month: 0,
    stripe_customer_id: null, stripe_subscription_id: null,
  }, opts.account || {});

  const stripe = {
    customers: {
      retrieve: async (id) => ({ id, deleted: false }),
      create: async (args) => ({ id: `cus_new_${++seq}`, ...args }),
    },
    subscriptions: {
      list: async () => {
        if (opts.failAfterCustomer) throw new Error('injected Stripe outage after customer creation');
        return { data: subscriptions, has_more: false };
      },
      retrieve: async (id) => subscriptions.find((s) => s.id === id) || {
        id, customer: account.stripe_customer_id || 'cus_guards', status: 'active',
        metadata: {}, items: { data: [{ id: 'si_x', price: { id: priceOf('pro') } }] },
      },
      update: async (id, args, options) => {
        calls.subUpdate.push({ id, args, options });
        const before = subscriptions.find((x) => x.id === id);
        const after = {
          ...before,
          items: { data: [{ ...before.items.data[0], price: { id: args.items[0].price } }] },
          latest_invoice: { hosted_invoice_url: 'https://invoice.invalid/i1' },
        };
        if (opts.pendingUpdate) after.pending_update = { expires_at: 1 };
        subscriptions = subscriptions.map((x) => (x.id === id ? after : x));
        return after;
      },
    },
    checkout: {
      sessions: {
        create: async (args, options) => {
          calls.checkoutCreate.push({ args, options });
          return { id: `cs_${++seq}`, url: `https://checkout.invalid/cs_${seq}`, ...args };
        },
        list: async () => ({ data: opts.openSessions || [], has_more: false }),
        expire: async (id) => { calls.expire.push(id); return { id, status: 'expired' }; },
        retrieve: async (id, options) => {
          calls.sessionRetrieve = options && options.expand;
          const found = sessions.find((x) => x.id === id);
          if (!found) {
            const e = new Error('No such checkout session');
            e.code = 'resource_missing'; e.statusCode = 404;
            throw e;
          }
          return found;
        },
      },
    },
    billingPortal: { sessions: { create: async (args) => { calls.portal.push(args); return { url: 'https://portal.invalid' }; } } },
    webhooks: { constructEvent: (body) => body },
  };

  const runQuery = async (sql, args = []) => {
    const s = String(sql);
    if (/INSERT INTO stripe_events/i.test(s)) {
      if (seenEvents.has(args[0])) return { rowCount: 0, rows: [] };
      seenEvents.add(args[0]);
      return { rowCount: 1, rows: [] };
    }
    if (/^\s*SELECT/i.test(s)) {
      if (/WHERE\s+id\s*=/i.test(s)) return { rows: String(args[0]) === String(account.id) ? [{ ...account }] : [] };
      if (/stripe_customer_id\s*=\s*\$/i.test(s)) {
        return { rows: args[0] && args[0] === account.stripe_customer_id ? [{ ...account }] : [] };
      }
      return { rows: [{ ...account }] };
    }
    if (/UPDATE\s+accounts/i.test(s)) {
      if (failDb) throw new Error('injected DB failure');
      dbUpdates.push({ sql: s.replace(/\s+/g, ' ').trim(), args });
      for (const [, col, idx] of s.matchAll(/(\w+)\s*=\s*(?:COALESCE\([^,]+,\s*)?\$(\d+)/g)) {
        if (col === 'id') continue;
        if (col === 'stripe_customer_id' && /COALESCE/i.test(s) && account.stripe_customer_id) continue;
        account[col] = args[Number(idx) - 1];
      }
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };

  const tx = async (fn) => {
    const markers = new Set(seenEvents);
    const writes = dbUpdates.length;
    try {
      return await fn({ query: runQuery });
    } catch (e) {
      seenEvents.clear();
      markers.forEach((m) => seenEvents.add(m));
      dbUpdates.length = writes;         // ROLLBACK
      throw e;
    }
  };

  const expressMock = {
    Router: () => {
      const r = { _routes: {}, post: (p, ...h) => { r._routes[p] = h[h.length - 1]; }, get() {}, use() {} };
      return r;
    },
    raw: () => (req, res, next) => next && next(),
    json: () => (req, res, next) => next && next(),
  };
  const logStub = { info() {}, warn() {}, error() {}, debug() {} };
  const requireMock = (name) => {
    if (name === 'express') return expressMock;
    if (name === 'stripe') return function StripeCtor() { return stripe; };
    if (name === './config') {
      return {
        config: {
          publicUrl: 'https://product.invalid',
          billingEnabled: true,
          stripe: { secretKey: 'sk_test_guards', webhookSecret: 'whsec_guards' },
        },
        PLANS,
        planPriceId: priceOf,
        retentionFor: (p) => PLANS[p] || PLANS.free,
      };
    }
    if (name === './db') return { query: runQuery, tx, pool: {} };
    if (name === './log') return Object.assign({}, logStub, { log: logStub });
    if (name === './errors') {
      return {
        ApiError: class ApiError extends Error {
          constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
        },
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };

  const mod = { exports: {} };
  vm.runInNewContext(SOURCE, {
    require: requireMock, module: mod, exports: mod.exports,
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map,
    Promise, Error, RegExp, setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: BILLING });

  const api = mod.exports;
  const fireEvent = async (event) => {
    if (typeof api.handleEvent === 'function') return api.handleEvent(event);
    const route = api.router._routes['/webhook'];
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json: (body) => resolve(body),
        send: (body) => resolve({ body }),
      };
      Promise.resolve(route({ body: event, get: () => 'sig' }, res, reject)).catch(reject);
    });
  };

  return {
    api, account, calls, dbUpdates, priceOf, PLANS, fireEvent,
    setFailDb: (v) => { failDb = v; },
    quota: () => (account.quota_month !== undefined && api.BRAND_NAME === 'MailMint' ? account.quota_month : account.credits_limit),
    addSubscription: (s) => subscriptions.push(s),
    addSession: (s) => sessions.push(s),
  };
}

const BRAND = load().api.BRAND_NAME;
const paying = (over = {}) => ({ plan: 'starter', stripe_customer_id: 'cus_guards', stripe_subscription_id: 'sub_existing', ...over });
const existingSub = (h, plan = 'starter') => ({
  id: 'sub_existing', customer: 'cus_guards', status: 'active',
  metadata: { account_id: '71', plan },
  items: { data: [{ id: 'si_existing', price: { id: h.priceOf(plan) }, quantity: 1 }] },
});

describe('C2 — an existing subscription is changed, never duplicated', () => {
  test('two upgrade clicks update the subscription and open no checkout', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second subscription must never be created');
    assert.ok(h.calls.subUpdate.length >= 1, 'the existing subscription must be updated');
  });

  test('duplicate clicks carry one idempotency key, so Stripe collapses them', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    const keys = h.calls.subUpdate.map((u) => u.options && u.options.idempotencyKey);
    assert.ok(keys.every(Boolean), 'every update must carry an idempotency key');
    assert.equal(new Set(keys).size, 1, 'the same click twice must reuse one key');
  });

  test('the upgrade is prorated, and a pending payment grants no quota yet', async () => {
    const h = load({ pendingUpdate: true, account: paying() });
    h.addSubscription(existingSub(h));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    const update = h.calls.subUpdate[0];
    assert.equal(update.args.proration_behavior, 'always_invoice');
    assert.equal(update.args.payment_behavior, 'pending_if_incomplete');
    assert.notEqual(h.quota(), h.PLANS.pro.credits, 'quota must not move before the invoice is paid');
    assert.match(out.url, /invoice|checkout=pending/, 'the customer is sent to the unpaid invoice');
  });

  test('a subscription that is not cleanly active goes to the billing portal', async () => {
    const h = load({ account: paying() });
    const sub = existingSub(h);
    sub.status = 'past_due';
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 0);
    assert.equal(h.calls.checkoutCreate.length, 0);
    assert.equal(h.calls.portal.length, 1);
  });
});

describe('C2 — a half-finished checkout leaves nothing broken behind', () => {
  test('an incomplete first payment still lets the buyer pay again', async () => {
    // Stripe keeps a failed first payment as `incomplete` for about a day. It
    // granted nothing, so parking the buyer in a billing portal for 24 hours
    // instead of a payment page was a revenue bug, not a safety measure.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = existingSub(h);
    sub.id = 'sub_incomplete';
    sub.status = 'incomplete';
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer must get a payment page');
    assert.equal(h.calls.portal.length, 0);
  });

  test('a checkout that fails afterwards keeps the Stripe customer it created', async () => {
    // The customer is a real, permanent Stripe object holding the buyer's email.
    // Rolling its id back while the object survives mints a fresh orphan on every
    // retry, and nothing ever reclaims them.
    const h = load({ account: { stripe_customer_id: null }, failAfterCustomer: true });
    await assert.rejects(() => h.api.createCheckoutSession(h.account, 'pro'));
    assert.match(String(h.account.stripe_customer_id), /^cus_/,
      'the id must be committed even though the checkout failed');
  });
});

describe('C2 — one Stripe account serves several products', () => {
  test("a sibling product's cancellation cannot downgrade this account", async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_foreign', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_foreign', status: 'canceled', customer: 'cus_someone_else',
        metadata: { account_id: '71', plan: 'pro', service: 'other-product' },
        items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a paying customer must not be downgraded by another product');
    assert.equal(h.dbUpdates.length, 0, 'and nothing at all may be written');
  });

  test('an event for a different Stripe customer is not applied here', async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_wrongcustomer', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_of_another_customer', status: 'active', customer: 'cus_not_ours',
        metadata: { account_id: '71', plan: 'scale' },
        items: { data: [{ price: { id: h.priceOf('scale') } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a matching numeric id is not proof of ownership');
  });

  test('a stale subscription ending does not revoke the current one', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_new' }) });
    await h.fireEvent({
      id: 'evt_stale', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_old', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'starter' },
        items: { data: [{ price: { id: h.priceOf('starter') } }] },
      } },
    });
    assert.equal(h.account.plan, 'pro');
    assert.equal(h.account.stripe_subscription_id, 'sub_new');
  });

  test('cancelling the CURRENT subscription still downgrades, as it must', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_own_cancel', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_mine', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
        items: { data: [{ price: { id: h.priceOf('pro') } }] },
      } },
    });
    assert.equal(h.account.plan, 'free', 'the guards must not have made cancellation impossible');
  });
});

describe('C2 — a webhook that fails is retried for real', () => {
  const event = {
    id: 'evt_retry', type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_retry', payment_status: 'paid', subscription: 'sub_paid',
      client_reference_id: '71', customer: 'cus_guards',
      metadata: { account_id: '71', plan: 'pro' },
    } },
  };

  test('a failure rolls the idempotency marker back, so the retry fulfils', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    h.setFailDb(true);
    await assert.rejects(() => h.fireEvent(event));
    h.setFailDb(false);
    const retry = await h.fireEvent(event);
    assert.ok(!retry.duplicate, 'the retry must not be swallowed as a duplicate');
    assert.equal(h.account.plan, 'pro', 'the customer paid, so the plan must land');
  });

  test('a genuine duplicate delivery is still a no-op', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent(event);
    const writes = h.dbUpdates.length;
    const again = await h.fireEvent(event);
    assert.ok(again.duplicate, 'the second delivery is a duplicate');
    assert.equal(h.dbUpdates.length, writes, 'and writes nothing further');
  });

  test('an unpaid checkout session grants no plan', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_incomplete', customer: 'cus_guards', status: 'incomplete',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent({
      id: 'evt_unpaid', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_unpaid', payment_status: 'unpaid', subscription: 'sub_incomplete',
        client_reference_id: '71', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
      } },
    });
    assert.equal(h.account.plan, 'free');
  });
});

describe('C3 — a query parameter is not a receipt', () => {
  const priceOf = load().priceOf;
  const session = (over = {}) => ({
    id: 'cs_real', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    client_reference_id: '71', customer: 'cus_guards', subscription: 'sub_paid',
    line_items: { data: [{ price: { id: priceOf('pro') } }] },
    metadata: { account_id: '71', plan: 'pro' }, ...over,
  });

  test('the dashboard exposes a server-side verifier at all', () => {
    assert.equal(typeof load().api.verifyCheckoutReturn, 'function',
      'without this the page can only be trusting ?checkout=success');
  });

  test('a forged ?checkout=success on a free account claims nothing', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a forged ?checkout=success on an ALREADY-PAID account claims nothing', async () => {
    // An existing paid plan proves an earlier payment, never THIS checkout.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_old' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a real, paid, already-fulfilled session is confirmed', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'paid');
    assert.equal(out.ok, true);
  });

  test('paid but not yet fulfilled reads as activating, not as live quota', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'activating');
    assert.equal(out.ok, false);
  });

  test('an unpaid session reads as pending', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ payment_status: 'unpaid', status: 'open', subscription: null }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'pending');
  });

  test("another account's session is refused", async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ client_reference_id: '999', customer: 'cus_someone_else', metadata: { account_id: '999' } }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test("a SIBLING PRODUCT's paid session claims nothing here", async () => {
    // One Stripe account sells all three products and all three number their
    // accounts from 1, so a matching account id is not proof of anything.
    const h = load({ account: { stripe_customer_id: null } });
    h.addSession(session({
      customer: 'cus_of_the_other_product',
      line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test('an unknown session id is unverified, never paid', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_does_not_exist');
    assert.notEqual(out.state, 'paid');
  });
});

describe(`C4 — the Checkout page says ${BRAND}, not the portfolio's name`, () => {
  test('the session carries branding_settings.display_name', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.equal(args.branding_settings.display_name, BRAND);
  });

  test('the success URL hands the session id back so C3 can verify it', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.match(args.success_url, /\{CHECKOUT_SESSION_ID\}/);
  });
});
