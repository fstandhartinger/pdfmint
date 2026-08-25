'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

/**
 * `config.origin` decides two things that matter: which rows the public status
 * page counts, and whether signup refuses reserved-TLD addresses like
 * `someone@example.test`. It used to be inferred from PUBLIC_URL containing
 * 'onrender.com'. Moving the service to its own domain would therefore have
 * flipped production to 'dev' with no error and no log line — the status page
 * would have gone quiet and production would have started accepting undeliverable
 * test addresses. Deployment identity must not depend on the hostname.
 */
describe('deployment identity survives a change of domain', () => {
  function originFor(env) {
    const keys = ['PDFMINT_ORIGIN', 'NODE_ENV', 'PUBLIC_URL'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../src/config')];
    const { config } = require('../src/config');
    const got = config.origin;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../src/config')];
    require('../src/config');
    return got;
  }

  test('a production deploy on a custom domain is still production', () => {
    assert.equal(originFor({ NODE_ENV: 'production', PUBLIC_URL: 'https://pdf.mintapis.com' }), 'production');
  });

  test('a production deploy on the old onrender host is still production', () => {
    assert.equal(originFor({ NODE_ENV: 'production', PUBLIC_URL: 'https://pdfmint-b9tt.onrender.com' }), 'production');
  });

  test('a local run is dev, whatever PUBLIC_URL says', () => {
    assert.equal(originFor({ PUBLIC_URL: 'https://pdf.mintapis.com' }), 'dev');
    assert.equal(originFor({ PUBLIC_URL: 'http://127.0.0.1:3000' }), 'dev');
  });

  test('an explicit PDFMINT_ORIGIN always wins', () => {
    assert.equal(originFor({ PDFMINT_ORIGIN: 'production', PUBLIC_URL: 'http://127.0.0.1:3000' }), 'production');
    assert.equal(originFor({ PDFMINT_ORIGIN: 'staging', NODE_ENV: 'production' }), 'staging');
  });
});
