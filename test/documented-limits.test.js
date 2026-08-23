'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { req, newAccount } = require('./helpers');
const { config, PLANS } = require('../src/config');
const { REFILL_PER_MINUTE, CAPACITY } = require('../src/ratelimit');
const { DEFAULT_MARGIN, FORMATS } = require('../src/options');

/**
 * The published pages quote a lot of numbers. This asserts each one against the
 * value the code actually enforces, so a limit cannot be changed in one place
 * and left stale in the other. The previous product shipped pages claiming
 * things the code did not do; this is the guard against repeating it.
 */
const docs = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'), 'utf8')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

describe('every number on the published pages matches the code', () => {
  const cases = [
    ['max HTML size', mb(config.maxHtmlBytes), '10 MB'],
    ['max request body', mb(config.maxRequestBytes), '12 MB'],
    ['max hosted file', mb(config.maxStoredFileBytes), '20 MB'],
    ['default timeout', `${config.defaultTimeoutMs / 1000} s`, '30 s'],
    ['max timeout', `${config.maxTimeoutMs / 1000} s`, '120 s'],
    ['concurrent renders', String(config.maxConcurrentRenders), '2'],
    ['queue depth', String(config.renderQueueLimit), '40'],
    ['rate limit per minute', String(REFILL_PER_MINUTE), '120'],
    ['rate limit burst', String(CAPACITY), '30'],
    ['default margin', DEFAULT_MARGIN, '12mm'],
  ];

  for (const [what, actual, documented] of cases) {
    test(`${what}: the code enforces ${actual}`, () => {
      assert.equal(actual, documented, `the code changed but the docs still say ${documented}`);
      assert.ok(docs.includes(documented), `the docs page never states the ${what} (${documented})`);
    });
  }

  test('the plan table on both pages matches config.js exactly', () => {
    for (const plan of Object.values(PLANS)) {
      const credits = plan.credits.toLocaleString('en-US');
      for (const [name, page] of [['docs', docs], ['landing', landing]]) {
        if (!new RegExp(`\\b${plan.name}\\b`).test(page)) continue;
        assert.ok(page.includes(credits), `${name} names the ${plan.name} plan but not its ${credits} documents`);
        if (plan.priceUsd > 0) assert.ok(page.includes(`$${plan.priceUsd}`), `${name} names ${plan.name} but not $${plan.priceUsd}`);
      }
    }
  });

  test('every page format the docs list is actually accepted', async () => {
    const { key } = await newAccount();
    const listed = FORMATS.filter((f) => docs.includes(`<td><code>${f}</code>`) || docs.includes(`>${f}<`));
    assert.ok(listed.length >= 5, `expected the docs to list several formats, found ${listed.length}`);
    for (const format of listed) {
      const { res } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<p>x</p>', options: { format } } });
      assert.equal(res.status, 200, `the docs list format ${format} but the API rejects it`);
    }
  });

  test('the limits the docs state are the limits the API enforces', async () => {
    const { key } = await newAccount();

    // Request body just over the documented ceiling.
    const tooBig = 'x'.repeat(config.maxRequestBytes + 4096);
    const big = await req('/v1/pdf', { method: 'POST', key, body: { html: tooBig } });
    assert.equal(big.res.status, 413, 'a body over the documented limit must be refused');
    assert.equal(big.json.error.code, 'request_too_large');

    // Timeout below the documented minimum.
    const short = await req('/v1/pdf', { method: 'POST', key, body: { html: '<p>x</p>', timeout: 500 } });
    assert.equal(short.res.status, 400);
    assert.match(short.json.error.message, /1000 milliseconds/);

    // Merge with more inputs than documented.
    const many = await req('/v1/merge', { method: 'POST', key, body: { files: Array.from({ length: 51 }, () => 'https://example.com/a.pdf') } });
    assert.equal(many.json.error.code, 'too_many_files');
    assert.match(many.json.error.message, /51 files.*limit is 50/);
  });

  test('the free plan really is the number the pages advertise', async () => {
    const { key } = await newAccount();
    const { json } = await req('/v1/me', { key });
    assert.equal(json.credits_limit, PLANS.free.credits);
    assert.ok(landing.includes(String(PLANS.free.credits)), 'the landing page must state the real free allowance');
    assert.ok(docs.includes(String(PLANS.free.credits)), 'the docs must state the real free allowance');
  });
});
