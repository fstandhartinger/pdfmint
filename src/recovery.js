'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { query, tx } = require('./db');
const { config } = require('./config');
const { ApiError } = require('./errors');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const message = 'If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.';
const migration = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reset_token_hash TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reset_requested_at TIMESTAMPTZ`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_reset_token_idx ON accounts(reset_token_hash) WHERE reset_token_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS password_reset_limits (key TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL DEFAULT now(), used INTEGER NOT NULL DEFAULT 1)`,
];

function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
    ignoreTLS: process.env.SMTP_REQUIRE_TLS === 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { servername: process.env.SMTP_TLS_SERVERNAME || process.env.SMTP_HOST || 'localhost' },
  });
}

async function limit(ip, kind) {
  const { rows } = await query(`INSERT INTO password_reset_limits (key) VALUES ($1)
    ON CONFLICT (key) DO UPDATE SET
      used = CASE WHEN password_reset_limits.window_start < now() - interval '1 hour' THEN 1 ELSE password_reset_limits.used + 1 END,
      window_start = CASE WHEN password_reset_limits.window_start < now() - interval '1 hour' THEN now() ELSE password_reset_limits.window_start END
    RETURNING used`, [digest(`${kind}:${ip}`)]);
  if (rows[0].used > 20) throw new ApiError(429, 'rate_limited', 'Too many recovery attempts. Try again in one hour.');
  // Bound retained IP hashes without keeping the original addresses.
  await query(`DELETE FROM password_reset_limits WHERE window_start < now() - interval '2 hours'`);
}

async function forgot(email, { product, sendMail } = {}) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
  }
  const mailer = sendMail ? null : transport();
  // Check delivery availability even for unknown addresses; response status must
  // not disclose whether the address has an account.
  if (mailer) {
    try { await mailer.verify(); }
    catch { throw new ApiError(503, 'recovery_unavailable', 'Email delivery is temporarily unavailable. Please try again shortly.'); }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await tx(async client => {
    const { rows } = await client.query(`SELECT id, email, reset_requested_at FROM accounts WHERE email = $1 FOR UPDATE`, [email.trim().toLowerCase()]);
    const account = rows[0];
    if (!account || (account.reset_requested_at && Date.now() - new Date(account.reset_requested_at).getTime() < 60000)) return;
    const link = `${config.publicUrl}/reset-password#token=${token}`;
    const mail = {
      from: { name: product, address: process.env.SMTP_FROM || 'support@smooth-operator.online' },
      to: account.email,
      subject: `Reset your ${product} password`,
      text: `A password reset was requested for your ${product} account.\n\nOpen this link within 30 minutes:\n${link}\n\nThis link works once. If you did not request it, ignore this email. Your password has not changed.`,
    };
    // Commit only after SMTP accepts the message. Failure leaves the previous
    // reset link usable and permits a retry.
    await client.query(`UPDATE accounts SET reset_token_hash = $2, reset_expires_at = now() + interval '30 minutes', reset_requested_at = now() WHERE id = $1`, [account.id, digest(token)]);
    try { await (sendMail ? sendMail(mail) : mailer.sendMail(mail)); }
    catch { throw new ApiError(503, 'recovery_unavailable', 'Email delivery is temporarily unavailable. Please try again shortly.'); }
  });
  return { message };
}

async function reset(token, password, minLength = 8) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(400, 'invalid_reset_token', 'This reset link is invalid or has expired. Request a new link.');
  if (typeof password !== 'string' || password.length < minLength || Buffer.byteLength(password) > 72) throw new ApiError(400, 'invalid_password', `Use at least ${minLength} characters and at most 72 UTF-8 bytes.`);
  const hash = await bcrypt.hash(password, 10);
  await tx(async client => {
    const { rows } = await client.query(`SELECT id FROM accounts WHERE reset_token_hash = $1 AND reset_expires_at > now() FOR UPDATE`, [digest(token)]);
    if (!rows.length) throw new ApiError(400, 'invalid_reset_token', 'This reset link is invalid or has expired. Request a new link.');
    await client.query(`UPDATE accounts SET password_hash = $2, reset_token_hash = NULL, reset_expires_at = NULL WHERE id = $1`, [rows[0].id, hash]);
    await client.query(`DELETE FROM sessions WHERE account_id = $1`, [rows[0].id]);
  });
  return { message: 'Your password has been reset. Sign in with your new password.' };
}

function install(router, { product, shell, minLength = 8 }) {
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const page = (resetting, result = '') => shell(resetting ? 'Reset password' : 'Forgot password', `
    <main class="auth"><a class="logo" href="/">${product}</a><h1>${resetting ? 'Choose a new password' : 'Reset your password'}</h1>
    <p role="status">${result}</p><form id="recovery" method="post" action="/${resetting ? 'reset-password' : 'forgot-password'}">
    ${resetting ? `<input type="hidden" name="token" id="reset-token"><label>New password<input type="password" name="password" required minlength="${minLength}" maxlength="72" autocomplete="new-password"></label>` : '<label>Email<input type="email" name="email" required autocomplete="email"></label>'}
    <button>${resetting ? 'Reset password' : 'Send reset link'}</button></form>
    <p><a href="/login">Back to sign in</a></p></main>
    ${resetting ? `<script>document.getElementById('reset-token').value=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'','/reset-password');</script>` : ''}`);
  for (const action of ['forgot-password', 'reset-password']) {
    const resetting = action === 'reset-password';
    router.get(`/${action}`, (req, res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(page(resetting)));
    router.post([`/${action}`, `/v1/${action}`], wrap(async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      await limit(req.ip, action);
      const out = resetting ? await reset(req.body?.token, req.body?.password, minLength) : await forgot(req.body?.email, { product });
      if (req.path.startsWith('/v1/')) return res.status(resetting ? 200 : 202).json(out);
      if (resetting) return res.type('html').send(shell('Password reset', `<main class="auth"><h1>Password reset</h1><p>${out.message}</p><a href="/login">Sign in</a></main>`));
      return res.status(202).type('html').send(page(false, out.message));
    }));
  }
}

module.exports = { migration, forgot, reset, install, digest };
