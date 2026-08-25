'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { req, newAccount, isPdf } = require('./helpers');
const { config } = require('../src/config');

/**
 * Everything here is one promise: what the caller asked for is what comes back.
 * Each of these was a live path where the run went green and the document was
 * not what the request said — a saved template quietly overruling the request's
 * own page size, a mistyped page range answered with advice about image sizes,
 * an image file named so no viewer would open it.
 */

let key;

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the server under test must be running');
  ({ key } = await newAccount());
});

const tmpFile = (buffer, ext = 'pdf') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-fidelity-'));
  const file = path.join(dir, `x.${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
};
const pageSize = (buffer) => execFileSync('pdfinfo', [tmpFile(buffer)]).toString().match(/Page size:\s+(.*)/)[1].trim();

describe('a saved template supplies defaults, not overrides', () => {
  let name;

  before(async () => {
    name = `fidelity-${Date.now()}`;
    const { res } = await req(`/v1/templates/${name}`, {
      method: 'PUT', key,
      body: { html: '<h1>{{title}}</h1>', options: { format: 'A4', landscape: false, margin: '25mm' } },
    });
    assert.equal(res.status, 200);
  });

  test('page options sent flat on the request win over the stored ones', async () => {
    // They were computed correctly and then thrown away, because the merge only
    // looked at body.options and a flat request has none.
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { template: name, data: { title: 'T' }, format: 'Letter', landscape: true, margin: '0' },
    });
    assert.equal(res.status, 200);
    assert.ok(isPdf(buffer));
    assert.match(pageSize(buffer), /792 x 612/, 'the request asked for Letter landscape and must get it');
  });

  test('page options sent inside "options" win too', async () => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { template: name, data: { title: 'T' }, options: { format: 'Letter', landscape: true } },
    });
    assert.equal(res.status, 200);
    assert.match(pageSize(buffer), /792 x 612/);
  });

  test('what the request does not mention keeps the template default', async () => {
    const { buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { template: name, data: { title: 'T' } } });
    assert.match(pageSize(buffer), /595\.\d+ x 842\.\d+/, 'A4 portrait, as the template stored it');
  });

  test('a flat key beats the same key inside "options" on /v1/pdf, as on its siblings', async () => {
    const { buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<p>x</p>', format: 'Letter', options: { format: 'A4' } },
    });
    assert.match(pageSize(buffer), /612 x 792/, 'the more specific spelling wins');
  });
});

describe('a mistyped page range is the caller\'s mistake, not a crash', () => {
  test('nonsense is a 400 naming the field, with the accepted form', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<p>x</p>', pageRanges: 'banana' } });
    assert.equal(res.status, 400, 'this used to be a 500 telling the caller to shrink their images');
    assert.equal(json.error.code, 'invalid_option');
    assert.match(json.error.message, /"pageRanges"/);
    assert.match(json.error.hint, /1-5, 8, 11-13/, 'the hint must show a range that works');
  });

  test('the other ways to get it wrong are refused too', async () => {
    for (const spec of ['0', '2-1', '1;2', '1-2-3']) {
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<p>x</p>', pageRanges: spec } });
      assert.equal(res.status, 400, `"${spec}" must be refused`);
      assert.equal(json.error.code, 'invalid_option');
    }
  });

  test('a range past the end of the document is a 400, not a renderer crash', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<p>one page only</p>', pageRanges: '5' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_option');
    assert.match(json.error.message, /page range/i);
  });

  test('every form Chromium actually accepts still works', async () => {
    const html = '<p>one</p><div style="page-break-before:always">two</div><div style="page-break-before:always">three</div>';
    for (const spec of ['1-2', '1, 3', '1-', '-2', '1,,2', '01-02', '3-3', ' 1 - 2 ']) {
      const { res } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html, pageRanges: spec } });
      assert.equal(res.status, 200, `"${spec}" is valid to Chromium and must stay accepted`);
    }
  });
});

describe('a template reports the placeholders it uses', () => {
  const html = '<h1>{{title}}</h1><p>{{customer.name}}</p>{{#lines}}<li>{{desc}}</li>{{/lines}}{{^lines}}none{{/lines}}';
  let name;

  before(async () => {
    name = `ph-${Date.now()}`;
    const { res } = await req(`/v1/templates/${name}`, {
      method: 'PUT', key, body: { html, options: { headerHtml: '<div>{{invoice_number}}</div>' } },
    });
    assert.equal(res.status, 200);
  });

  test('PUT and GET both report the same list, with a kind on each entry', async () => {
    const get = await req(`/v1/templates/${name}`, { key });
    assert.equal(get.res.status, 200);
    const byName = Object.fromEntries(get.json.placeholders.map((p) => [p.name, p.kind]));
    assert.deepEqual(byName, {
      title: 'scalar',
      'customer.name': 'scalar',
      lines: 'section',
      invoice_number: 'scalar',
    }, 'a client builds one input field per entry, so the shape has to be usable');

    const put = await req(`/v1/templates/${name}`, { method: 'PUT', key, body: { html, options: { headerHtml: '<div>{{invoice_number}}</div>' } } });
    assert.deepEqual(put.json.placeholders, get.json.placeholders, 'PUT must answer with the same list GET does');
    assert.ok(put.json.usage.data.title !== undefined, 'the usage example must show the fields the template wants');
  });

  test('the list is exactly what a render reports as unresolved on empty data', async () => {
    // If the scanner and the renderer can disagree, the feature is worse than
    // useless: the fields on screen would not be the fields being filled.
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { template: name, data: {}, strict: true } });
    assert.equal(res.status, 400);
    const get = await req(`/v1/templates/${name}`, { key });
    const listed = get.json.placeholders.filter((p) => p.kind !== 'inverted').map((p) => p.name).sort();
    assert.deepEqual(json.error.details.unresolved.slice().sort(), listed,
      'every name the client can offer must be a name the renderer looks for, and vice versa');
  });

  test('a template with no placeholders reports an empty list, not a missing field', async () => {
    const plain = `plain-${Date.now()}`;
    await req(`/v1/templates/${plain}`, { method: 'PUT', key, body: { html: '<h1>Fixed text</h1>' } });
    const { json } = await req(`/v1/templates/${plain}`, { key });
    assert.deepEqual(json.placeholders, []);
    await req(`/v1/templates/${plain}`, { method: 'DELETE', key });
  });
});

describe('a generated file is named so it will open', () => {
  test('/v1/image appends the extension that matches the bytes', async () => {
    const { res, json } = await req('/v1/image', {
      method: 'POST', key, body: { html: '<h1>chart</h1>', filename: 'chart', type: 'png', output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.equal(json.filename, 'chart.png', 'an extensionless file will not preview in Drive');
    assert.equal(Buffer.from(json.base64, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  });

  test('a correct extension is left alone', async () => {
    const { json } = await req('/v1/image', {
      method: 'POST', key, body: { html: '<h1>x</h1>', filename: 'chart.png', type: 'png', output: 'base64' },
    });
    assert.equal(json.filename, 'chart.png');
  });

  test('an extension that contradicts the bytes is corrected, and the caller is told', async () => {
    const { json } = await req('/v1/image', {
      method: 'POST', key, body: { html: '<h1>x</h1>', filename: 'chart.png', type: 'jpeg', output: 'base64' },
    });
    assert.equal(json.filename, 'chart.jpeg', 'a name that lies about the format is worse than a renamed file');
    assert.ok(json.warnings.some((w) => /JPEG/.test(w)), JSON.stringify(json.warnings));
    assert.equal(Buffer.from(json.base64, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
  });

  test('the PDF path still appends .pdf, as it always did', async () => {
    const { res } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<p>x</p>', filename: 'report' } });
    assert.match(res.headers.get('content-disposition'), /filename="report\.pdf"/);
  });
});

describe('an error hint sends the reader somewhere they can actually go', () => {
  test('the 401 hint carries the absolute dashboard URL, not a bare path', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key: 'pm_live_definitelynotarealkey00000000', body: { html: '<p>x</p>' },
    });
    assert.equal(res.status, 401);
    assert.ok(json.error.hint.includes(`${config.publicUrl}/dashboard`),
      `a hint is read in a terminal where "/dashboard" is not a link: ${JSON.stringify(json.error.hint)}`);
    assert.ok(!/\son your dashboard at \/dashboard/.test(json.error.hint));
  });
});
