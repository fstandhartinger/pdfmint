'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { req, newAccount, isPdf, countPagesIndependently } = require('./helpers');

let key;

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the server under test must be running');
  ({ key } = await newAccount());
});

describe('producing a PDF', () => {
  test('HTML in, PDF bytes out, on the first call', async () => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>Hello</h1>' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.ok(isPdf(buffer), 'response body is a PDF');
    assert.equal(Number(res.headers.get('x-pdfmint-pages')), 1);
    assert.match(res.headers.get('content-disposition'), /filename="document\.pdf"/);
  });

  test('the reported page count matches the file', async () => {
    const long = Array.from({ length: 220 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
    const { res, buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: long } });
    const reported = Number(res.headers.get('x-pdfmint-pages'));
    assert.ok(reported > 1, `expected several pages, got ${reported}`);
    assert.equal(countPagesIndependently(buffer), reported);
  });

  test('Markdown becomes a typeset document with the text still extractable', async () => {
    const { buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { markdown: '# Report Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nBody text here.' },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 'md.pdf');
    fs.writeFileSync(file, buffer);
    const text = execFileSync('pdftotext', [file, '-']).toString();
    assert.match(text, /Report Title/);
    assert.match(text, /Body text here/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('page numbers reserve their own margin and reach the page', async () => {
    const long = Array.from({ length: 220 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
    const { buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: long, options: { pageNumbers: true, margin: '0' } },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, buffer);
    const text = execFileSync('pdftotext', [file, '-']).toString();
    assert.match(text, /Page 1 of \d+/, 'the footer must be on the page even though margin was 0');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('printBackground is on by default, so background colour reaches the paper', async () => {
    // #12a37a is the fill; we read the actual pixels back out of the rendered page.
    const html = '<body style="margin:0"><div style="background:#12a37a;width:100%;height:400px"></div></body>';
    const { buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html, options: { margin: '0' } } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    fs.writeFileSync(path.join(dir, 'bg.pdf'), buffer);
    execFileSync('pdftoppm', ['-r', '20', path.join(dir, 'bg.pdf'), path.join(dir, 'bg')]);
    const ppm = fs.readFileSync(path.join(dir, 'bg-1.ppm'));
    // P6 header: magic, width, height, maxval — then raw RGB triples.
    const header = ppm.subarray(0, 40).toString('latin1');
    const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(header);
    assert.ok(m, 'expected a P6 PPM');
    const start = m[0].length;
    let green = 0;
    for (let i = start; i + 2 < ppm.length; i += 3) {
      // Allow generous tolerance for colour management in the rasteriser.
      if (Math.abs(ppm[i] - 0x12) < 40 && Math.abs(ppm[i + 1] - 0xa3) < 40 && Math.abs(ppm[i + 2] - 0x7a) < 40) green += 1;
    }
    const totalPixels = Number(m[1]) * Number(m[2]);
    assert.ok(green / totalPixels > 0.2, `expected the background block to print; only ${green}/${totalPixels} pixels matched`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a password-protected PDF cannot be opened without the password', async (t) => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>secret</h1>', password: 'hunter2' },
    });
    if (res.status === 501) {
      // qpdf ships in the container but is not required on a dev machine.
      t.skip('qpdf is not installed on this host, so encryption is unavailable here');
      return;
    }
    assert.equal(res.status, 200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 'enc.pdf');
    fs.writeFileSync(file, buffer);
    const info = execFileSync('pdfinfo', ['-upw', 'hunter2', file]).toString();
    assert.match(info, /Encrypted:\s+yes/);
    assert.throws(() => execFileSync('pdftotext', [file, '-'], { stdio: 'pipe' }), 'no password must fail');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a watermark lands on every page', async () => {
    const long = Array.from({ length: 220 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
    const { buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: long, watermark: { text: 'DRAFT' } },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 'wm.pdf');
    fs.writeFileSync(file, buffer);
    const pages = Number(execFileSync('pdfinfo', [file]).toString().match(/Pages:\s+(\d+)/)[1]);
    for (let p = 1; p <= pages; p += 1) {
      // The watermark is set at 45 degrees, so pdftotext emits its glyphs one per
      // line and out of order. Assert on the glyph set instead of the string.
      const text = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), file, '-']).toString();
      const letters = new Set(text.replace(/[^A-Z]/g, '').split(''));
      for (const ch of 'DRAFT') {
        assert.ok(letters.has(ch), `page ${p} is missing the watermark glyph "${ch}" (extracted: ${JSON.stringify(text.slice(0, 80))})`);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('placeholders', () => {
  test('an unresolved placeholder is reported, not silently blank', async () => {
    const { res } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<p>{{customer.name}} owes {{total}}</p>', data: { total: '9' } },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-pdfmint-warning') || '', /customer\.name/);
  });

  test('strict mode refuses instead of rendering an empty value', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>{{customer.name}}</p>', data: {}, strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unresolved_placeholders');
    assert.deepEqual(json.error.details.unresolved, ['customer.name']);
  });

  test('a section repeats for every item', async () => {
    const { buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: {
        html: '<ul>{{#items}}<li>{{name}} x{{qty}}</li>{{/items}}</ul>',
        data: { items: [{ name: 'Widget', qty: 2 }, { name: 'Gadget', qty: 7 }] },
      },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 's.pdf');
    fs.writeFileSync(file, buffer);
    const text = execFileSync('pdftotext', [file, '-']).toString();
    assert.match(text, /Widget x2/);
    assert.match(text, /Gadget x7/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('output modes', () => {
  test('a hosted URL is fetchable and returns the same document', async () => {
    const { json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>hosted</h1>', output: 'url', expiresInMinutes: 10 },
    });
    assert.ok(json.url, 'a url must be returned');
    const fetched = await fetch(json.url);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await fetched.arrayBuffer());
    assert.ok(isPdf(buf));
    assert.equal(buf.length, json.size);
  });

  test('base64 decodes to a PDF of the reported size', async () => {
    const { json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>b64</h1>', output: 'base64' } });
    const buf = Buffer.from(json.base64, 'base64');
    assert.ok(isPdf(buf));
    assert.equal(buf.length, json.size);
  });

  test('an unknown output mode is rejected on every endpoint that takes one', async () => {
    for (const path of ['/v1/pdf', '/v1/image']) {
      const { res, json } = await req(path, { method: 'POST', key, body: { html: '<p>x</p>', output: 'nope' } });
      assert.equal(res.status, 400, `${path} should reject an unknown output mode`);
      assert.equal(json.error.code, 'invalid_option');
    }
  });
});

describe('images and merging', () => {
  test('an image comes back as a real PNG', async () => {
    const { res, buffer } = await req('/v1/image', {
      method: 'POST', key, raw: true,
      body: { html: '<div style="padding:40px;background:#123">hi</div>', width: 400, height: 200 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG');
  });

  test('merging two documents yields the sum of their pages, in order', async () => {
    const one = await req('/v1/pdf', { method: 'POST', key, body: { markdown: '# First document', output: 'base64' } });
    const two = await req('/v1/pdf', { method: 'POST', key, body: { markdown: '# Second document', output: 'base64' } });
    const { res, buffer } = await req('/v1/merge', {
      method: 'POST', key, raw: true,
      body: { files: [{ base64: one.json.base64 }, { base64: two.json.base64 }] },
    });
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers.get('x-pdfmint-pages')), one.json.pages + two.json.pages);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 'm.pdf');
    fs.writeFileSync(file, buffer);
    const p1 = execFileSync('pdftotext', ['-f', '1', '-l', '1', file, '-']).toString();
    assert.match(p1, /First document/, 'the first input must come first');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('merging fewer than two files is refused', async () => {
    const { res, json } = await req('/v1/merge', { method: 'POST', key, body: { files: ['https://example.com/a.pdf'] } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_input');
  });
});

describe('templates', () => {
  test('save, list, render and delete a template addressed by name', async () => {
    const name = `invoice-${Date.now()}`;
    const put = await req(`/v1/templates/${name}`, {
      method: 'PUT', key,
      body: { html: '<h1>Invoice {{number}}</h1>', options: { margin: '15mm' } },
    });
    assert.equal(put.res.status, 200);

    const list = await req('/v1/templates', { key });
    assert.ok(list.json.templates.some((t) => t.name === name), 'the template must appear in the list');

    const { buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { template: name, data: { number: 'INV-77' } } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-test-'));
    const file = path.join(dir, 't.pdf');
    fs.writeFileSync(file, buffer);
    assert.match(execFileSync('pdftotext', [file, '-']).toString(), /Invoice INV-77/);
    fs.rmSync(dir, { recursive: true, force: true });

    const del = await req(`/v1/templates/${name}`, { method: 'DELETE', key });
    assert.equal(del.res.status, 200);
    const after = await req('/v1/templates', { key });
    assert.ok(!after.json.templates.some((t) => t.name === name), 'the template must be gone');
  });

  test('rendering a template that does not exist names the ones that do', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { template: 'no-such-template' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'template_not_found');
    assert.ok(json.error.hint, 'the error must tell the caller what to do');
  });
});

describe('refusals', () => {
  test('no key and a bad key both answer 401 with a machine code', async () => {
    const none = await req('/v1/pdf', { method: 'POST', body: { html: '<p>x</p>' } });
    assert.equal(none.res.status, 401);
    assert.equal(none.json.error.code, 'missing_api_key');

    const bad = await req('/v1/pdf', { method: 'POST', key: 'pm_live_definitely_not_real', body: { html: '<p>x</p>' } });
    assert.equal(bad.res.status, 401);
    assert.equal(bad.json.error.code, 'invalid_api_key');
  });

  test('the cloud metadata endpoint is not reachable through us', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/healthz', 'http://10.0.0.1/']) {
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { url } });
      assert.equal(res.status, 400, `${url} must be refused`);
      assert.equal(json.error.code, 'private_address_blocked', `${url} must be refused as private`);
    }
  });

  test('a non-http scheme is refused', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { url: 'file:///etc/passwd' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unsupported_url_scheme');
  });

  test('sending two sources at once is refused rather than guessed', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<p>a</p>', markdown: '# b' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'ambiguous_content');
  });

  test('every error carries a code, a message and a request id', async () => {
    const cases = [
      [{}, 'missing_content'],
      [{ html: 'x', options: { format: 'A9' } }, 'invalid_option'],
      [{ html: 'x', options: { scale: 9 } }, 'invalid_option'],
      [{ html: 'x', options: { width: '100mm' } }, 'invalid_option'],
      [{ html: 'x', timeout: 5 }, 'invalid_option'],
    ];
    for (const [body, code] of cases) {
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(json.error.code, code, JSON.stringify(body));
      assert.ok(json.error.message, 'a message');
      assert.ok(json.error.request_id, 'a request id');
    }
  });
});

describe('quota', () => {
  test('a successful render consumes exactly one credit and a failed one consumes none', async () => {
    const { key: k2 } = await newAccount();
    const before = (await req('/v1/me', { key: k2 })).json;
    assert.equal(before.credits_used, 0);

    await req('/v1/pdf', { method: 'POST', key: k2, raw: true, body: { html: '<p>ok</p>' } });
    const afterGood = (await req('/v1/me', { key: k2 })).json;
    assert.equal(afterGood.credits_used, 1);

    await req('/v1/pdf', { method: 'POST', key: k2, body: { url: 'https://no-such-host-pdfmint-test.invalid/' } });
    const afterBad = (await req('/v1/me', { key: k2 })).json;
    assert.equal(afterBad.credits_used, 1, 'a failed render must not cost a credit');
  });

  test('/v1/me reports the plan and when the quota resets', async () => {
    const { json } = await req('/v1/me', { key });
    assert.equal(json.plan, 'free');
    assert.equal(json.credits_limit, 300);
    assert.ok(Date.parse(json.period_resets_at) > Date.now());
  });
});

describe('asynchronous rendering', () => {
  test('a queued job finishes and exposes a fetchable URL', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { markdown: '# queued', async: true } });
    assert.equal(res.status, 202);
    assert.equal(json.status, 'queued');
    assert.match(json.job_id, /^job_/);

    let job = null;
    for (let i = 0; i < 40; i += 1) {
      job = (await req(`/v1/jobs/${json.job_id}`, { key })).json;
      if (job.status === 'succeeded' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(job.status, 'succeeded', `job ended as ${job && job.status}: ${JSON.stringify(job && job.error)}`);
    const fetched = await fetch(job.url);
    assert.equal(fetched.status, 200);
    assert.ok(isPdf(Buffer.from(await fetched.arrayBuffer())));
  });

  test('someone else\'s job is not visible', async () => {
    const { key: other } = await newAccount();
    const mine = (await req('/v1/pdf', { method: 'POST', key, body: { markdown: '# private', async: true } })).json;
    const { res, json } = await req(`/v1/jobs/${mine.job_id}`, { key: other });
    assert.equal(res.status, 404);
    assert.equal(json.error.code, 'job_not_found');
  });
});

describe('rate limiting', () => {
  test('a burst past the limit answers 429 with a Retry-After the caller can act on', async () => {
    const { key: k } = await newAccount();
    const responses = await Promise.all(Array.from({ length: 60 }, () =>
      fetch(`${require('./helpers').BASE}/v1/me`, { headers: { Authorization: `Bearer ${k}` } })));
    const limited = responses.filter((r) => r.status === 429);
    const allowed = responses.filter((r) => r.status === 200);
    assert.ok(allowed.length > 0, 'some requests must get through');
    assert.ok(limited.length > 0, `expected some requests to be limited, all ${responses.length} succeeded`);

    const one = limited[0];
    assert.ok(Number(one.headers.get('retry-after')) >= 1, 'Retry-After must be a usable number of seconds');
    assert.equal(one.headers.get('x-ratelimit-limit'), '120');
    const body = await one.json();
    assert.equal(body.error.code, 'rate_limited');

    // And after waiting the advertised time, the caller gets back in.
    await new Promise((r) => setTimeout(r, (Number(one.headers.get('retry-after')) + 1) * 1000));
    const after = await fetch(`${require('./helpers').BASE}/v1/me`, { headers: { Authorization: `Bearer ${k}` } });
    assert.equal(after.status, 200, 'the limit must lift after Retry-After');
  });
});

describe('the public site', () => {
  test('the pages a stranger needs all answer', async () => {
    for (const [path, expect] of [['/', 200], ['/docs', 200], ['/signup', 200], ['/login', 200], ['/status', 200], ['/status.json', 200], ['/healthz', 200]]) {
      const { res } = await req(path);
      assert.equal(res.status, expect, `${path} should answer ${expect}`);
    }
  });

  test('every docs anchor the API links to actually exists', async () => {
    const { text } = await req('/docs');
    const srcDir = path.join(__dirname, '..', 'src');
    const anchors = new Set();
    for (const file of fs.readdirSync(srcDir)) {
      const src = fs.readFileSync(path.join(srcDir, file), 'utf8');
      for (const m of src.matchAll(/docs['"]?:\s*'\/docs#([a-z0-9-]+)'/g)) anchors.add(m[1]);
    }
    assert.ok(anchors.size > 5, `expected several anchors, found ${anchors.size}`);
    for (const a of anchors) {
      assert.ok(text.includes(`id="${a}"`), `the docs page is missing an anchor the API links to: #${a}`);
    }
  });
});
