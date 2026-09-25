'use strict';

// C3 cover contract tests (round pdfmint-r0-2a9e3fb5): options.coverHtml renders as the
// first page(s), the content follows with header/footer/page numbers, and content numbering
// restarts at 1 with {total} counting content pages only — proven end to end against the
// live HTTP surface, pdftotext and pdfinfo.
//
// Environment contract:
// (a) The server under test must already be running (the suite starts it pinned at
//     TEST_BASE_URL, default http://127.0.0.1:3000); before() asserts /healthz answers 200.
// (b) Runs with RATE_LIMIT_BURST=300 ALLOW_PRIVATE_NETWORK=1 PUBLIC_URL=http://127.0.0.1:3000
//     inherited from the environment. This file sends no URL input, so it never leaves the
//     machine.
// (c) Tests only ever talk to the local disposable test Postgres, never production. The
//     documented disposable DSN for this round is
//     postgresql://pdfmint:pdfmint@127.0.0.1:55436/pdfmint_test (supplied via DATABASE_URL).
//     This file issues no direct SQL of its own; accounts are throwaway (@pdfmint.test) and
//     the API key stays inside this process.
// (d) PDF inspection is done with the preinstalled CLI tools pdftotext and pdfinfo
//     (execFileSync), never with the service's own code.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { req, newAccount, isPdf } = require('./helpers');

// ISO A4 in PostScript points (the register's 1 pt bound is measured against these).
const A4_PORTRAIT = { width: 595.276, height: 841.89 };
const DIMENSION_TOLERANCE_PT = 1.0;

