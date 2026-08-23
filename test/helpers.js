'use strict';

const crypto = require('node:crypto');

/**
 * These tests exercise real behaviour: a real HTTP server, a real Chromium, a
 * real database, real PDF bytes. Nothing about the shape of the code is
 * asserted anywhere — only what the service actually does.
 */
const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function req(path, { method = 'GET', key, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  if (raw) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, text, json };
}

/** Signs up a throwaway account and returns its API key. */
async function newAccount() {
  const email = `test-${crypto.randomBytes(6).toString('hex')}@pdfmint.test`;
  const res = await fetch(`${BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: 'testpassword123' }).toString(),
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`signup set no session cookie (status ${res.status})`);

  // The key is shown once on the dashboard and never travels in a URL.
  const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie } });
  const html = await dash.text();
  const key = (html.match(/pm_live_[A-Za-z0-9_-]{20,}/) || [])[0];
  if (!key) throw new Error(`the dashboard did not show a new key (status ${dash.status})`);
  return { email, key, cookie };
}

const isPdf = (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Counts pages by scanning the PDF for page objects — deliberately not using our own code. */
function countPagesIndependently(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

module.exports = { BASE, req, newAccount, isPdf, countPagesIndependently };
