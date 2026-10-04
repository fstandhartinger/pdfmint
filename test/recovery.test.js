'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const recovery = require('../src/recovery');
const auth = require('../src/auth');
const db = require('../src/db');
const formtoken = require('../src/formtoken');
const mail = require('../src/mail');

const DB = { skip: !process.env.RECOVERY_TEST_DB };
const unique = (p) => `${p}-${crypto.randomBytes(6).toString('hex')}@pdfmint.test`;
const age = (id, h = '25 hours') => db.query(`UPDATE accounts SET created_at = now() - interval '${h}' WHERE id = $1`, [id]);
const quarantine = (id) => db.query(`UPDATE accounts SET quarantined_at = now(), quarantine_reason = 'test' WHERE id = $1`, [id]);
const clearLimits = () => db.query(`DELETE FROM password_reset_limits`);
const drop = (id) => db.query(`DELETE FROM accounts WHERE id = $1`, [id]);
after(() => db.pool.end());

test('recovery: expiry, one use, races, unknown email, session invalidation, SMTP rollback', DB, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  const email = unique('qa-recovery');
  const { account } = await auth.createAccount(email, 'original-password-123');
  // A fresh account is not reset-eligible; age it past the 24 h gate.
  await age(account.id);
  let mailSent;
  const sendMail = async m => { mailSent = m; };
  const request = () => recovery.forgot(email, { product: 'Mint QA', sendMail });
  const token = () => /#token=([\w-]+)/.exec(mailSent.text)[1];
  // The 3-per-24 h email cap is exercised below; the cooldown reset must clear
  // the limit rows too, or the silent cap would eat this test's own requests.
  const unlock = async () => {
    await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [account.id]);
    await clearLimits();
  };
  try {
    const oldSession = await auth.createSession(account.id);
    const known = await request();
    const secret = token();
    const { rows } = await db.query('SELECT reset_token_hash, reset_expires_at FROM accounts WHERE id=$1', [account.id]);
    assert.notEqual(rows[0].reset_token_hash, secret);
    assert.equal(rows[0].reset_token_hash, recovery.digest(secret));
    assert.ok(new Date(rows[0].reset_expires_at) > new Date());
    await clearLimits();
    assert.deepEqual(await recovery.forgot('missing-'+email, { product: 'Mint QA', sendMail: () => assert.fail('unknown address must not receive email') }), known);
    await assert.rejects(recovery.reset(secret, 'short'), { code: 'invalid_password' });
    await recovery.reset(secret, 'replacement-password-456');
    assert.equal(await auth.verifyLogin(email, 'original-password-123'), null);
    assert.ok(await auth.verifyLogin(email, 'replacement-password-456'));
    assert.equal(await auth.accountForSession(oldSession), null);
    await assert.rejects(recovery.reset(secret, 'replay-password-456'), { code: 'invalid_reset_token' });
    await unlock(); await request();
    await db.query("UPDATE accounts SET reset_expires_at = now() - interval '1 second' WHERE id=$1", [account.id]);
    await assert.rejects(recovery.reset(token(), 'expired-password-456'), { code: 'invalid_reset_token' });
    await unlock(); await request();
    const oldToken = token();
    await unlock();
    // A send failure rolls the token back and still answers the neutral
    // message — the response must never depend on account existence.
    assert.deepEqual(await recovery.forgot(email, { product: 'Mint QA', sendMail: async () => { throw Error('SMTP down'); } }), known);
    await recovery.reset(oldToken, 'rollback-password-789');
    await unlock(); await request();
    const once = token();
    const raced = await Promise.allSettled([recovery.reset(once, 'winner-password-111'), recovery.reset(once, 'winner-password-222')]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
  } finally {
    await drop(account.id);
  }
});

test('recovery abuse gate: eligibility, quarantine, per-email and global caps', DB, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  let mailSent = null;
  const sendMail = async m => { mailSent = m; };
  const forgot = (email) => recovery.forgot(email, { product: 'Mint QA', sendMail });
  const ids = [];
  try {
    // A fresh, never-used account gets no mail — but the same response.
    const fresh = await auth.createAccount(unique('qa-fresh'), 'password-12345');
    ids.push(fresh.account.id);
    await clearLimits();
    const out = await forgot(fresh.account.email);
    assert.equal(mailSent, null);
    assert.ok(out.message);

    // The same account aged past 24 h is eligible and receives the link.
    await age(fresh.account.id);
    await clearLimits();
    await forgot(fresh.account.email);
    assert.ok(mailSent && mailSent.text.includes('#token='));

    // Quarantined accounts never receive mail.
    mailSent = null;
    const bad = await auth.createAccount(unique('qa-quar'), 'password-12345');
    ids.push(bad.account.id);
    await age(bad.account.id);
    await quarantine(bad.account.id);
    await clearLimits();
    await forgot(bad.account.email);
    assert.equal(mailSent, null);

    // Per-email cap: 3 sends per 24 h, the 4th is silently skipped.
    mailSent = null;
    const capped = await auth.createAccount(unique('qa-capped'), 'password-12345');
    ids.push(capped.account.id);
    await age(capped.account.id);
    await clearLimits();
    await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [capped.account.id]);
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      mailSent = null;
      await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [capped.account.id]);
      const r = await forgot(capped.account.email);
      assert.ok(r.message, 'the response never changes at the cap');
      if (mailSent) sent++;
    }
    assert.equal(sent, 3);

    // Global cap: 20 mails per hour across all accounts, silently.
    const globalAcct = await auth.createAccount(unique('qa-global'), 'password-12345');
    ids.push(globalAcct.account.id);
    await age(globalAcct.account.id);
    await clearLimits();
    await db.query(`INSERT INTO password_reset_limits (key, used) VALUES ($1, 20)`, [recovery.digest('global:all')]);
    mailSent = null;
    const g = await forgot(globalAcct.account.email);
    assert.ok(g.message);
    assert.equal(mailSent, null);
  } finally {
    for (const id of ids) await drop(id);
    await clearLimits();
  }
});

