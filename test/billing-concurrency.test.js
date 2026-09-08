"use strict";
// Current worktree billing/config/db bytes, real isolated PostgreSQL; Stripe/router/log/errors are doubles.
const { test, before, after } = require("node:test");
if (!process.env.QA_BILLING_DATABASE_URL) {
  test(
    "billing PostgreSQL concurrency (set QA_BILLING_DATABASE_URL to a fresh isolated billingqa database)",
    { skip: true },
    () => {},
  );
} else {
  const target = new URL(process.env.QA_BILLING_DATABASE_URL);
  if (
    !["127.0.0.1", "localhost"].includes(target.hostname) ||
    !/^\/billingqa(?:_[a-z0-9_]+)?$/.test(target.pathname)
  )
    throw Error(
      "Billing concurrency tests require a fresh loopback billingqa fixture database",
    );
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const vm = require("node:vm");
  const path = require("node:path");
  const { Pool } = require("pg");
  const product = "pdfmint";
  assert(["pdfmint", "docmint", "mailmint"].includes(product));
  const base = path.join(__dirname, "..", "src");
  const env = {
    DATABASE_URL: process.env.QA_BILLING_DATABASE_URL,
    STRIPE_SECRET_KEY: "fixture_not_a_key",
    MAILMINT_BILLING: "1",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_PRO: "price_pro",
    STRIPE_PRICE_SCALE: "price_scale",
    PUBLIC_URL: "https://fixture.invalid",
  };
  const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  function load(file, req) {
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(base, file), "utf8"),
      {
        module,
        exports: module.exports,
        require: req,
        process: { env },
        console: silent,
        URL,
        Buffer,
        setTimeout,
        clearTimeout,
        Date,
      },
      { filename: path.join(base, file) },
    );
    return module.exports;
  }
  const cfg = load("config.js", () => {
    throw Error("unexpected config dependency");
  });
  const db = load("db.js", (n) => (n === "pg" ? { Pool } : cfg));
  let state;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const quota = product === "mailmint" ? "quota_month" : "credits_limit";
  const used = product === "mailmint" ? "used_month" : "credits_used";
  const size = (p) => cfg.PLANS[p].quota ?? cfg.PLANS[p].credits;
  const sub = (id = "sub_current", plan = "starter", status = "active") => ({
    id,
    customer: "cus_fixture",
    status,
    metadata: { account_id: "1" },
    items: {
      data: [
        {
          id: "si_fixture",
          price: { id: env["STRIPE_PRICE_" + plan.toUpperCase()] },
          quantity: 1,
        },
      ],
    },
    latest_invoice: "in_fixture",
  });
  const stripe = {
    customers: {
      retrieve: async (id) => ({ id }),
      create: async () => {
        state.customers++;
        return { id: "cus_fixture" };
      },
    },
    subscriptions: {
      list: async () => {
        if (state.listFailure) throw Error("provider list unavailable");
        return { data: copy(state.subs), has_more: false };
      },
      retrieve: async (id) => {
        state.reads++;
        if (state.failure || state.reads === state.failRead)
          throw Object.assign(Error("provider unavailable"), {
            statusCode: 503,
          });
        const found = copy(state.subs.find((s) => s.id === id));
        if (state.gate) {
          const g = state.gate;
          state.gate = null;
          g.enter();
          await g.wait;
        }
        return found;
      },
      update: async (id, args) => {
        state.updates++;
        const s = state.subs.find((s) => s.id === id);
        s.items.data[0].price.id = args.items[0].price;
        return copy(s);
      },
      cancel: async (id) => {
        state.subs.find((s) => s.id === id).status = "canceled";
        state.invoice.status = "void";
        return copy(state.subs.find((s) => s.id === id));
      },
    },
    checkout: {
      sessions: {
        list: async () => ({
          data: copy(state.sessions.filter((s) => s.status === "open")),
          has_more: false,
        }),
        create: async (args) => {
          state.creates++;
          const s = {
            ...args,
            id: "cs_" + state.creates,
            status: "open",
            url: "https://checkout.invalid/" + state.creates,
          };
          state.sessions.push(s);
          return copy(s);
        },
        expire: async (id) => {
          state.sessions.find((s) => s.id === id).status = "expired";
        },
      },
    },
    invoices: { retrieve: async () => copy(state.invoice) },
    billingPortal: {
      sessions: { create: async () => ({ url: "https://portal.invalid" }) },
    },
    webhooks: { constructEvent: (b) => b },
  };
  const routes = {};
  const billing = load("billing.js", (n) => {
    if (n === "./config") return cfg;
    if (n === "./db") return db;
    if (n === "stripe")
      return function () {
        return stripe;
      };
    if (n === "express")
      return {
        raw: () => (req, res, next) => next(),
        Router: () => ({
          post: (p, ...h) => (routes[p] = h.at(-1)),
          get() {},
          use() {},
        }),
      };
    if (n === "./log") return { ...silent, log: silent };
    if (n === "./errors")
      return {
        ApiError: class extends Error {
          constructor(status, code, message) {
            super(message);
            this.status = status;
            this.code = code;
          }
        },
      };
    throw Error(n);
  });
  const fire = async (e) => {
    if (billing.handleEvent) return billing.handleEvent(e);
    return new Promise((resolve, reject) =>
      routes["/webhook"](
        { body: e, get: () => "" },
        {
          status() {
            return this;
          },
          json: resolve,
        },
        reject,
      ),
    );
  };
  const event = (id, obj, type = "customer.subscription.updated") => ({
    id,
    type,
    data: { object: copy(obj) },
  });
  const row = async () =>
    (await db.query("SELECT * FROM accounts WHERE id=1")).rows[0];
  const markers = async () =>
    Number((await db.query("SELECT count(*) n FROM stripe_events")).rows[0].n);
  function gate() {
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      wait = new Promise((r) => (release = r));
    state.gate = { enter, wait };
    return { entered, release };
  }
  async function waitLock() {
    for (let i = 0; i < 100; i++) {
      const r = await db.query(
        "SELECT count(*) n FROM pg_stat_activity a WHERE datname=current_database() AND wait_event_type='Lock' AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='accounts'::regclass AND l.mode='RowShareLock' AND l.granted)",
      );
      if (Number(r.rows[0].n) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("No actual PostgreSQL lock wait observed");
  }
  async function reset(plan = "starter", subscription = "sub_current") {
    await db.query(
      "DROP TRIGGER IF EXISTS fail_update ON accounts; TRUNCATE accounts,stripe_events,audit",
    );
    await db.query(
      `INSERT INTO accounts(id,email,plan,credits_limit,quota_month,credits_used,used_month,stripe_customer_id,stripe_subscription_id,period_start) VALUES(1,'isolated@example.test',$1,$2,$2,123,123,'cus_fixture',$3,date_trunc('month',now() AT TIME ZONE 'UTC'))`,
      [plan, size(plan), subscription],
    );
    state = {
      subs: [sub()],
      sessions: [],
      invoice: {
        id: "in_fixture",
        status: "open",
        hosted_invoice_url: "https://invoice.invalid",
        payment_intent: { status: "requires_payment_method" },
      },
      reads: 0,
      updates: 0,
      creates: 0,
      customers: 0,
    };
  }
  async function expectPlan(plan, subscription = "sub_current", usage = 123) {
    const r = await row();
    assert.equal(r.plan, plan);
    assert.equal(Number(r[quota]), size(plan));
    assert.equal(r.stripe_subscription_id, subscription);
    assert.equal(Number(r[used]), usage);
  }
  before(async () => {
    await db.query(
      `CREATE TABLE accounts(id integer PRIMARY KEY,email text,plan text,credits_limit integer,credits_used integer,quota_month integer,used_month integer,stripe_customer_id text,stripe_subscription_id text,period_start timestamp);CREATE TABLE stripe_events(id text PRIMARY KEY);CREATE TABLE audit(id serial,plan text);CREATE FUNCTION audit_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit(plan) VALUES(NEW.plan); RETURN NEW; END $$;CREATE TRIGGER account_audit AFTER UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_account();CREATE FUNCTION reject_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture transient DB failure' USING ERRCODE='40001'; END $$;`,
    );
  });
  after(async () => {
    await db.pool.end();
  });
  test(
    product + " real DB: concurrent duplicate event commits once",
    async () => {
      await reset();
      state.subs = [sub("sub_current", "pro")];
      const e = event("evt_duplicate", sub());
      const results = await Promise.all(
        Array.from({ length: 8 }, () => fire(e)),
      );
      assert.equal(results.filter((r) => r.duplicate).length, 7);
      assert.equal(await markers(), 1);
      assert.equal(
        Number((await db.query("SELECT count(*) n FROM audit")).rows[0].n),
        1,
      );
      await expectPlan("pro");
    },
  );
  test(
    product +
      " real DB: stale incomplete snapshot after paid state cannot revoke",
    async () => {
      await reset("pro");
      state.subs = [sub("sub_current", "pro")];
      await fire(
        event(
          "evt_old_created",
          sub("sub_current", "starter", "incomplete"),
          "customer.subscription.created",
        ),
      );
      await expectPlan("pro");
    },
  );
  test(
    product + " real DB: replacement then old cancellation waits on row lock",
    async () => {
      await reset();
      state.subs = [
        sub("sub_new", "pro"),
        sub("sub_current", "starter", "canceled"),
      ];
      const g = gate();
      const replacement = fire(
        event("evt_new", state.subs[0], "customer.subscription.created"),
      );
      await g.entered;
      const stale = fire(
        event("evt_cancel", state.subs[1], "customer.subscription.deleted"),
      );
      try {
        await waitLock();
      } finally {
        g.release();
      }
      await Promise.all([replacement, stale]);
      await expectPlan("pro", "sub_new");
      assert.equal(await markers(), 2);
    },
  );
  test(
    product +
      " real DB: provider transient failure rolls back marker and same event retries",
    async () => {
      await reset();
      state.failure = true;
      const e = event(
        "evt_provider",
        sub("sub_current", "starter", "incomplete"),
      );
      await assert.rejects(fire(e), /confirm|unavailable|verif/i);
      assert.equal(await markers(), 0);
      await expectPlan("starter");
      state.failure = false;
      state.subs = [sub("sub_current", "pro")];
      await fire(e);
      assert.equal(await markers(), 1);
      await expectPlan("pro");
    },
  );
  test(
    product +
      " real DB: SQL serialization failure rolls back event and entitlement, retry succeeds",
    async () => {
      await reset();
      state.subs = [sub("sub_current", "pro")];
      await db.query(
        "CREATE TRIGGER fail_update BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION reject_update()",
      );
      const e = event("evt_db_failure", sub());
      await assert.rejects(fire(e), /fixture transient DB failure/);
      assert.equal(await markers(), 0);
      await expectPlan("starter");
      await db.query("DROP TRIGGER fail_update ON accounts");
      await fire(e);
      await expectPlan("pro");
      assert.equal(await markers(), 1);
    },
  );
  test(
    product +
      " real DB: Starter Pro Starter Pro agrees with provider and actual plan quotas without resetting usage",
    async () => {
      await reset();
      for (const plan of ["pro", "starter", "pro"]) {
        await billing.createCheckoutSession(await row(), plan);
        await expectPlan(plan);
        assert.equal(
          state.subs[0].items.data[0].price.id,
          env["STRIPE_PRICE_" + plan.toUpperCase()],
        );
      }
      assert.equal(state.updates, 3);
    },
  );
  test(
    product + " real DB: four concurrent upgrades produce one provider update",
    async () => {
      await reset();
      const account = await row();
      await Promise.all(
        Array.from({ length: 4 }, () =>
          billing.createCheckoutSession(account, "pro"),
        ),
      );
      assert.equal(state.updates, 1);
      await expectPlan("pro");
    },
  );
  test(
    product +
      " real DB: concurrent fresh checkout makes one customer and one open session",
    async () => {
      await reset("free", null);
      state.subs = [];
      await db.query("UPDATE accounts SET stripe_customer_id=NULL WHERE id=1");
      const account = await row();
      const r = await Promise.all(
        Array.from({ length: 4 }, () =>
          billing.createCheckoutSession(account, "starter"),
        ),
      );
      assert.equal(state.customers, 1);
      assert.equal(state.creates, 1);
      assert.equal(new Set(r.map((s) => s.id)).size, 1);
      await expectPlan("free", null);
    },
  );
  test(
    product + " real DB: checkout plan changes never reuse expired links",
    async () => {
      await reset("free", null);
      state.subs = [];
      for (const p of ["starter", "pro", "starter", "pro"]) {
        const r = await billing.createCheckoutSession(await row(), p);
        assert.equal(state.sessions.find((s) => s.id === r.id).status, "open");
        assert.equal(
          state.sessions.filter((s) => s.status === "open").length,
          1,
        );
      }
      assert.equal(state.creates, 4);
    },
  );
  test(
    product +
      " real DB: abandoned different-plan invoice is void before replacement checkout",
    async () => {
      await reset("free", null);
      state.subs = [sub("sub_abandoned", "starter", "incomplete")];
      await billing.createCheckoutSession(await row(), "pro");
      assert.equal(state.invoice.status, "void");
      assert.equal(state.subs[0].status, "canceled");
      assert.equal(state.creates, 1);
    },
  );
  test(
    product + " real DB: renewal duplicate does not reset current-month usage",
    async () => {
      await reset();
      const e = event(
        "evt_invoice",
        { customer: "cus_fixture" },
        "invoice.paid",
      );
      await Promise.all([fire(e), fire(e)]);
      await expectPlan("starter");
      assert.equal(await markers(), 1);
    },
  );
  test(
    product +
      " real DB: customer persists across checkout provider outage, retry reuses it",
    async () => {
      await reset("free", null);
      state.subs = [];
      await db.query("UPDATE accounts SET stripe_customer_id=NULL WHERE id=1");
      state.listFailure = true;
      await assert.rejects(
        billing.createCheckoutSession(await row(), "starter"),
        /provider list unavailable/,
      );
      assert.equal((await row()).stripe_customer_id, "cus_fixture");
      state.listFailure = false;
      await billing.createCheckoutSession(await row(), "starter");
      assert.equal(state.customers, 1);
      assert.equal(state.creates, 1);
    },
  );
  test(
    product +
      " acceptance: delayed checkout completion must not undo a later paid upgrade",
    async (t) => {
      await reset();
      const g = gate();
      const completion = fire(
        event(
          "evt_delayed_checkout",
          {
            payment_status: "paid",
            subscription: "sub_current",
            client_reference_id: "1",
          },
          "checkout.session.completed",
        ),
      );
      await g.entered;
      try {
        await billing.createCheckoutSession(await row(), "pro");
        await expectPlan("pro");
        t.diagnostic(
          "before release: " +
            JSON.stringify({
              providerPrice: state.subs[0].items.data[0].price.id,
              account: await row(),
            }),
        );
      } finally {
        g.release();
      }
      await completion;
      t.diagnostic(
        "after release: " +
          JSON.stringify({
            providerPrice: state.subs[0].items.data[0].price.id,
            account: await row(),
            eventMarkers: await markers(),
          }),
      );
      assert.equal(state.subs[0].items.data[0].price.id, "price_pro");
      await expectPlan("pro");
    },
  );
  test(
    product +
      " real DB: failure deferred until COMMIT rolls back plan, audit, and event together",
    async () => {
      await reset();
      state.subs = [sub("sub_current", "pro")];
      await db.query(
        "CREATE CONSTRAINT TRIGGER fail_update AFTER UPDATE ON accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_update()",
      );
      const e = event("evt_commit_failure", sub());
      await assert.rejects(fire(e), /fixture transient DB failure/);
      await expectPlan("starter");
      assert.equal(await markers(), 0);
      assert.equal(
        Number((await db.query("SELECT count(*) n FROM audit")).rows[0].n),
        0,
      );
      await db.query("DROP TRIGGER fail_update ON accounts");
      await fire(e);
      await expectPlan("pro");
      assert.equal(await markers(), 1);
    },
  );
  test(
    product +
      " real DB: current cancellation revokes and later replacement restores correct quota",
    async () => {
      await reset();
      state.subs = [
        sub("sub_current", "starter", "canceled"),
        sub("sub_new", "pro"),
      ];
      await fire(
        event(
          "evt_current_cancel",
          state.subs[0],
          "customer.subscription.deleted",
        ),
      );
      await expectPlan("free", null);
      await fire(
        event(
          "evt_replacement",
          state.subs[1],
          "customer.subscription.created",
        ),
      );
      await expectPlan("pro", "sub_new");
    },
  );
  test(
    product +
      " real DB: concurrent distinct renewal events roll old period exactly once",
    async () => {
      await reset();
      await db.query(
        "UPDATE accounts SET period_start=date_trunc('month',now() AT TIME ZONE 'UTC') - interval '1 month' WHERE id=1",
      );
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          fire(
            event(
              "evt_renewal_" + i,
              { customer: "cus_fixture" },
              "invoice.paid",
            ),
          ),
        ),
      );
      await expectPlan("starter", "sub_current", 0);
      await db.query(`UPDATE accounts SET ${used}=7 WHERE id=1`);
      await fire(
        event("evt_late_renewal", { customer: "cus_fixture" }, "invoice.paid"),
      );
      await expectPlan("starter", "sub_current", 7);
    },
  );

  test(
    product +
      " real DB: second checkout lookup failure leaves marker retryable and plan unchanged",
    async () => {
      await reset();
      state.failRead = 2;
      const e = event(
        "evt_second_lookup",
        {
          payment_status: "paid",
          subscription: "sub_current",
          client_reference_id: "1",
        },
        "checkout.session.completed",
      );
      await assert.rejects(fire(e), /confirm|unavailable|verif/i);
      assert.equal(await markers(), 0);
      await expectPlan("starter");
      state.failRead = null;
      state.subs = [sub("sub_current", "pro")];
      await fire(e);
      await expectPlan("pro");
      assert.equal(await markers(), 1);
    },
  );

  test(
    product +
      " real DB: checkout account metadata fallback survives the locked refresh",
    async () => {
      await reset("free", null);
      await db.query("UPDATE accounts SET stripe_customer_id=NULL WHERE id=1");
      state.subs = [sub("sub_current", "pro")];
      state.subs[0].metadata = {};
      await fire(
        event(
          "evt_metadata_fallback",
          {
            payment_status: "paid",
            subscription: "sub_current",
            client_reference_id: "1",
          },
          "checkout.session.completed",
        ),
      );
      await expectPlan("pro");
      assert.equal((await row()).stripe_customer_id, "cus_fixture");
      assert.equal(await markers(), 1);
    },
  );
}
