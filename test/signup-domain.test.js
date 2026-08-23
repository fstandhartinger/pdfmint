'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { BASE } = require('./helpers');

/**
 * Signup accepted any string as an email, so the free tier was free to mint: a
 * reviewer created three accounts on `@example.invalid` — a domain that cannot
 * receive mail — and walked away with 900 free credits in about ten seconds.
 * The only thing this product sells is a document count, so an unlimited supply
 * of free counts is the whole business model leaking.
 *
 * This cannot verify that a mailbox exists (nothing can, without sending mail,
 * and this service sends none). It verifies the weaker, checkable thing: that
 * the domain publishes somewhere for mail to go.
 */
async function signup(email, password = 'testpassword123') {
  const res = await fetch(`${BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }).toString(),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.text() };
}

describe('signup refuses an address that could never receive mail', () => {
  test('a domain with no mail server anywhere is rejected', async () => {
    const r = await signup(`farm-${crypto.randomBytes(5).toString('hex')}@nx-${crypto.randomBytes(8).toString('hex')}.com`);
    assert.equal(r.status, 400, 'a domain that does not resolve must not create an account');
    assert.match(r.body, /cannot receive mail|does not look like/i);
  });

  test('a malformed address is rejected before any DNS work', async () => {
    for (const bad of ['not-an-email', 'missing@', '@nodomain.com', 'two@@ats.com', 'spaces in@example.com']) {
      const r = await signup(bad);
      assert.equal(r.status, 400, `"${bad}" must be refused`);
    }
  });

  test('a real domain is still accepted, so this does not lock anyone out', async () => {
    // gmail.com publishes MX; the mailbox is random and never used, and no mail
    // is ever sent to it because this service sends none.
    const r = await signup(`pdfmint-test-${crypto.randomBytes(8).toString('hex')}@gmail.com`);
    assert.equal(r.status, 302, `a deliverable domain must still work (got ${r.status})`);
  });
});
