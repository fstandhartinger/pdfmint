"use strict";
// Exact deployed billing/config/db bytes; real PG + Express HTTP + Stripe SDK signature verification. Provider, auth/session and nonbilling dependencies are explicit doubles.
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
    STRIPE_WEBHOOK_SECRET: "whsec_fixture_20260909",
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
        __dirname: base,
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
      retrieve: async (id) => {if(state.customerFailure)throw Error("customer unavailable");return {id,deleted:state.deletedCustomerId ? id===state.deletedCustomerId : !!state.customerDeleted}},
      create: async (args,opts={}) => {
        if(opts.idempotencyKey && state.customerKeys?.[opts.idempotencyKey])return copy(state.customerKeys[opts.idempotencyKey]);
        state.customers++;
        const c={ id: state.customers===1?"cus_fixture":"cus_fixture_"+state.customers };
        if(opts.idempotencyKey){state.customerKeys ||= {};state.customerKeys[opts.idempotencyKey]=c}
        return c;
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
        if(state.updateFailure)throw Error("update unavailable");
        const s = state.subs.find((s) => s.id === id);
        if(state.pendingUpgrade){s.pending_update={expires_at:9999999999};s.latest_invoice={hosted_invoice_url:"https://invoice.invalid/sca"};return copy(s)}
        s.items.data[0].price.id = args.items[0].price;
        if(state.updateResponseLost){state.updateResponseLost=false;throw Error("update response lost")}
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
          if(state.createResponseLost){state.createResponseLost=false;throw Error("checkout response lost")}
          return copy(s);
        },
        expire: async (id) => {
          state.sessions.find((s) => s.id === id).status = "expired";
        },
      },
    },
    invoices: { retrieve: async () => {if(state.invoiceFailure)throw Error("invoice unavailable");return copy(state.invoice)} },
    billingPortal: {
      sessions: { create: async (args) => {state.portalCustomer=args.customer;state.portals=(state.portals||0)+1;if(state.deletedCustomerId ? args.customer===state.deletedCustomerId : state.customerDeleted)throw Object.assign(Error("No such customer: cus_fixture"),{code:"resource_missing",statusCode:404,type:"StripeInvalidRequestError"});if(state.portalFailure)throw Error("portal unavailable");return {url:"https://portal.invalid"}} },
    },
    webhooks: require("stripe")("sk_test_fixture").webhooks,
  };
  const routes = {};
  const billing = load("billing.js", (n) => {
    if (n === "./config") return cfg;
    if (n === "./db") return db;
    if (n === "stripe")
      return function () {
        return stripe;
      };
    if (n === "express") return require("express");
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
  let server, baseUrl;
  const express = require('express');
  const app = express();
  app.use('/stripe', express.raw({type:'application/json'}), billing.router);
  app.use(express.urlencoded({extended:false}));
  app.use(express.json());
  const no = () => {throw Error('unexpected nonbilling dependency invocation')};
  const logger = {...silent, child(){return this}};
  const routeRequire = (n) => {
    if(n==='express') return express;
    if(n==='./batch') return {BATCH_FIELDS:[]};
    if(n==='./schema') return {TYPES:[]};
    if(n==='./recovery') return {install(){}};
    if(n==='./billing') return billing;
    if(n==='./config') return cfg;
    if(n==='./db') return db;
    if(n==='./auth') return {accountForSession:async id=>id==='fixture'?row():null, authenticate:async req=>{if(req.get('authorization')!=='Bearer fixture')throw Object.assign(Error('unauthorized'),{status:401});return row()}};
    if(n==='./log') return {...logger,log:logger};
    if(n==='./ratelimit') return {rateLimit:(req,res,next)=>next()};
    if(n==='./input') return {rejectUnknown:(body,allowed)=>{if(Object.keys(body).some(k=>!allowed.includes(k)))throw Object.assign(Error('unknown input'),{status:400})}};
    if(n==='./errors') return {ApiError:class extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code}},bad:no};
    if(n==='node:fs') return {...fs,readFileSync:(f,...args)=>String(f).endsWith('app.css')?'':fs.readFileSync(f,...args)};
    if(n.startsWith('node:')||n==='bcryptjs')return require(n);
    if(n==='./markdown'||n==='./html')return {escapeHtml:String,json:JSON.stringify,timeAgo:String};
    return {};
  };
  const web = load('web.js',routeRequire);app.use(web.router);
  if(product==='docmint'){app.use((req,res,next)=>{req.log=logger;next()});app.use('/v1',load('api.js',routeRequire).router)}
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:{code:err.code||'fixture_error',message:err.message}}));
  const post = async (url,body={},auth=true) => fetch(baseUrl+url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',...(auth?{cookie:product+'_session=fixture',authorization:'Bearer fixture'}:{})},body:JSON.stringify(body)});
  const fire = async(e) => {
    const body=JSON.stringify(e);const signature=stripe.webhooks.generateTestHeaderString({payload:body,secret:env.STRIPE_WEBHOOK_SECRET});
    const r=await fetch(baseUrl+'/stripe/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body});
    const out=await r.json();if(r.status>=400)throw Object.assign(Error(out.error?.message||out.error?.code),{status:r.status});
    assert.equal(r.status,200);return out;
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
  before(async()=>{server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));baseUrl="http://127.0.0.1:"+server.address().port});
  after(async () => {
    if(server) await new Promise(r=>server.close(r));
    await db.pool.end();
  });
  test(product+' HTTP authenticated portal route returns correct destination',async()=>{
    await reset();const r=await post(portalPath);assert.equal(r.status,product==='docmint'?200:303);
    assert.equal(product==='docmint'?(await r.json()).url:r.headers.get('location'),'https://portal.invalid');assert.equal(state.portals,1);await expectPlan('starter');
  });
  test(product+' HTTP unauthenticated portal cannot create provider session',async()=>{
    await reset();const r=await post(portalPath,{},false);assert.equal(r.status,product==='docmint'?401:302);assert.equal(state.portals||0,0);
  });
  test(product+' HTTP portal provider outage returns error and retry succeeds',async()=>{
    await reset();state.portalFailure=true;let r=await post(portalPath);assert.equal(r.status,500);await expectPlan('starter');state.portalFailure=false;r=await post(portalPath);assert.equal(r.status,product==='docmint'?200:303);await expectPlan('starter');
  });
  test(product+' HTTP no-customer portal does not invent a subscription',async()=>{
    await reset('free',null);await db.query('UPDATE accounts SET stripe_customer_id=NULL WHERE id=1');const r=await post(portalPath);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'no_subscription');assert.equal(state.portals||0,0);await expectPlan('free',null);
  });
  test(product+' HTTP stale provider customer clears only billing references',async(t)=>{
    await reset('free',null);state.customerDeleted=true;const r=await post(portalPath);const body=await r.json();const again=await post(portalPath);t.diagnostic(JSON.stringify({firstStatus:r.status,retryStatus:again.status,body,account:await row(),portalCalls:state.portals||0}));assert.equal(r.status,400);assert.equal((await row()).stripe_customer_id,null);await expectPlan('free',null);
  });
  const portalPath=product==='docmint'?'/v1/billing/portal':'/dashboard/portal';
  test(product+' portal provider lookup outage preserves references and quota',async()=>{
    await reset('pro');state.customerFailure=true;const r=await post(portalPath);assert.equal(r.status,500);assert.equal(state.portals||0,0);assert.equal((await row()).stripe_customer_id,'cus_fixture');await expectPlan('pro');state.customerFailure=false;const retry=await post(portalPath);assert.equal(retry.status,product==='docmint'?200:303);await expectPlan('pro');
  });
  test(product+' stale account snapshot cannot clear replacement customer ownership',async()=>{
    await reset('pro');const stale=await row();state.deletedCustomerId='cus_fixture';await db.query("UPDATE accounts SET stripe_customer_id='cus_replacement' WHERE id=1");const result=await billing.createPortalSession(stale);assert.equal(result.url,'https://portal.invalid');assert.equal(state.portalCustomer,'cus_replacement');assert.equal((await row()).stripe_customer_id,'cus_replacement');await expectPlan('pro');
  });
  test(product+' portal takes account row lock before reading provider or clearing references',async()=>{
    await reset('pro');const stale=await row();const lock=await db.pool.connect();let promise;await lock.query('BEGIN');await lock.query('SELECT * FROM accounts WHERE id=1 FOR UPDATE');
    try{promise=billing.createPortalSession(stale);await waitLock();assert.equal(state.portals||0,0);await lock.query("UPDATE accounts SET stripe_customer_id='cus_replacement' WHERE id=1");}finally{await lock.query('COMMIT');lock.release()}
    await promise;assert.equal(state.portalCustomer,'cus_replacement');await expectPlan('pro');
  });

}
