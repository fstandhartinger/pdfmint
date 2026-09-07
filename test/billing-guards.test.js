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

  const calls = { checkoutCreate: [], subUpdate: [], portal: [], expire: [], cancel: [], sessionRetrieve: null };
  // Stripe stores the response body against an idempotency key for 24 hours and
  // REPLAYS it verbatim on the next request carrying the same key. That replay is
  // the whole of finding D, so the mock has to do it too; a mock that quietly
  // performs the operation again cannot see the bug.
  const idempotent = new Map();
  const replay = async (options, produce) => {
    const key = options && options.idempotencyKey;
    if (key && idempotent.has(key)) return JSON.parse(JSON.stringify(idempotent.get(key)));
    const made = await produce();
    if (key) idempotent.set(key, JSON.parse(JSON.stringify(made)));
    return made;
  };
  let invoices = JSON.parse(JSON.stringify(opts.invoices || []));
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
      retrieve: async (id) => {
        // Stripe is asked about subscriptions in two places now, so this has to
        // behave like Stripe: an id it does not hold is a 404, not a helpful
        // stand-in. A lenient stub here would let a test pass because the mock
        // invented an active subscription.
        if (opts.failRetrieve) throw new Error('injected Stripe outage on subscriptions.retrieve');
        const found = subscriptions.find((s) => s.id === id);
        if (found) return JSON.parse(JSON.stringify(found));
        const e = new Error('No such subscription: ' + id);
        e.code = 'resource_missing'; e.statusCode = 404;
        throw e;
      },
      update: async (id, args, options) => {
        calls.subUpdate.push({ id, args, options });
        return replay(options, async () => {
          const before = subscriptions.find((x) => x.id === id);
          const after = {
            ...before,
            items: { data: [{ ...before.items.data[0], price: { id: args.items[0].price } }] },
            latest_invoice: { hosted_invoice_url: 'https://invoice.invalid/i1' },
          };
          if (opts.pendingUpdate) after.pending_update = { expires_at: 1 };
          subscriptions = subscriptions.map((x) => (x.id === id ? after : x));
          return after;
        });
      },
      // Cancelling an incomplete subscription voids its open invoice, and Stripe
      // then refuses a late payment outright.
      cancel: async (id) => {
        calls.cancel.push(id);
        const sub = subscriptions.find((x) => x.id === id);
        if (sub) sub.status = sub.status === 'incomplete' ? 'incomplete_expired' : 'canceled';
        const invId = sub && (typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id);
        const inv = invoices.find((x) => x.id === invId);
        if (inv) inv.status = 'void';
        return sub || { id, status: 'canceled' };
      },
    },
    checkout: {
      sessions: {
        create: async (args, options) => {
          calls.checkoutCreate.push({ args, options });
          return replay(options, async () => {
            const made = { id: `cs_${++seq}`, status: 'open', url: `https://checkout.invalid/cs_${seq}`, ...args };
            sessions.push(made);
            return made;
          });
        },
        // A real list reflects what expire() did; a static one cannot show that a
        // replayed session is dead.
        list: async (params = {}) => {
          const all = [...(opts.openSessions || []), ...sessions];
          const data = params.status ? all.filter((x) => (x.status || 'open') === params.status) : all;
          return { data, has_more: false };
        },
        expire: async (id) => {
          calls.expire.push(id);
          const found = sessions.find((x) => x.id === id) || (opts.openSessions || []).find((x) => x.id === id);
          if (found) found.status = 'expired';
          return found || { id, status: 'expired' };
        },
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
    invoices: {
      retrieve: async (id) => {
        if (opts.invoiceUnreadable) throw new Error('injected: invoice unreadable');
        const found = invoices.find((x) => x.id === id);
        if (!found) {
          const e = new Error('No such invoice: ' + id);
          e.code = 'resource_missing'; e.statusCode = 404;
          throw e;
        }
        return JSON.parse(JSON.stringify(found));
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
    addInvoice: (i) => invoices.push(i),
    subscriptionsNow: () => JSON.parse(JSON.stringify(subscriptions)),
    sessionsNow: () => JSON.parse(JSON.stringify(sessions)),
    invoicesNow: () => JSON.parse(JSON.stringify(invoices)),
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

  test('duplicate clicks are collapsed by the row lock, not by an idempotency key', async () => {
    // This test used to require a window-spanning idempotency key on the update.
    // Finding D showed that key is not what collapses a double click — the
    // account row lock and the re-read of Stripe inside it are — and that the key
    // actively harms: Starter -> Pro -> Starter -> Pro replayed the first
    // response and granted a plan the customer was not on. See the D suite.
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1, 'the second click finds Pro already in place');
    assert.equal(h.calls.checkoutCreate.length, 0, 'and never opens a second subscription');
    assert.ok(h.calls.subUpdate.every((u) => !(u.options && u.options.idempotencyKey)));
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
    //
    // Finding B added one condition: the buyer gets a payment page, but the
    // abandoned attempt must be made unpayable first, or the two sit there
    // side by side and both can be paid. The attempt here is for Starter and the
    // buyer is now asking for Pro, so it is cancelled rather than resumed. The
    // original object had no `latest_invoice` at all, which an `incomplete`
    // subscription in Stripe never does; it now has one.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = existingSub(h);
    sub.id = 'sub_incomplete';
    sub.status = 'incomplete';
    sub.latest_invoice = 'in_incomplete';
    h.addSubscription(sub);
    h.addInvoice({
      id: 'in_incomplete', status: 'open', hosted_invoice_url: 'https://invoice.invalid/in_incomplete',
      payment_intent: { id: 'pi_i', status: 'requires_payment_method' },
    });
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer must get a payment page');
    assert.equal(h.calls.portal.length, 0, 'a dead end for 24 hours is still not acceptable');
    assert.deepEqual(h.calls.cancel, ['sub_incomplete'], 'and the old attempt must not stay payable beside it');
    assert.equal(h.invoicesNow()[0].status, 'void');
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

/**
 * C5 — whether a customer keeps what they paid for cannot depend on delivery order.
 *
 * Found in MailMint on 2026-09-06 by paying and watching (mailmint-REPORT.md F3,
 * c5-out-of-order-evidence.txt), and asked of PDFMint here because PDFMint's live
 * webhook endpoint is enabled for `customer.subscription.created` — MailMint's is not.
 *
 * Stripe emits a purchase's four events at once and delivers them concurrently, in
 * no guaranteed order. Every body is a SNAPSHOT of the moment it was emitted, and
 * `customer.subscription.created` is emitted the instant the subscription exists,
 * which for a card payment is BEFORE the card is charged. Its body therefore reads
 * `status: "incomplete"` every single time. Acted on as written and processed last,
 * it applies the free plan and clears the subscription id on an account Stripe holds
 * an active, paid subscription for.
 */
describe('C5 — a paid plan must not depend on which webhook lands last', () => {
  const CUS = 'cus_guards';
  const SUB = 'sub_ordering';

  // What Stripe holds once the card has cleared. This is the truth every one of
  // the four events below is a stale or partial view of.
  const authoritative = (h, status = 'active', plan = 'starter') => ({
    id: SUB, customer: CUS, status,
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_ordering', price: { id: h.priceOf(plan) }, quantity: 1 }] },
  });

  // The four real bodies, with the statuses Stripe really puts in them.
  const bodies = (h) => ({
    'checkout.session.completed': {
      id: 'evt_cs', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_ordering', payment_status: 'paid', status: 'complete', subscription: SUB,
        client_reference_id: '71', customer: CUS, metadata: { account_id: '71', plan: 'starter' },
      } },
    },
    'invoice.paid': {
      id: 'evt_inv', type: 'invoice.paid',
      data: { object: { id: 'in_ordering', customer: CUS, subscription: SUB, paid: true } },
    },
    'customer.subscription.updated': {
      id: 'evt_upd', type: 'customer.subscription.updated',
      data: { object: { ...authoritative(h), status: 'active' } },
    },
    // The one that does the damage: emitted before the charge, so `incomplete`.
    'customer.subscription.created': {
      id: 'evt_new', type: 'customer.subscription.created',
      data: { object: { ...authoritative(h), status: 'incomplete' } },
    },
  });

  const fresh = () => {
    const h = load({ account: { stripe_customer_id: CUS } });
    h.addSubscription(authoritative(h));
    return h;
  };

  test('the order observed in production: `created` lands last and must not undo the purchase', async () => {
    const h = fresh();
    const e = bodies(h);
    for (const type of ['invoice.paid', 'checkout.session.completed',
                        'customer.subscription.updated', 'customer.subscription.created']) {
      await h.fireEvent(e[type]);
    }
    assert.equal(h.account.plan, 'starter', 'the customer paid; the last webhook must not take it away');
    assert.equal(h.account.stripe_subscription_id, SUB, 'and the subscription id must still be there to manage');
    assert.equal(Number(h.quota()), h.PLANS.starter.credits);
  });

  test('every one of the 24 delivery orders ends in the plan that was paid for', async () => {
    const types = ['checkout.session.completed', 'invoice.paid',
                   'customer.subscription.updated', 'customer.subscription.created'];
    const perms = (xs) => (xs.length <= 1 ? [xs]
      : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
    const orders = perms(types);
    assert.equal(orders.length, 24);
    const broken = [];
    for (const order of orders) {
      const h = fresh();
      const e = bodies(h);
      for (const type of order) await h.fireEvent(e[type]);
      if (h.account.plan !== 'starter' || h.account.stripe_subscription_id !== SUB) {
        broken.push(`${order.join(' -> ')} ended on ${h.account.plan}/${h.account.stripe_subscription_id}`);
      }
    }
    assert.deepEqual(broken, [], `delivery order decided the outcome:\n${broken.join('\n')}`);
  });

  test('a cancellation Stripe agrees with still downgrades, as it must', async () => {
    const h = load({ account: paying({ stripe_customer_id: CUS, stripe_subscription_id: SUB }) });
    h.addSubscription(authoritative(h, 'canceled'));
    await h.fireEvent({
      id: 'evt_cancel', type: 'customer.subscription.deleted',
      data: { object: { ...authoritative(h, 'canceled') } },
    });
    assert.equal(h.account.plan, 'free', 'asking Stripe must not have made cancellation impossible');
    assert.equal(h.account.stripe_subscription_id, null);
  });

  test('a stale ACTIVE body does not resurrect a subscription Stripe has cancelled', async () => {
    // The mirror of the bug: a late `updated` whose body still says active, for a
    // subscription that has since been cancelled, must not hand the plan back.
    const h = load({ account: paying({ stripe_customer_id: CUS, stripe_subscription_id: SUB }) });
    h.addSubscription(authoritative(h, 'canceled'));
    await h.fireEvent({
      id: 'evt_stale_active', type: 'customer.subscription.updated',
      data: { object: { ...authoritative(h, 'active') } },
    });
    assert.equal(h.account.plan, 'free');
  });

  test('a Stripe outage falls back to the event body rather than losing the plan', async () => {
    // Asking Stripe is better information, not a new dependency to fail on. When
    // the call fails this must do exactly what it did before: believe the body.
    const h = load({ account: { stripe_customer_id: CUS }, failRetrieve: true });
    h.addSubscription(authoritative(h));
    await h.fireEvent({
      id: 'evt_outage', type: 'customer.subscription.updated',
      data: { object: { ...authoritative(h), status: 'active' } },
    });
    assert.equal(h.account.plan, 'starter', 'an outage must not silently strip a paying customer');
    assert.equal(h.account.stripe_subscription_id, SUB);
  });

  test("a foreign product's subscription is refused before Stripe is called at all", async () => {
    // A sibling product's event must not cost us a Stripe call or a row lock.
    const h = load({ account: paying({ stripe_customer_id: CUS, stripe_subscription_id: 'sub_mine' }), failRetrieve: true });
    await h.fireEvent({
      id: 'evt_foreign_no_call', type: 'customer.subscription.created',
      data: { object: {
        id: 'sub_of_a_sibling', status: 'incomplete', customer: 'cus_someone_else',
        metadata: { account_id: '71', plan: 'pro' },
        items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter');
    assert.equal(h.dbUpdates.length, 0, 'nothing may be written for another product');
  });
});

/**
 * B — an abandoned first attempt must never become a second subscription.
 *
 * Found in DocMint on 2026-09-06 (docmint-billing-followup-REPORT.md §2) and asked
 * of PDFMint here because the two checkout paths are the same code.
 *
 * An `incomplete` subscription is a first payment that has not cleared. It grants
 * nothing, but its invoice stays PAYABLE for about a day. Filtering it out of
 * "current" and opening a second checkout next to it is how one buyer ends up
 * paying for two plans at once — and, because the later webhook wins, ends up on
 * the cheaper one's quota.
 */
describe('B — an abandoned first attempt must never become a second subscription', () => {
  const CUS = 'cus_guards';
  const attempt = (h, plan = 'starter', over = {}) => ({
    id: 'sub_attempt', customer: CUS, status: 'incomplete',
    latest_invoice: 'in_attempt',
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_attempt', price: { id: h.priceOf(plan) }, quantity: 1 }] },
    ...over,
  });
  const openInvoice = (over = {}) => ({
    id: 'in_attempt', status: 'open', hosted_invoice_url: 'https://invoice.invalid/in_attempt',
    payment_intent: { id: 'pi_attempt', status: 'requires_payment_method' }, ...over,
  });
  const withAttempt = (plan = 'starter', invoice = openInvoice(), loadOpts = {}) => {
    const h = load({ account: { stripe_customer_id: CUS }, ...loadOpts });
    h.addSubscription(attempt(h, plan));
    if (invoice) h.addInvoice(invoice);
    return h;
  };
  const statusOf = (h, id) => (h.subscriptionsNow().find((s) => s.id === id) || {}).status;

  test('asking again for the plan they started hands back THAT invoice, not a second checkout', async () => {
    const h = withAttempt('starter');
    const out = await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second payable thing must not be created');
    assert.equal(out.url, 'https://invoice.invalid/in_attempt', 'the buyer finishes the payment they started');
    assert.equal(statusOf(h, 'sub_attempt'), 'incomplete', 'and the attempt they are paying must survive');
  });

  test('changing their mind voids the abandoned attempt before opening the new one', async () => {
    const h = withAttempt('starter');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.cancel, ['sub_attempt'], 'the abandoned attempt must be cancelled');
    assert.equal(h.invoicesNow()[0].status, 'void', 'which is what makes its invoice unpayable');
    assert.equal(h.calls.checkoutCreate.length, 1, 'and only then may a new checkout open');
  });

  test('a payment still settling is never voided, and no second checkout opens beside it', async () => {
    // The buyer may be on the 3-D Secure step in another tab. Voiding an invoice
    // whose charge is completing is how money is taken for nothing.
    for (const status of ['processing', 'requires_capture', 'succeeded']) {
      const h = withAttempt('starter', openInvoice({ payment_intent: { id: 'pi_x', status } }));
      await h.api.createCheckoutSession(h.account, 'pro');
      assert.deepEqual(h.calls.cancel, [], `a ${status} payment must not be cancelled`);
      assert.equal(h.calls.checkoutCreate.length, 0, `nor may a second payable thing open beside a ${status} payment`);
    }
  });

  test('an abandoned 3-D Secure step and a declined card ARE cleared', async () => {
    for (const status of ['requires_action', 'requires_payment_method']) {
      const h = withAttempt('starter', openInvoice({ payment_intent: { id: 'pi_x', status } }));
      await h.api.createCheckoutSession(h.account, 'pro');
      assert.deepEqual(h.calls.cancel, ['sub_attempt'], `${status} is abandoned, not settling`);
    }
  });

  test('the newer API shape, where the intent hides under payments.data', async () => {
    // Where the payment intent lives depends on the API version. Both expansions
    // are requested; whichever answers is used, so a default-version bump cannot
    // silently switch this guard off.
    const h = withAttempt('starter', openInvoice({
      payment_intent: undefined,
      payments: { data: [{ payment: { payment_intent: { id: 'pi_x', status: 'processing' } } }] },
    }));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.cancel, [], 'a settling payment must be seen on the newer shape too');
    assert.equal(h.calls.checkoutCreate.length, 0);
  });

  test('an attempt we cannot read is not voided on a guess, and blocks a second one', async () => {
    const h = withAttempt('starter', openInvoice(), { invoiceUnreadable: true });
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.cancel, [], 'nothing is voided on a guess');
    assert.equal(h.calls.checkoutCreate.length, 0, 'and no second payable thing is created');
    assert.equal(h.calls.portal.length, 1, 'the buyer goes somewhere a human can sort it out');
    assert.match(out.url, /portal/);
  });

  test('an attempt with nothing payable left is simply ignored', async () => {
    for (const status of ['paid', 'void']) {
      const h = withAttempt('starter', openInvoice({ status }));
      await h.api.createCheckoutSession(h.account, 'pro');
      assert.deepEqual(h.calls.cancel, [], `an invoice that is ${status} needs no action`);
      assert.equal(h.calls.checkoutCreate.length, 1, 'and must not block the buyer');
    }
  });

  test("a sibling product's incomplete attempt is none of our business", async () => {
    const h = load({ account: { stripe_customer_id: CUS } });
    h.addSubscription({
      id: 'sub_sibling', customer: CUS, status: 'incomplete', latest_invoice: 'in_sibling',
      metadata: { account_id: '71' },
      items: { data: [{ id: 'si_s', price: { id: 'price_of_a_sibling_product' }, quantity: 1 }] },
    });
    h.addInvoice(openInvoice({ id: 'in_sibling' }));
    await h.api.createCheckoutSession(h.account, 'starter');
    assert.deepEqual(h.calls.cancel, [], 'we do not cancel another product\'s subscription');
    assert.equal(h.calls.checkoutCreate.length, 1);
  });
});

/**
 * D — a plan switch must never hand the buyer a dead link, or a plan they are not on.
 *
 * Found in DocMint on 2026-09-06 (docmint-billing-followup-REPORT.md §3). A Stripe
 * idempotency key that spans a time window REPLAYS the response it stored, and the
 * object in that response can since have been destroyed: choosing another plan
 * expires the first checkout session. The replayed body still says `status: "open"`
 * while the session is in fact expired — so the assertions below check the state of
 * the object, never the body we were handed.
 *
 * PDFMint has a second instance of the same mechanism that DocMint does not: the
 * upgrade path keys `subscriptions.update` the same way, and there a replay grants
 * a plan the customer is not actually on at Stripe.
 */
describe('D — a plan switch must never hand back a dead session or a phantom plan', () => {
  const CUS = 'cus_guards';
  const paying = (over = {}) => ({ plan: 'starter', stripe_customer_id: CUS, stripe_subscription_id: 'sub_live', ...over });
  const liveSub = (h, plan = 'starter') => ({
    id: 'sub_live', customer: CUS, status: 'active',
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_live', price: { id: h.priceOf(plan) }, quantity: 1 }] },
  });

  test('starter, pro, starter again: the buyer is handed a session they can still pay', async () => {
    const h = load({ account: { stripe_customer_id: CUS } });
    const first = await h.api.createCheckoutSession(h.account, 'starter');
    await h.api.createCheckoutSession(h.account, 'pro');
    const again = await h.api.createCheckoutSession(h.account, 'starter');
    const live = h.sessionsNow().find((x) => x.id === again.id);
    assert.ok(live, 'the session handed back must exist');
    assert.equal(live.status, 'open',
      'the buyer must not land on "You\'re all done here" for a session that was expired in between');
    assert.notEqual(again.id, first.id, 'the first session was expired when they chose Pro');
  });

  test('the same is true a second time in a row', async () => {
    // The previous attempt at this fix passed once and then failed, so the shape
    // of the reproduction matters: run it twice.
    for (let i = 0; i < 2; i += 1) {
      const h = load({ account: { stripe_customer_id: CUS } });
      await h.api.createCheckoutSession(h.account, 'starter');
      await h.api.createCheckoutSession(h.account, 'pro');
      const again = await h.api.createCheckoutSession(h.account, 'starter');
      assert.equal(h.sessionsNow().find((x) => x.id === again.id).status, 'open', `run ${i + 1}`);
    }
  });

  test('checkout creation carries no window-spanning idempotency key', async () => {
    // What collapses a double click is the account row lock plus the reuse of the
    // OPEN session listed in the same transaction — both measured. A key that
    // spans a window adds nothing and can only replay something already dead.
    const h = load({ account: { stripe_customer_id: CUS } });
    await h.api.createCheckoutSession(h.account, 'starter');
    const options = h.calls.checkoutCreate[0].options || {};
    assert.equal(options.idempotencyKey, undefined);
  });

  test('a double click still opens exactly one checkout', async () => {
    const h = load({ account: { stripe_customer_id: CUS } });
    const a = await h.api.createCheckoutSession(h.account, 'starter');
    const b = await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the second click reuses the first click\'s open session');
    assert.equal(a.id, b.id);
  });

  test('starter, pro, starter, pro: the plan we grant is the plan Stripe is on', async () => {
    const h = load({ account: paying() });
    h.addSubscription(liveSub(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'starter');
    await h.api.createCheckoutSession(h.account, 'pro');
    const atStripe = h.subscriptionsNow().find((x) => x.id === 'sub_live').items.data[0].price.id;
    assert.equal(atStripe, h.priceOf('pro'), 'the switch back to Pro must actually happen at Stripe');
    assert.equal(h.account.plan, 'pro', 'and the quota we grant must match it');
  });

  test('the upgrade carries no window-spanning idempotency key either', async () => {
    const h = load({ account: paying() });
    h.addSubscription(liveSub(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    const options = h.calls.subUpdate[0].options || {};
    assert.equal(options.idempotencyKey, undefined);
  });

  test('two upgrade clicks still change the subscription exactly once', async () => {
    const h = load({ account: paying() });
    h.addSubscription(liveSub(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1,
      'the second click re-reads Stripe under the row lock, sees Pro, and changes nothing');
    assert.equal(h.calls.checkoutCreate.length, 0, 'and never opens a second subscription');
  });
});

/**
 * E — what the return-from-Checkout page may say when it cannot read the session.
 *
 * Raised by the cross-product handoff (pdfmint-cross-product-handoff.md, "Also
 * worth a look"). Two orderings inside `verifyCheckoutReturn` were wrong for the
 * same reason: "I could not read the price" was being reported as "this checkout
 * belongs to someone else", and expiry was decided after the price rather than
 * before it.
 */
describe('E — an unreadable session is unverified, not somebody else\'s', () => {
  const priceOf = load().priceOf;
  const session = (over = {}) => ({
    id: 'cs_real', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    client_reference_id: '71', customer: 'cus_guards', subscription: 'sub_paid',
    line_items: { data: [{ price: { id: priceOf('pro') } }] },
    metadata: { account_id: '71', plan: 'pro' }, ...over,
  });
  const mine = (over = {}) => ({ plan: 'free', stripe_customer_id: 'cus_guards', ...over });

  test('an expired session reads as expired even when its line items are gone', async () => {
    // Stripe does return line items for an expired session today — measured by the
    // sibling run — so this is about not depending on that. Expiry is a fact about
    // the session; whether we can price it is a separate question.
    const h = load({ account: mine() });
    h.addSession(session({ status: 'expired', payment_status: 'unpaid', line_items: { data: [] } }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'expired');
    assert.match(out.message, /expired/i);
    assert.doesNotMatch(out.message, /could not match/i, 'expiry is not an ownership problem');
  });

  test('a session we cannot price is unverified, never claimed as another account\'s', async () => {
    const h = load({ account: mine() });
    h.addSession(session({ line_items: { data: [] } }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'unverified', '"no price to read" is not "not yours"');
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test("a sibling product's paid session is still refused as foreign", async () => {
    // The distinction that matters: a price we CAN read and do not sell is
    // somebody else's; a price we cannot read at all is simply unknown.
    const h = load({ account: mine({ stripe_customer_id: null }) });
    h.addSession(session({
      customer: 'cus_of_the_other_product',
      line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test('none of these ever read as paid', async () => {
    for (const over of [{ line_items: { data: [] } },
                        { status: 'expired', line_items: { data: [] } },
                        { line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] } }]) {
      const h = load({ account: mine() });
      h.addSession(session(over));
      const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
      assert.notEqual(out.state, 'paid');
      assert.equal(out.ok, false);
    }
  });
});
