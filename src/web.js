'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const bcrypt = require('bcryptjs');
const { createAccount, verifyLogin, createSession, accountForSession, destroySession, issueApiKey } = require('./auth');
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

async function currentAccount(req) {
  const raw = req.headers.cookie || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(raw);
  return m ? accountForSession(decodeURIComponent(m[1])) : null;
}

function shell(title, body, opts = {}) {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(opts.description || 'PDFMint turns HTML, Markdown or a URL into a PDF in one HTTP call.')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${css}</style></head><body>${body}</body></html>`;
}

function authForm(kind, error, values = {}) {
  const isSignup = kind === 'signup';
  return shell(isSignup ? 'Create your PDFMint account' : 'Sign in to PDFMint', `
<main class="auth">
  <a class="logo" href="/">PDF<span>Mint</span></a>
  <h1>${isSignup ? 'Create your account' : 'Sign in'}</h1>
  <p class="sub">${isSignup ? '300 documents a month, free, no card.' : 'Welcome back.'}</p>
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

router.post('/signup', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) {
    return res.status(400).type('html').send(authForm('signup', 'Enter an email address and a password of at least 8 characters.', { email }));
  }
  const { rows } = await query(`SELECT id FROM accounts WHERE email = $1`, [String(email).trim().toLowerCase()]);
  if (rows.length) {
    return res.status(409).type('html').send(authForm('signup', 'That email already has an account. Sign in instead.', { email }));
  }
  const { account, apiKey } = await createAccount(email, password);
  setSessionCookie(res, await createSession(account.id));
  res.redirect(`/dashboard?welcome=1&key=${encodeURIComponent(apiKey)}`);
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
  const fullKey = req.query.key ? String(req.query.key) : null;
  const plan = PLANS[account.plan] || PLANS.free;
  const pct = Math.min(100, Math.round((account.credits_used / Math.max(1, account.credits_limit)) * 100));
  const purchasable = Object.values(PLANS).filter((p) => planPriceId(p.id));

  res.type('html').send(shell('PDFMint dashboard', `
<header class="topbar"><a class="logo" href="/">PDF<span>Mint</span></a>
  <nav><a href="/docs">Docs</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav></header>
<main class="dash">
  ${req.query.welcome ? '<div class="notice"><strong>Your account is ready.</strong> Copy the API key below into the PDFMint credential in n8n and you are done.</div>' : ''}
  ${req.query.checkout === 'success' ? '<div class="notice ok"><strong>Payment received.</strong> Your new quota is live — it is shown below.</div>' : ''}
  ${req.query.checkout === 'cancelled' ? '<div class="notice">Checkout cancelled. Nothing was charged.</div>' : ''}
  <h1>Dashboard</h1>
  <section class="card">
    <h2>API key</h2>
    ${fullKey ? `<p class="keybox"><code id="k">${escapeHtml(fullKey)}</code><button class="copy" data-target="k">Copy</button></p>
      <p class="muted">This is shown once. Store it somewhere safe.</p>` : ''}
    <table class="rows">
      <tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th></tr>
      ${keys.map((k) => `<tr><td><code>${escapeHtml(k.key_prefix)}…</code></td><td>${escapeHtml(k.label)}</td>
        <td>${new Date(k.created_at).toISOString().slice(0, 10)}</td>
        <td>${k.last_used_at ? new Date(k.last_used_at).toISOString().replace('T', ' ').slice(0, 16) : 'never'}</td></tr>`).join('')}
    </table>
    <form method="post" action="/dashboard/keys"><button>Create another key</button></form>
    <p class="muted">A new key does not revoke the old ones. Keys are shown once.</p>
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

  <section class="card">
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
  res.redirect(`/dashboard?key=${encodeURIComponent(key)}`);
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

module.exports = { router, currentAccount, shell };