test('quarantine blocks login, sessions and API keys', DB, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  const { account, apiKey } = await auth.createAccount(unique('qa-quarantined'), 'password-12345');
  const sessionId = await auth.createSession(account.id);
  try {
    assert.ok(await auth.verifyLogin(account.email, 'password-12345'));
    assert.ok(await auth.accountForSession(sessionId));
    await quarantine(account.id);
    assert.equal(await auth.verifyLogin(account.email, 'password-12345'), null);
    assert.equal(await auth.accountForSession(sessionId), null);
    const req = { get: (h) => (/^authorization$/i.test(h) ? `Bearer ${apiKey}` : null) };
    await assert.rejects(auth.authenticate(req), { status: 401 });
  } finally {
    await drop(account.id);
  }
});

test('bot checks on /forgot-password and /signup forms', DB, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  // Mail is sent through Resend when the key is set; stubbing fetch captures
  // every send without any network or real mail.
  process.env.RESEND_API_KEY = 'test-key-not-logged';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(require('../src/web').router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, fields) => realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const eligible = await auth.createAccount(unique('qa-botmail'), 'password-12345');
  await age(eligible.account.id);
  try {
    // Baseline: a valid form token sends the mail.
    await clearLimits();
    const okRes = await post('/forgot-password', { email: eligible.account.email, ft: formtoken.issue('forgot-password', Date.now() - 5000) });
    const okBody = (await okRes.text()).replace(/name="ft" value="[^"]*"/, '');
    assert.equal(okRes.status, 202);
    assert.equal(sent.length, 1);

    // Honeypot filled: identical response, no mail.
    const hp = await post('/forgot-password', { email: eligible.account.email, website: 'https://spam.example', ft: formtoken.issue('forgot-password', Date.now() - 5000) });
    assert.equal(hp.status, 202);
    assert.equal((await hp.text()).replace(/name="ft" value="[^"]*"/, ''), okBody);
    assert.equal(sent.length, 1);

    // Too-fresh form token: identical response, no mail.
    const fast = await post('/forgot-password', { email: eligible.account.email, ft: formtoken.issue('forgot-password') });
    assert.equal(fast.status, 202);
    assert.equal((await fast.text()).replace(/name="ft" value="[^"]*"/, ''), okBody);
    assert.equal(sent.length, 1);

    // The JSON API needs no form token: a valid request still sends mail, and
    // (the account is past the 60 s resend cooldown for this check)
    await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [eligible.account.id]);
    // a honeypot field in the body rejects silently with the same 202.
    const api = await realFetch(`${base}/v1/forgot-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: eligible.account.email }),
    });
    assert.equal(api.status, 202);
    assert.match((await api.json()).message, /reset link has been sent/);
    const apiBot = await realFetch(`${base}/v1/forgot-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `stranger-${crypto.randomBytes(4).toString('hex')}@pdfmint.test`, website: 'x' }),
    });
    assert.equal(apiBot.status, 202);
    assert.match((await apiBot.json()).message, /reset link has been sent/);
    assert.equal(sent.length, 2);

    // Signup: a token younger than 3 s is rejected with the form error.
    const email1 = unique('qa-signup-fast');
    const r1 = await post('/signup', { email: email1, password: 'password-12345', ft: formtoken.issue('signup') });
    const b1 = await r1.text();
    assert.equal(r1.status, 400);
    assert.match(b1, /Please wait a few seconds and try again/);
    assert.equal((await db.query('SELECT id FROM accounts WHERE email=$1', [email1])).rows.length, 0);
    // A honeypot-filled signup is rejected the same way.
    const r1b = await post('/signup', { email: unique('qa-signup-hp'), password: 'password-12345', website: 'x', ft: formtoken.issue('signup', Date.now() - 5000) });
    assert.equal(r1b.status, 400);
    assert.match(await r1b.text(), /Please wait a few seconds and try again/);
    // A token issued 5 s ago is accepted and creates the account.
    const email2 = unique('qa-signup-ok');
    const r2 = await post('/signup', { email: email2, password: 'password-12345', ft: formtoken.issue('signup', Date.now() - 5000) });
    assert.equal(r2.status, 302);
    const { rows } = await db.query('SELECT id FROM accounts WHERE email=$1', [email2]);
    assert.equal(rows.length, 1);
    await drop(rows[0].id);
  } finally {
    server.close();
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    await drop(eligible.account.id);
    await clearLimits();
  }
});

test('mail.js sends through Resend when RESEND_API_KEY is set', async () => {
  process.env.RESEND_API_KEY = 'test-key-not-logged';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  try {
    await mail.sendMail({ from: { name: 'PDFMint', address: 'x@y.test' }, to: 'u@example.test', subject: 's', text: 't' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.from, 'PDFMint <noreply@mail.mintapis.com>');
    assert.equal(body.to, 'u@example.test');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer test-key-not-logged');
    assert.equal(calls[0].opts.method, 'POST');
    // Non-2xx throws.
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(mail.sendMail({ to: 'u@example.test', subject: 's', text: 't' }), /500/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});
