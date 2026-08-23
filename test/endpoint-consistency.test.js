'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { req, newAccount, isPdf } = require('./helpers');

/**
 * `/v1/pdf` has always accepted its settings either flat or nested under an
 * `options` object. `/v1/image` and `/v1/merge` only accepted them flat, so the
 * exact wrapper that worked on one endpoint answered `400 unknown_field` on its
 * neighbour. One vendor, adjacent endpoints, two different contracts — the kind
 * of thing that costs an integrator half an hour and some goodwill.
 */
describe('sibling endpoints agree on the shape of a request', () => {
  let key;
  test('setup', async () => { ({ key } = await newAccount()); });

  test('/v1/image accepts the same options wrapper /v1/pdf accepts', async () => {
    const flat = await req('/v1/image', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>flat</h1>', type: 'png' },
    });
    assert.equal(flat.res.status, 200, 'flat form must keep working');

    const wrapped = await req('/v1/image', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>wrapped</h1>', options: { type: 'png' } },
    });
    assert.equal(wrapped.res.status, 200,
      'the options wrapper must be accepted, as it is on /v1/pdf');
    assert.equal(wrapped.buffer.subarray(1, 4).toString('latin1'), 'PNG',
      'and it must actually honour the nested type');
  });

  test('/v1/merge accepts the same options wrapper', async () => {
    // Two real PDFs to merge, made through the API itself.
    const mk = async (t) => {
      const r = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: `<h1>${t}</h1>` } });
      assert.ok(isPdf(r.buffer));
      return { base64: r.buffer.toString('base64') };
    };
    const files = [await mk('one'), await mk('two')];

    const wrapped = await req('/v1/merge', {
      method: 'POST', key, raw: true,
      body: { files, options: { filename: 'wrapped.pdf' } },
    });
    assert.equal(wrapped.res.status, 200, 'the options wrapper must be accepted on /v1/merge too');
    assert.ok(isPdf(wrapped.buffer), 'and still return a real PDF');
  });

  test('a flat key still wins over the same key inside options', async () => {
    const r = await req('/v1/image', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>precedence</h1>', type: 'jpeg', options: { type: 'png' } },
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.buffer.subarray(0, 3).toString('hex'), 'ffd8ff',
      'the explicit flat spelling must not be silently overridden by the wrapper');
  });

  test('an genuinely unknown field is still rejected, wrapper or not', async () => {
    const r = await req('/v1/image', {
      method: 'POST', key,
      body: { html: '<h1>x</h1>', options: { nonsenseField: 1 } },
    });
    assert.equal(r.res.status, 400);
    assert.equal(r.json.error.code, 'unknown_field');
  });
});
