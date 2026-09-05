'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const recovery = require('../src/recovery');
const auth = require('../src/auth');
const db = require('../src/db');

test('recovery: expiry, one use, races, unknown email, session invalidation, SMTP rollback', { skip: !process.env.RECOVERY_TEST_DB }, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  const email = `qa-recovery-${crypto.randomBytes(6).toString('hex')}@smooth-operator.online`;
  const { account } = await auth.createAccount(email, 'original-password-123');
  let mail;
  const sendMail = async m => { mail = m; };
  const request = () => recovery.forgot(email, { product: 'Mint QA', sendMail });
  const token = () => /#token=([\w-]+)/.exec(mail.text)[1];
  const unlock = () => db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [account.id]);
  try {
    const oldSession = await auth.createSession(account.id);
    const known = await request();
    const secret = token();
    const { rows } = await db.query('SELECT reset_token_hash, reset_expires_at FROM accounts WHERE id=$1', [account.id]);
    assert.notEqual(rows[0].reset_token_hash, secret);
    assert.equal(rows[0].reset_token_hash, recovery.digest(secret));
    assert.ok(new Date(rows[0].reset_expires_at) > new Date());
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
    await assert.rejects(recovery.forgot(email, { product: 'Mint QA', sendMail: async () => { throw Error('SMTP down'); } }), { code: 'recovery_unavailable' });
    await recovery.reset(oldToken, 'rollback-password-789');
    await unlock(); await request();
    const once = token();
    const raced = await Promise.allSettled([recovery.reset(once, 'winner-password-111'), recovery.reset(once, 'winner-password-222')]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
  } finally {
    await db.query('DELETE FROM accounts WHERE id=$1', [account.id]);
    await db.pool.end();
  }
});