function marker(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function withPageText(buffer, pageCount, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c3-text-'));
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

/** Every page's MediaBox size in points, parsed from pdfinfo (never from our own code). */
function pageDims(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c3-dims-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const out = execFileSync('pdfinfo', ['-f', '1', '-l', '1000', file]).toString();
    const dims = [];
    const re = /^Page(?:\s+\d+)?\s+size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts/gm;
    let match;
    while ((match = re.exec(out)) !== null) {
      dims.push({ width: Number(match[1]), height: Number(match[2]) });
    }
    return dims;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Independent page count via pdfinfo (never the service's own code). The raw-regex
 * helper countPagesIndependently is blind to pdf-lib's compressed merged output
 * (object streams), and every C3 document is a merge — pdfinfo is the honest
 * independent witness here, the same tool pageDims uses.
 */
function countPagesPdfinfo(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c3-pages-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const out = execFileSync('pdfinfo', [file]).toString();
    return Number(/^Pages:\s*(\d+)/m.exec(out)[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Top edge (pt from the page top) of the first word containing `needle` on page 1, via pdftotext -bbox. */
function firstWordTopPt(buffer, needle) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c3-bbox-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const out = execFileSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-']).toString();
    for (const m of out.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>([^<]*)<\/word>/g)) {
      if (m[2].includes(needle)) return Number(m[1]);
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let key;

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the pinned server must answer /healthz with 200');
  const account = await newAccount('starter');
  key = account.key;
});

test('T-C3a: coverHtml renders the cover first with no header/footer/numbers; content numbering restarts at 1 of 3', async () => {
  const cover = marker('c3cover');
  const header = marker('c3header');
  const s1 = marker('c3s1');
  const s2 = marker('c3s2');
  const s3 = marker('c3s3');
  const html = `<section style="page-break-after:always"><h1>${s1}</h1></section>`
    + `<section style="page-break-after:always"><h1>${s2}</h1></section>`
    + `<section><h1>${s3}</h1></section>`;
  const { res, buffer } = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: {
      html,
      options: {
        format: 'A4',
        headerHtml: `<div>${header}</div>`,
        pageNumbers: true,
        coverHtml: `<h1>${cover}</h1>`,
      },
    },
    raw: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(isPdf(buffer), 'response body is a PDF');
  assert.equal(Number(res.headers.get('x-pdfmint-pages')), 4);
  assert.equal(countPagesPdfinfo(buffer), 4);

  const dims = pageDims(buffer);
  assert.equal(dims.length, 4);
  for (const d of dims) {
    assert.ok(Math.abs(d.width - A4_PORTRAIT.width) <= DIMENSION_TOLERANCE_PT, `page width ${d.width} within 1 pt of A4`);
    assert.ok(Math.abs(d.height - A4_PORTRAIT.height) <= DIMENSION_TOLERANCE_PT, `page height ${d.height} within 1 pt of A4`);
  }

  withPageText(buffer, 4, (pages) => {
    // Page 1: the cover only — no header marker, no page numbers.
    assert.ok(pages[0].includes(cover), 'page 1 contains the cover marker');
    assert.ok(!pages[0].includes(header), 'page 1 has no header marker');
    assert.ok(!/Page\s+\d+\s+of\s+\d+/.test(pages[0]), 'page 1 has no Page … of … line');
    // Pages 2-4: header marker, their own marker, numbering 1..3 of 3.
    assert.ok(pages[1].includes(header), 'page 2 has the header marker');
    assert.ok(pages[1].includes(s1), 'page 2 has section 1 marker');
    assert.ok(/Page\s+1\s+of\s+3/.test(pages[1]), 'page 2 shows Page 1 of 3');
    assert.ok(pages[2].includes(header), 'page 3 has the header marker');
    assert.ok(pages[2].includes(s2), 'page 3 has section 2 marker');
    assert.ok(/Page\s+2\s+of\s+3/.test(pages[2]), 'page 3 shows Page 2 of 3');
    assert.ok(pages[3].includes(header), 'page 4 has the header marker');
    assert.ok(pages[3].includes(s3), 'page 4 has section 3 marker');
    assert.ok(/Page\s+3\s+of\s+3/.test(pages[3]), 'page 4 shows Page 3 of 3');
  });

  // C-S5 margin: a tall header grows the CONTENT top margin (to ~70 mm here), but the
  // cover prints with header/footer mode off and must keep the plain 12 mm default.
  const tallCover = marker('c3tall');
  const tall = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: {
      html: `<h1>${s1}</h1>`,
      options: {
        format: 'A4',
        headerHtml: `<div style="height:60mm">${header}</div>`,
        coverHtml: `<h1>${tallCover}</h1>`,
      },
    },
    raw: true,
  });
  assert.equal(tall.res.status, 200);
  const coverTop = firstWordTopPt(tall.buffer, tallCover);
  assert.ok(coverTop !== null, 'cover marker found on page 1');
  // 12 mm = 34 pt margin + the h1's own top margin; the grown header margin would be > 170 pt.
  assert.ok(coverTop < 120, `cover text starts ${coverTop} pt from the top — the header's reserved margin leaked onto the cover`);
});

test('T-C3b: cover placeholders are filled from data, nested and FLAT without any header/footer mode (ungated fill)', async () => {
  const cover = marker('c3bcover');
  const s1 = marker('c3bs1');
  const s2 = marker('c3bs2');

  // (i) Nested options: custom pageNumbers template + cover with a placeholder.
  const first = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: {
      html: `<section style="page-break-after:always"><h1>${s1}</h1></section><section><h1>${s2}</h1></section>`,
      data: { name: 'ACME' },
      options: {
        pageNumbers: 'Seite {page} von {total}',
        coverHtml: `<h1>${cover} Cover for {{name}}</h1>`,
      },
    },
    raw: true,
  });
  assert.equal(first.res.status, 200);
  assert.ok(isPdf(first.buffer));
  assert.equal(countPagesPdfinfo(first.buffer), 3);
  withPageText(first.buffer, 3, (pages) => {
    assert.ok(pages[0].includes(cover), 'page 1 contains the cover marker');
    assert.ok(pages[0].includes('Cover for ACME'), 'page 1 shows the FILLED cover placeholder');
    assert.ok(!/Seite\s+\d+\s+von\s+\d+/.test(pages[0]), 'page 1 shows no Seite … von … line');
    assert.ok(/Seite\s+1\s+von\s+2/.test(pages[1]), 'page 2 shows Seite 1 von 2');
    assert.ok(/Seite\s+2\s+von\s+2/.test(pages[2]), 'page 3 shows Seite 2 von 2');
  });

  // (ii) FLAT cover+data with NO header/footer/pageNumbers at all — the fill must still
  // happen (ungated), and the cover must render filled, not with literal braces.
  const second = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: {
      html: `<section style="page-break-after:always"><h1>${s1}</h1></section><section><h1>${s2}</h1></section>`,
      data: { name: 'ACME' },
      coverHtml: `<h1>${cover} Cover for {{name}}</h1>`,
    },
    raw: true,
  });
  assert.equal(second.res.status, 200);
  assert.ok(isPdf(second.buffer));
  assert.equal(countPagesPdfinfo(second.buffer), 3);
  withPageText(second.buffer, 3, (pages) => {
    assert.ok(pages[0].includes(cover), 'flat render: page 1 contains the cover marker');
    assert.ok(pages[0].includes('Cover for ACME'), 'flat render: page 1 shows the FILLED cover, not the literal placeholder');
    assert.ok(!pages[0].includes('{{name}}'), 'flat render: page 1 has no literal {{name}}');
    assert.ok(pages[1].includes(s1), 'flat render: page 2 has section 1 marker');
    assert.ok(pages[2].includes(s2), 'flat render: page 3 has section 2 marker');
  });
});

