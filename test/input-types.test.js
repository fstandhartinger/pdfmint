'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { BASE, req, newAccount, isPdf, countPagesIndependently } = require('./helpers');

function randomMarker(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function assertPdfResponse({ res, buffer }, expectedPages) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(isPdf(buffer), 'response body is a PDF');
  const reported = Number(res.headers.get('x-pdfmint-pages'));
  assert.equal(reported, expectedPages);
  assert.equal(countPagesIndependently(buffer), expectedPages);
}

function withPageText(buffer, pageCount, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-input-types-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const pages = [];
    for (let page = 1; page <= pageCount; page += 1) {
      pages.push(execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-']).toString());
    }
    return fn(pages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function creditsUsed(key) {
  const { res, json } = await req('/v1/me', { key });
  assert.equal(res.status, 200);
  assert.ok(Number.isInteger(json.credits_used), '/v1/me must report credits_used as an integer');
  return json.credits_used;
}

function assertInputError({ res, json }, code) {
  assert.equal(res.status, 400);
  assert.ok(json);
  assert.equal(json.error.code, code);
  assert.ok(json.error.message, 'error.message must be truthy');
  assert.ok(json.error.request_id, 'error.request_id must be truthy');
  assert.equal(json.error.docs, `${BASE.replace(/\/$/, '')}/docs#input`);
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the server under test must be running');
});

describe('C1 input types', () => {
  test('C1a renders HTML with explicit page breaks and page-local markers', async () => {
    const { key } = await newAccount();
    const base = randomMarker('c1a');
    const markers = [1, 2, 3].map((page) => `${base}-page-${page}`);
    const html = `<!doctype html><style>.page { break-after: page; page-break-after: page; }</style>${markers.map((marker) => `<section class="page"><p>${marker}</p></section>`).join('')}`;

    const { res, buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html } });
    assertPdfResponse({ res, buffer }, 3);
    withPageText(buffer, 3, (pages) => {
      markers.forEach((marker, index) => {
        assert.ok(pages[index].includes(marker), `marker ${index + 1} must be on page ${index + 1}`);
        for (let page = 0; page < pages.length; page += 1) {
          if (page !== index) assert.ok(!pages[page].includes(marker), `marker ${index + 1} must not be on page ${page + 1}`);
        }
      });
    });
  });

  test('C1b renders Markdown, GFM tables, and a raw page-break element', async () => {
    const { key } = await newAccount();
    const marker = randomMarker('c1b');
    const markdown = [
      '# Contract Heading',
      '',
      '| Item | Value |',
      '|---|---|',
      '| First | Contract Cell |',
      '',
      '<div style="break-after: page"></div>',
      '',
      `<p>${marker}</p>`,
    ].join('\n');

    const { res, buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { markdown } });
    assertPdfResponse({ res, buffer }, 2);
    withPageText(buffer, 2, (pages) => {
      assert.ok(pages[0].includes('Contract Heading'), 'the heading must be on page 1');
      assert.ok(pages[0].includes('Contract Cell'), 'a table cell must be on page 1');
      assert.ok(pages[1].includes(marker), 'the marker paragraph must be on page 2');
      assert.ok(!pages[0].includes(marker), 'the marker paragraph must not be on page 1');
      assert.ok(!pages.join('\n').includes('|---|'), 'the GFM separator must not appear literally');
      assert.ok(!pages.join('\n').includes('# '), 'the heading marker must not appear literally');
    });
  });

  test('C1c renders an owned local URL with page-local markers', async (t) => {
    const { key } = await newAccount();
    const firstMarker = randomMarker('c1c-first');
    const secondMarker = randomMarker('c1c-second');
    const html = `<!doctype html><style>.page { break-after: page; page-break-after: page; }</style><section class="page"><p>${firstMarker}</p></section><section><p>${secondMarker}</p></section>`;
    const server = http.createServer((incoming, outgoing) => {
      if (incoming.url !== '/c1.html') {
        outgoing.statusCode = 404;
        outgoing.end('not found');
        return;
      }
      outgoing.setHeader('content-type', 'text/html; charset=utf-8');
      outgoing.end(html);
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      const { res, buffer } = await req('/v1/pdf', {
        method: 'POST', key, raw: true,
        body: { url: `http://127.0.0.1:${port}/c1.html` },
      });
      let refusal = null;
      if (res.status === 400) { try { refusal = JSON.parse(buffer.toString()); } catch { /* not json */ } }
      if (refusal?.error?.code === 'private_address_blocked') {
        t.skip('server not started with ALLOW_PRIVATE_NETWORK=1');
        return;
      }

      assertPdfResponse({ res, buffer }, 2);
      withPageText(buffer, 2, (pages) => {
        assert.ok(pages[0].includes(firstMarker), 'the first URL marker must be on page 1');
        assert.ok(pages[1].includes(secondMarker), 'the second URL marker must be on page 2');
        assert.ok(!pages[1].includes(firstMarker), 'the first URL marker must not be on page 2');
        assert.ok(!pages[0].includes(secondMarker), 'the second URL marker must not be on page 1');
      });
    } finally {
      await closeServer(server);
    }
  });

  test('C1c refuses a malformed URL', async () => {
    const { key } = await newAccount();
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { url: 'not a url' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_url');
  });

  test('C1d isolates templates by account and fills a two-page template', async (t) => {
    const accountA = await newAccount();
    const accountB = await newAccount();
    const templateName = `c1-${randomMarker('template')}`;
    const title = randomMarker('c1d-title');
    const rows = [
      { name: randomMarker('c1d-row-1') },
      { name: randomMarker('c1d-row-2') },
    ];
    const html = `<!doctype html><style>.break { break-after: page; page-break-after: page; }</style><h1>{{title}}</h1><div class="break"></div>{{#rows}}<p>{{name}}</p>{{/rows}}`;

    const put = await req(`/v1/templates/${encodeURIComponent(templateName)}`, {
      method: 'PUT', key: accountA.key, body: { html },
    });
    assert.equal(put.res.status, 200);

    t.after(async () => {
      const deleted = await req(`/v1/templates/${encodeURIComponent(templateName)}`, {
        method: 'DELETE', key: accountA.key,
      });
      assert.equal(deleted.res.status, 200);
    });

    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key: accountA.key, raw: true,
      body: { template: templateName, data: { title, rows } },
    });
    assertPdfResponse({ res, buffer }, 2);
    withPageText(buffer, 2, (pages) => {
      const text = pages.join('\n');
      assert.ok(pages[0].includes(title), 'the filled title must be on page 1');
      for (const row of rows) assert.ok(pages[1].includes(row.name), 'each filled row must be on page 2');
      assert.ok(!text.includes('{{'), 'no template markers may remain in extracted text');
    });

    const crossAccount = await req('/v1/pdf', {
      method: 'POST', key: accountB.key,
      body: { template: templateName },
    });
    assert.equal(crossAccount.res.status, 400);
    assert.equal(crossAccount.json.error.code, 'template_not_found');
    assert.ok(crossAccount.json.error.hint);
    assert.ok(!crossAccount.json.error.hint.includes(templateName), 'account B must not learn account A\'s template name');

    const unknown = await req('/v1/pdf', {
      method: 'POST', key: accountA.key,
      body: { template: `c1-${randomMarker('unknown')}` },
    });
    assert.equal(unknown.res.status, 400);
    assert.equal(unknown.json.error.code, 'template_not_found');
    assert.ok(unknown.json.error.hint.includes(templateName), 'account A\'s hint must list its own template');
  });

  test('C1e refuses missing content sources without consuming credits', async () => {
    const { key } = await newAccount();
    const before = await creditsUsed(key);
    const cases = [
      {},
      { html: '' },
      { html: null },
      { markdown: '' },
      { options: { format: 'A4' } },
    ];

    for (const body of cases) {
      const result = await req('/v1/pdf', { method: 'POST', key, body });
      assertInputError(result, 'missing_content');
    }

    const after = await creditsUsed(key);
    assert.equal(after, before, 'missing-source refusals must not consume credits');
  });

  test('C1e pins the observed whitespace-only HTML response', async () => {
    const { key } = await newAccount();
    const before = await creditsUsed(key);
    const { res, buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '   ' } });

    // Observed on 22 Sep 2026: whitespace-only HTML is a successful one-page blank render with a warning, not a missing-content refusal.
    assert.equal(res.status, 200);
    assert.ok(isPdf(buffer));
    assert.equal(Number(res.headers.get('x-pdfmint-pages')), 1);
    assert.match(res.headers.get('x-pdfmint-warning') || '', /no visible text/i);
    const after = await creditsUsed(key);
    assert.equal(after, before + 1);
  });

  test('C1f refuses every reachable ambiguous source combination without consuming credits', async () => {
    const { key } = await newAccount();
    const before = await creditsUsed(key);
    const marker = randomMarker('c1f');
    const cases = [
      { html: `${marker}-html`, url: `http://127.0.0.1/${marker}` },
      { markdown: `# ${marker}`, template: `${marker}-template` },
      { url: `http://127.0.0.1/${marker}`, template: `${marker}-template` },
      { html: `${marker}-html`, markdown: `# ${marker}`, url: `http://127.0.0.1/${marker}` },
    ];

    for (const body of cases) {
      const fields = Object.keys(body);
      const result = await req('/v1/pdf', { method: 'POST', key, body });
      assert.equal(result.res.status, 400);
      assert.equal(result.json.error.code, 'ambiguous_content');
      assert.ok(result.json.error.message);
      for (const field of fields) {
        assert.ok(result.json.error.message.includes(field), `the ambiguity message must name ${field}`);
      }
      assertInputError(result, 'ambiguous_content');
    }

    const after = await creditsUsed(key);
    assert.equal(after, before, 'ambiguous-source refusals must not consume credits');
  });

  test('C1g applies the same source errors synchronously in async mode', async () => {
    const { key } = await newAccount();
    const cases = [
      [{ async: true }, 'missing_content'],
      [{ async: true, html: `${randomMarker('c1g-html')}`, url: `http://127.0.0.1/${randomMarker('c1g-url')}` }, 'ambiguous_content'],
      [{ async: true, template: `c1-${randomMarker('c1g-unknown')}` }, 'template_not_found'],
    ];

    for (const [body, code] of cases) {
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body });
      assert.equal(res.status, 400);
      assert.equal(json.error.code, code);
      assert.deepEqual(Object.keys(json), ['error'], 'a synchronous refusal carries only the error, no job id');
      assert.ok(json.error.message);
      assert.ok(json.error.request_id);
    }
  });
});
