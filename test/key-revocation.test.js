'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BASE, req, newAccount } = require('./helpers');
const { query } = require('../src/db');

/**
 * The docs promised key revocation ("useful when you want one per environment and
 * want to be able to revoke them separately", "the old one keeps working until you
 * revoke it") while nothing in the codebase ever wrote `revoked_at`. A leaked key
 * was therefore valid forever, with no remedy and no way to rotate a credential.
 *
 * These tests are the promise, expressed as behaviour.
 */
describe('an API key can actually be revoked', () => {
  test('a revoked key stops working on the very next request', async () => {
    const { key: first, cookie } = await newAccount();

    // A second key, because the last remaining key is deliberately not revocable.
    const made = await req('/v1/keys', { method: 'POST', key: first, body: { label: 'second' } });
    assert.equal(made.res.status, 200);
    const second = made.json.api_key;
    assert.match(second, /^pm_live_/);

    // Both work before the revocation.
    assert.equal((await req('/v1/me', { key: first })).res.status, 200);
    assert.equal((await req('/v1/me', { key: second })).res.status, 200);

    const listed = await req('/v1/keys', { key: first });
    assert.equal(listed.res.status, 200);
    const prefixes = listed.json.keys.map((k) => k.key_prefix);
    assert.equal(prefixes.length, 2, 'both keys should be listed while active');

    const secondPrefix = second.slice(0, 16);
    const gone = await req(`/v1/keys/${secondPrefix}`, { method: 'DELETE', key: first });
    assert.equal(gone.res.status, 200, JSON.stringify(gone.json));
    assert.equal(gone.json.revoked, secondPrefix);

    // The whole point: it stops working immediately, with a machine-readable code.
    const after = await req('/v1/me', { key: second });
    assert.equal(after.res.status, 401);
    assert.equal(after.json.error.code, 'invalid_api_key');

    // ...and the key that did the revoking is untouched.
    assert.equal((await req('/v1/me', { key: first })).res.status, 200);

    const stillListed = await req('/v1/keys', { key: first });
    assert.equal(stillListed.json.keys.length, 1, 'a revoked key must not be listed as active');

    const { rows } = await query(
      'SELECT revoked_at FROM api_keys WHERE key_prefix = $1', [secondPrefix],
    );
    assert.ok(rows[0] && rows[0].revoked_at, 'revoked_at must actually be stamped');
    assert.ok(cookie);
  });

  test('revoking the only key is refused, because that would be a lockout', async () => {
    const { key } = await newAccount();
    const only = await req(`/v1/keys/${key.slice(0, 16)}`, { method: 'DELETE', key });
    assert.equal(only.res.status, 409);
    assert.equal(only.json.error.code, 'last_key');

    // Still usable — the refusal must not have half-applied.
    assert.equal((await req('/v1/me', { key })).res.status, 200);
  });

  test('a key that is not on this account cannot be revoked through it', async () => {
    const a = await newAccount();
    const b = await newAccount();
    // Give account A a second key so the request is not refused for being the last one.
    await req('/v1/keys', { method: 'POST', key: a.key, body: { label: 'spare' } });

    const attempt = await req(`/v1/keys/${b.key.slice(0, 16)}`, { method: 'DELETE', key: a.key });
    assert.equal(attempt.res.status, 404);
    assert.equal(attempt.json.error.code, 'key_not_found');

    // B is unharmed.
    assert.equal((await req('/v1/me', { key: b.key })).res.status, 200);
  });
});