test('T-C3c: surface honesty — schema, endpoint refusals, hygiene, combination refusal, stored-template carry', async () => {
  // (1) /openapi.json documents coverHtml in the options object AND in the flat block.
  // The served spec inlines both blocks under paths["/v1/pdf"].post.requestBody (the spec
  // components hold only Error/FileJson/Job), so the assertion navigates the real document
  // instead of assuming component names.
  const oa = await req('/openapi.json');
  assert.equal(oa.res.status, 200);
  const schema = oa.json.paths['/v1/pdf'].post.requestBody.content['application/json'].schema;
  assert.ok(schema.properties.options.properties.coverHtml, 'coverHtml in the options object properties');
  assert.ok(schema.properties.coverHtml, 'coverHtml in the flat body block');

  // (2) /v1/image and /v1/merge must both refuse coverHtml with unknown_field.
  const img = await req('/v1/image', { method: 'POST', key, body: { html: '<h1>x</h1>', coverHtml: '<h1>c</h1>' } });
  assert.equal(img.res.status, 400);
  assert.equal(img.json.error.code, 'unknown_field');
  const merged = await req('/v1/merge', {
    method: 'POST',
    key,
    body: {
      files: [
        'data:application/pdf;base64,' + Buffer.from('not a pdf').toString('base64'),
        'data:application/pdf;base64,' + Buffer.from('not a pdf').toString('base64'),
      ],
      coverHtml: '<h1>c</h1>',
    },
  });
  assert.equal(merged.res.status, 400);
  assert.equal(merged.json.error.code, 'unknown_field');

  // (3) Non-string coverHtml is a 400.
  const bad = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>x</h1>', coverHtml: 42 } });
  assert.equal(bad.res.status, 400);

  // (4) coverHtml + pageRanges is refused with invalid_option.
  const combo = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: { html: '<h1>x</h1>', coverHtml: '<h1>c</h1>', pageRanges: '1' },
  });
  assert.equal(combo.res.status, 400);
  assert.equal(combo.json.error.code, 'invalid_option');

  // (5) Stored-template carry: a template's stored options.coverHtml renders FILLED.
  const tplName = `c3-tpl-${crypto.randomBytes(4).toString('hex')}`;
  const put = await req(`/v1/templates/${tplName}`, {
    method: 'PUT',
    key,
    body: {
      html: '<h1>Body</h1>',
      options: { coverHtml: '<h1>TPL COVER {{brand}}</h1>' },
    },
  });
  assert.equal(put.res.status, 200, `PUT template failed: ${put.text.slice(0, 200)}`);
  const tplRender = await req('/v1/pdf', {
    method: 'POST',
    key,
    body: { template: tplName, data: { brand: 'X' } },
    raw: true,
  });
  assert.equal(tplRender.res.status, 200, `template render failed: ${tplRender.buffer ? tplRender.buffer.toString('utf8', 0, 300) : ''}`);
  assert.ok(isPdf(tplRender.buffer));
  withPageText(tplRender.buffer, countPagesPdfinfo(tplRender.buffer), (pages) => {
    assert.ok(pages[0].includes('TPL COVER X'), `page 1 contains the FILLED stored cover; got: ${pages[0].slice(0, 200)}`);
    assert.ok(!pages[0].includes('{{brand}}'), 'page 1 has no literal {{brand}}');
  });
});
