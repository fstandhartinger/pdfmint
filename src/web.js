'use strict';

const express = require('express');
const path = require('node:path');
const dns = require('node:dns/promises');
const fs = require('node:fs');
const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const bcrypt = require('bcryptjs');
const { createAccount, verifyLogin, createSession, accountForSession, destroySession, issueApiKey,
        stashKeyForSession, takeKeyForSession, revokeApiKey } = require('./auth');
const billing = require('./billing');
const { escapeHtml } = require('./markdown');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const SESSION_COOKIE = 'pdfmint_session';

function setSessionCookie(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true, sameSite: 'lax', secure: Boolean(config.publicUrl.startsWith('https')),
    maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
}

function sessionIdFrom(req) {
  const raw = req.headers.cookie || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

async function currentAccount(req) {
  const id = sessionIdFrom(req);
  return id ? accountForSession(id) : null;
}

function shell(title, body, opts = {}) {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(opts.description || 'PDFMint turns HTML, Markdown or a URL into a PDF in one HTTP call.')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="robots" content="${opts.robots || 'noindex, nofollow'}">${opts.canonical ? `
<link rel="canonical" href="${config.publicUrl}${opts.canonical}">` : ''}
<style>${css}</style></head><body>${body}</body></html>`;
}

function authForm(kind, error, values = {}) {
  const isSignup = kind === 'signup';
  return shell(isSignup ? 'Create your PDFMint account' : 'Sign in to PDFMint', `
<main class="auth">
  <a class="logo" href="/">PDF<span>Mint</span></a>
  <h1>${isSignup ? 'Create your account' : 'Sign in'}</h1>
  <p class="sub">${isSignup ? '10 documents a month, free, no card.' : 'Welcome back.'}</p>
  ${isSignup ? '<p class="warnbox">There is no password reset yet, and no confirmation email, so nothing can be sent to you if you forget. Put the password in your password manager now.</p>' : ''}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/${kind}">
    <label>Email<input type="email" name="email" required autocomplete="email" value="${escapeHtml(values.email || '')}"></label>
    <label>Password<input type="password" name="password" required minlength="8" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></label>
    <button type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="alt">${isSignup ? 'Already have an account? <a href="/login">Sign in</a>' : 'No account yet? <a href="/signup">Create one</a>'}</p>
</main>`);
}

router.get('/signup', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  res.type('html').send(authForm('signup', null));
}));

router.get('/login', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  res.type('html').send(authForm('login', null));
}));


/**
 * Refuses an address whose domain cannot receive mail at all.
 *
 * This does NOT verify that the mailbox exists — nothing short of sending mail
 * can, and this service sends none. What it does close is the hole that made the
 * free tier free to mint: signup accepted anything, so three accounts on
 * `@example.invalid` and 900 credits took about ten seconds. A domain with no MX
 * and no address record cannot belong to a real user.
 *
 * Reserved test TLDs are refused in production and allowed elsewhere, so the
 * test suite can still sign up throwaway accounts.
 */
const RESERVED_TLDS = ['.test', '.invalid', '.example', '.localhost'];

async function emailIsDeliverable(email) {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return { ok: false, why: 'That does not look like an email address.' };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // The local part must be a single unquoted atom: no second @, no whitespace.
  if (local.length > 64 || /[@\s]/.test(local) || /^\.|\.$|\.\./.test(local)) {
    return { ok: false, why: 'That does not look like an email address.' };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return { ok: false, why: 'That does not look like an email address.' };
  }
  if (RESERVED_TLDS.some((t) => domain.endsWith(t))) {
    return config.origin === 'production'
      ? { ok: false, why: 'That domain is reserved for testing and cannot receive mail. Use a real address.' }
      : { ok: true };
  }
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) return { ok: true };
  } catch { /* fall through to the address-record check */ }
  // RFC 5321: a domain with an address record but no MX still accepts mail.
  try {
    await dns.lookup(domain);
    return { ok: true };
  } catch {
    return { ok: false, why: `No mail server is published for "${domain}", so that address cannot receive mail. Check the spelling.` };
  }
}

router.post('/signup', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) {
    return res.status(400).type('html').send(authForm('signup', 'Enter an email address and a password of at least 8 characters.', { email }));
  }
  const normalised = String(email).trim().toLowerCase();
  const deliverable = await emailIsDeliverable(normalised);
  if (!deliverable.ok) {
    return res.status(400).type('html').send(authForm('signup', deliverable.why, { email }));
  }
  const { rows } = await query(`SELECT id FROM accounts WHERE email = $1`, [normalised]);
  if (rows.length) {
    return res.status(409).type('html').send(authForm('signup', 'That email already has an account. Sign in instead.', { email }));
  }
  const { account, apiKey } = await createAccount(email, password);
  const sessionId = await createSession(account.id);
  setSessionCookie(res, sessionId);
  stashKeyForSession(sessionId, apiKey);
  res.redirect('/dashboard?welcome=1');
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const account = await verifyLogin(email || '', password || '');
  if (!account) return res.status(401).type('html').send(authForm('login', 'Wrong email or password.', { email }));
  setSessionCookie(res, await createSession(account.id));
  res.redirect('/dashboard');
}));

router.post('/logout', asyncRoute(async (req, res) => {
  const raw = req.headers.cookie || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (m) await destroySession(decodeURIComponent(m[1]));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/');
}));

router.get('/dashboard', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const { rows: keys } = await query(
    `SELECT key_prefix, label, created_at, last_used_at FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [account.id],
  );
  const { rows: recent } = await query(
    `SELECT kind, pages, duration_ms, ok, error_code, created_at FROM usage_events WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [account.id],
  );
  // Handed over through the session, never through the URL.
  const fullKey = takeKeyForSession(sessionIdFrom(req));
  const plan = PLANS[account.plan] || PLANS.free;
  const pct = Math.min(100, Math.round((account.credits_used / Math.max(1, account.credits_limit)) * 100));
  const purchasable = Object.values(PLANS).filter((p) => planPriceId(p.id));

  res.type('html').send(shell('PDFMint dashboard', `
<header class="topbar"><a class="logo" href="/">PDF<span>Mint</span></a>
  <nav><a href="/docs">Docs</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav></header>
<main class="dash">
  ${req.query.welcome ? '<div class="notice"><strong>Your account is ready.</strong> Copy the API key below into the PDFMint credential in n8n and you are done. The free plan is 10 documents a month; a plan below raises it.</div>' : ''}
  ${req.query.checkout === 'success' ? '<div class="notice ok"><strong>Payment received.</strong> Your new quota is live — it is shown below.</div>' : ''}
  ${req.query.checkout === 'cancelled' ? '<div class="notice">Checkout cancelled. Nothing was charged.</div>' : ''}
  ${account.plan === 'free' && account.credits_used >= account.credits_limit ? '<div class="notice"><strong>You used all 10 free documents this month.</strong> Choose a paid plan below to keep generating now; the higher quota becomes available as soon as Stripe confirms payment. <a href="#plans">See plans</a>.</div>' : ''}
  <h1>Dashboard</h1>
  <section class="card">
    <h2>API key</h2>
    ${fullKey ? `<p class="keybox"><code id="k">${escapeHtml(fullKey)}</code><button class="copy" data-target="k">Copy</button></p>
      <p class="muted">This is shown once and cannot be read back — not here, not by support. Store it now.
      If you lose it, create another key below; the old one keeps working until you revoke it.</p>
      <p class="muted"><strong>Make your first PDF now</strong> — paste this into a terminal. It uses your key and one of your
        ${escapeHtml(String(plan.credits ?? account.credits_limit))} free documents, and writes <code>hello.pdf</code> in this directory:</p>
      <p class="keybox"><code id="firstcall">curl -X POST https://pdf.mintapis.com/v1/pdf -H "X-Api-Key: ${escapeHtml(fullKey)}" -H "Content-Type: application/json" -d '{"html":"&lt;h1&gt;Hello from PDFMint&lt;/h1&gt;&lt;p&gt;My first render.&lt;/p&gt;","filename":"hello"}' -o hello.pdf</code><button class="copy" data-target="firstcall">Copy</button></p>
      <p class="muted">Using n8n instead? Install the <code>n8n-nodes-pdfmint</code> community node and paste the key into its credential — <a href="/docs#n8n">step by step in the docs</a>.</p>` : ''}
    ${!fullKey && account.credits_used === 0 ? `<div class="notice"><strong>Make your first PDF now</strong> — you have ${escapeHtml(String(plan.credits ?? account.credits_limit))} free documents waiting and none used yet. Create a new key above (it is shown once), then paste this into a terminal with your key in place of <code>YOUR_KEY</code>:</div>
      <p class="keybox"><code>curl -X POST https://pdf.mintapis.com/v1/pdf -H "X-Api-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"html":"&lt;h1&gt;Hello from PDFMint&lt;/h1&gt;&lt;p&gt;My first render.&lt;/p&gt;","filename":"hello"}' -o hello.pdf</code></p>
      <p class="muted">Using n8n? Install the <code>n8n-nodes-pdfmint</code> community node and paste the key into its credential — <a href="/docs#n8n">step by step in the docs</a>.</p>` : ''}
    ${req.query.newkey && !fullKey ? '<div class="error">That key has already been shown. Create another one if you need it.</div>' : ''}
    <table class="rows">
      <tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th></th></tr>
      ${keys.map((k) => `<tr><td><code>${escapeHtml(k.key_prefix)}…</code></td><td>${escapeHtml(k.label)}</td>
        <td>${new Date(k.created_at).toISOString().slice(0, 10)}</td>
        <td>${k.last_used_at ? new Date(k.last_used_at).toISOString().replace('T', ' ').slice(0, 16) : 'never'}</td>
        <td>${keys.length > 1 ? `<form method="post" action="/dashboard/keys/revoke" class="inline"
          onsubmit="return confirm('Revoke ${escapeHtml(k.key_prefix)}…? Anything still using this key stops working immediately.')">
          <input type="hidden" name="prefix" value="${escapeHtml(k.key_prefix)}">
          <button class="link danger">Revoke</button></form>` : '<span class="muted">only key</span>'}</td></tr>`).join('')}
    </table>
    ${req.query.revoked ? `<div class="notice ok"><strong>Key revoked.</strong> ${escapeHtml(String(req.query.revoked))}… stopped working immediately.</div>` : ''}
    ${req.query.keyerror ? `<div class="error">${escapeHtml(String(req.query.keyerror))}</div>` : ''}
    <form method="post" action="/dashboard/keys"><button>Create another key</button></form>
    <p class="muted">A new key does not revoke the old ones. Keys are shown once.
      Revoking takes effect on the very next request; you cannot revoke your last remaining key.</p>
  </section>

  <section class="card">
    <h2>Webhook signing</h2>
    <p class="muted">When PDFMint POSTs a finished asynchronous job to your webhook, it signs the
      request so you can tell a real callback from anyone who has learned your URL. The headers are
      <code>X-PDFMint-Timestamp</code>, <code>X-PDFMint-Job-Id</code> and
      <code>X-PDFMint-Signature: sha256=&lt;hex&gt;</code>, where the signature is
      <code>HMAC-SHA256(secret, "&lt;timestamp&gt;." + rawBody)</code>.</p>
    <p class="keybox"><code id="whs">${escapeHtml(account.webhook_secret || '(not set)')}</code><button class="copy" data-target="whs">Copy</button></p>
    <p class="muted">Verify it with a constant-time compare, and reject a timestamp more than five
      minutes old. <a href="/docs#async">Worked example in the docs</a>.</p>
  </section>

  <section class="card">
    <h2>Password</h2>
    ${req.query.pw === 'ok' ? '<div class="notice ok">Password changed.</div>' : ''}
    ${req.query.pw === 'wrong' ? '<div class="error">That is not your current password.</div>' : ''}
    ${req.query.pw === 'short' ? '<div class="error">The new password must be at least 8 characters.</div>' : ''}
    <p class="muted">There is no password reset by email &mdash; PDFMint does not send email at all. Change it here while you are signed in.</p>
    <form method="post" action="/dashboard/password" class="inline">
      <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
      <label>New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
      <button>Change password</button>
    </form>
  </section>

  <section class="card">
    <h2>Usage this month</h2>
    <p class="big">${account.credits_used.toLocaleString('en-US')} <span class="muted">of ${account.credits_limit.toLocaleString('en-US')} documents</span></p>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <p class="muted">Plan: <strong>${escapeHtml(plan.name)}</strong>${plan.priceUsd ? ` — $${plan.priceUsd}/month` : ' — free'}. Resets on the 1st.</p>
    ${recent.length ? `<table class="rows"><tr><th>When</th><th>What</th><th>Pages</th><th>Time</th><th>Result</th></tr>
      ${recent.map((r) => `<tr><td>${new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16)}</td><td>${escapeHtml(r.kind)}</td>
        <td>${r.pages ?? '—'}</td><td>${r.duration_ms ? `${r.duration_ms} ms` : '—'}</td>
        <td>${r.ok ? '<span class="ok">ok</span>' : `<span class="bad">${escapeHtml(r.error_code || 'error')}</span>`}</td></tr>`).join('')}</table>` : '<p class="muted">No documents generated yet.</p>'}
  </section>

  <section class="card" id="plans">
    <h2>Plan</h2>
    <div class="plans">
      ${purchasable.map((p) => `<div class="plan${account.plan === p.id ? ' current' : ''}">
        <h3>${escapeHtml(p.name)}</h3><p class="price">$${p.priceUsd}<span>/mo</span></p>
        <p class="muted">${p.credits.toLocaleString('en-US')} documents / month</p>
        ${account.plan === p.id
          ? '<p class="tag">Current plan</p>'
          : `<form method="post" action="/dashboard/checkout"><input type="hidden" name="plan" value="${p.id}"><button>Choose ${escapeHtml(p.name)}</button></form>`}
      </div>`).join('')}
    </div>
    <p class="muted">The free plan is 10 documents a month. Checkout for a paid plan runs on Stripe, where you can add a VAT ID if you need one on the invoice; it is optional and can be left empty.</p>
    ${account.stripe_customer_id ? '<form method="post" action="/dashboard/portal"><button class="secondary">Manage billing / cancel</button></form>' : ''}
  </section>
</main>
<script>
document.addEventListener('click', (e) => {
  const b = e.target.closest('.copy'); if (!b) return;
  navigator.clipboard.writeText(document.getElementById(b.dataset.target).textContent.trim());
  b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});
</script>`));
}));

router.post('/dashboard/keys', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const key = await issueApiKey(account.id, 'n8n');
  stashKeyForSession(sessionIdFrom(req), key);
  res.redirect('/dashboard?newkey=1');
}));

router.post('/dashboard/keys/revoke', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const prefix = String(req.body?.prefix || '');
  try {
    const n = await revokeApiKey(account.id, prefix);
    if (!n) return res.redirect('/dashboard?keyerror=' + encodeURIComponent('That key is not active on this account.'));
    return res.redirect('/dashboard?revoked=' + encodeURIComponent(prefix));
  } catch (e) {
    return res.redirect('/dashboard?keyerror=' + encodeURIComponent(e.message || 'Could not revoke that key.'));
  }
}));

router.post('/dashboard/password', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const { current, next } = req.body || {};
  const ok = await bcrypt.compare(String(current || ''), account.password_hash);
  if (!ok) return res.redirect('/dashboard?pw=wrong');
  if (!next || String(next).length < 8) return res.redirect('/dashboard?pw=short');
  await query(`UPDATE accounts SET password_hash = $2 WHERE id = $1`, [account.id, await bcrypt.hash(String(next), 10)]);
  res.redirect('/dashboard?pw=ok');
}));

router.post('/dashboard/checkout', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const session = await billing.createCheckoutSession(account, String(req.body?.plan || ''));
  res.redirect(303, session.url);
}));

router.post('/dashboard/portal', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const session = await billing.createPortalSession(account);
  res.redirect(303, session.url);
}));

module.exports = { router, currentAccount, shell, escape: escapeHtml };
