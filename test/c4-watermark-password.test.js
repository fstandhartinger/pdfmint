'use strict';

// C4 watermark/encryption contract tests (round pdfmint-r0-8577e184): the watermark is
// stamped on EVERY page — including the cover of the internally merged cover/content
// document — and password protection is AES-256 with a user/owner split, the documented
// permission defaults, and an honest page count (omitted on encrypted output) — proven
// end to end against the live HTTP surface, qpdf, pdftotext and pdfinfo.
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
// (d) PDF inspection is done with the preinstalled CLI tools qpdf, pdftotext and pdfinfo
//     (execFileSync), never with the service's own code. Test passwords are random
//     throwaway fixtures generated in this process; qpdf echoes the supplied user
//     password in its output, so no qpdf output is ever included in an assertion message.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { req, newAccount, isPdf } = require('./helpers');

function marker(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/** qpdf is a server-side dependency of encryption; detect it once, like api.test.js:93. */
function hasQpdf() {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const QPDF = hasQpdf();

function qpdfRun(args) {
  return execFileSync('qpdf', args, { stdio: 'pipe' }).toString();
}

function showEncryption(file, password) {
  return qpdfRun(['--show-encryption', `--password=${password}`, file]);
}

function withPageText(buffer, pageCount, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c4-text-'));
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

/**
 * Independent page count via pdfinfo (never the service's own code). The raw-regex
 * helper countPagesIndependently is blind to pdf-lib's compressed output (object
 * streams) and to qpdf-processed files — every watermarked or encrypted buffer in
 * this file is one of those, so pdfinfo is the honest independent witness.
 */
function countPagesPdfinfo(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c4-pages-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const out = execFileSync('pdfinfo', [file]).toString();
    return Number(/^Pages:\s*(\d+)/m.exec(out)[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The watermark is drawn at 45 degrees, so pdftotext emits its glyphs roughly one
 * per line and out of order. Collect every non-space character of a page into a
 * set and assert membership, never the watermark string (mirrors api.test.js:113).
 */
function glyphSet(text) {
  const s = new Set();
  for (const ch of text.replace(/\s/g, '')) s.add(ch);
  return s;
}

let key;

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the pinned server must answer /healthz with 200');
  const account = await newAccount('starter');
  key = account.key;
});

test('T-C4a: the watermark lands on the cover AND every content page of the internally merged document', async () => {
  const s1 = marker('c4s1');
  const s2 = marker('c4s2');
  const html = `<section style="page-break-after:always"><h1>${s1}</h1></section>`
    + `<section><h1>${s2}</h1></section>`;
  const { res, buffer } = await req('/v1/pdf', {
    method: 'POST',
    key,
    raw: true,
    body: {
      html,
      options: {
        coverHtml: '<h1>C4COVER</h1>',
        watermark: 'PROOF',
      },
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(isPdf(buffer), 'response body is a PDF');
  // Two witnesses for the page count: the service-side header under test and the
  // independent pdfinfo count (never countPagesIndependently on this buffer).
  assert.equal(Number(res.headers.get('x-pdfmint-pages')), 3, 'the header reports cover + 2 content pages');
  assert.equal(countPagesPdfinfo(buffer), 3, 'pdfinfo independently counts 3 pages');

  withPageText(buffer, 3, (pages) => {
    assert.ok(pages[0].includes('C4COVER'), 'page 1 contains the cover marker');
    assert.ok(pages[1].includes(s1), 'page 2 has the section 1 marker');
    assert.ok(pages[2].includes(s2), 'page 3 has the section 2 marker');
    for (let i = 0; i < pages.length; i += 1) {
      const glyphs = glyphSet(pages[i]);
      for (const ch of 'PROOF') {
        assert.ok(glyphs.has(ch), `page ${i + 1} is missing the watermark glyph "${ch}"`);
      }
    }
  });
});

test('T-C4b: encryption semantics — AES-256, user/owner split, wrong password rejected, watermark survives decryption', async (t) => {
  if (!QPDF) {
    t.skip('qpdf is not installed on this host, so encryption is unavailable here');
    return;
  }
  const userPw = `c4user-${crypto.randomBytes(8).toString('hex')}`;
  const ownerPw = `c4owner-${crypto.randomBytes(8).toString('hex')}`;
  const s1 = marker('c4b1');
  const s2 = marker('c4b2');
  const html = `<section style="page-break-after:always"><h1>${s1}</h1></section>`
    + `<section><h1>${s2}</h1></section>`;
  const { res, buffer } = await req('/v1/pdf', {
    method: 'POST',
    key,
    raw: true,
    body: { html, watermark: 'LOCKED', password: userPw, ownerPassword: ownerPw },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(isPdf(buffer), 'response body is a PDF');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c4-enc-'));
  const file = path.join(dir, 'enc.pdf');
  try {
    fs.writeFileSync(file, buffer);

    // (1) AES-256 (R = 6, AESv3); the user password is recognised as the user
    // password, the owner password as the owner password — and never as the user
    // password, so the two are distinct.
    const asUser = showEncryption(file, userPw);
    assert.match(asUser, /R = 6/, 'qpdf reports revision 6 (AES-256)');
    assert.match(asUser, /stream encryption method: AESv3/, 'stream encryption is AESv3');
    assert.match(asUser, /Supplied password is (the )?user password/, 'the user password is recognised as the user password');
    const asOwner = showEncryption(file, ownerPw);
    assert.match(asOwner, /Supplied password is (the )?owner password/, 'the owner password is recognised as the owner password');
    assert.doesNotMatch(asOwner, /Supplied password is (the )?user password/, 'the owner password is NOT the user password');

    // (2) --check passes with the user password and is rejected with a wrong one.
    qpdfRun(['--check', `--password=${userPw}`, file]);
    assert.throws(
      () => qpdfRun(['--check', '--password=c4-wrong-password', file]),
      /invalid password/,
      'a wrong password must make qpdf --check fail',
    );

    // (3) Decrypted with the user password: watermark glyphs and the page markers
    // are still on every page (the watermark survives encryption).
    const dec = path.join(dir, 'decrypted.pdf');
    qpdfRun(['--decrypt', `--password=${userPw}`, file, dec]);
    const decBuffer = fs.readFileSync(dec);
    assert.ok(isPdf(decBuffer), 'the decrypted file is a PDF');
    const decPages = countPagesPdfinfo(decBuffer);
    assert.equal(decPages, 2, 'the decrypted document has the two content pages');
    withPageText(decBuffer, decPages, (pages) => {
      for (let i = 0; i < pages.length; i += 1) {
        const glyphs = glyphSet(pages[i]);
        for (const ch of 'LOCKED') {
          assert.ok(glyphs.has(ch), `decrypted page ${i + 1} is missing the watermark glyph "${ch}"`);
        }
      }
      assert.ok(pages[0].includes(s1), 'decrypted page 1 has the section 1 marker');
      assert.ok(pages[1].includes(s2), 'decrypted page 2 has the section 2 marker');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-C4c: permission matrix — documented defaults and the allowPrinting/allowCopying overrides', async (t) => {
  if (!QPDF) {
    t.skip('qpdf is not installed on this host, so encryption is unavailable here');
    return;
  }
  const pw = `c4perm-${crypto.randomBytes(8).toString('hex')}`;
  const html = '<h1>permissions</h1>';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c4-perm-'));
  try {
    const renderEncrypted = async (name, extra) => {
      const { res, buffer } = await req('/v1/pdf', {
        method: 'POST', key, raw: true, body: { html, password: pw, ...extra },
      });
      assert.equal(res.status, 200, `${name}: render must succeed`);
      assert.ok(isPdf(buffer), `${name}: response body is a PDF`);
      const file = path.join(dir, name);
      fs.writeFileSync(file, buffer);
      return showEncryption(file, pw);
    };

    // (1) Defaults (password only): allowPrinting true, allowCopying false.
    // The "extract for accessibility" line is deliberately never asserted — qpdf
    // keeps it allowed even with --extract=n.
    const def = await renderEncrypted('default.pdf', {});
    assert.match(def, /print low resolution: allowed/, 'default allowPrinting=true allows low-resolution printing');
    assert.match(def, /print high resolution: allowed/, 'default allowPrinting=true allows high-resolution printing');
    assert.match(def, /extract for any purpose: not allowed/, 'default allowCopying=false forbids extraction');

    // (2) allowPrinting: false → both print resolutions not allowed.
    const noPrint = await renderEncrypted('noprint.pdf', { allowPrinting: false });
    assert.match(noPrint, /print low resolution: not allowed/, 'allowPrinting=false forbids low-resolution printing');
    assert.match(noPrint, /print high resolution: not allowed/, 'allowPrinting=false forbids high-resolution printing');

    // (3) allowCopying: true → extraction allowed.
    const copy = await renderEncrypted('copy.pdf', { allowCopying: true });
    assert.match(copy, /extract for any purpose: allowed/, 'allowCopying=true allows extraction');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-C4c: counting honesty — encrypted output reports no page count, the unencrypted twin does', async (t) => {
  if (!QPDF) {
    t.skip('qpdf is not installed on this host, so encryption is unavailable here');
    return;
  }
  const pw = `c4count-${crypto.randomBytes(8).toString('hex')}`;
  const s1 = marker('c4c1');
  const s2 = marker('c4c2');
  const html = `<section style="page-break-after:always"><h1>${s1}</h1></section>`
    + `<section><h1>${s2}</h1></section>`;

  // (a) Binary mode: the header is ABSENT on the encrypted render and present
  // with the right count on the identical unencrypted twin.
  const enc = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html, password: pw } });
  assert.equal(enc.res.status, 200);
  assert.ok(isPdf(enc.buffer), 'encrypted response body is a PDF');
  assert.equal(enc.res.headers.get('x-pdfmint-pages'), null, 'the encrypted binary render must not report a page count');
  const twin = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html } });
  assert.equal(twin.res.status, 200);
  assert.ok(isPdf(twin.buffer), 'twin response body is a PDF');
  assert.equal(Number(twin.res.headers.get('x-pdfmint-pages')), 2, 'the unencrypted twin reports its real page count');
  assert.equal(countPagesPdfinfo(twin.buffer), 2, 'pdfinfo agrees on the twin page count');

  // (b) base64 mode: pages is null on the encrypted render, the real count on the twin.
  const encJson = await req('/v1/pdf', { method: 'POST', key, body: { html, password: pw, output: 'base64' } });
  assert.equal(encJson.res.status, 200);
  assert.equal(encJson.json.pages, null, 'the encrypted base64 render reports pages: null');
  const twinJson = await req('/v1/pdf', { method: 'POST', key, body: { html, output: 'base64' } });
  assert.equal(twinJson.res.status, 200);
  assert.equal(twinJson.json.pages, 2, 'the unencrypted base64 twin reports its real page count');
});

test('T-C4c: surface boundary — watermark/encryption are refused where they are not documented', async () => {
  // On /v1/merge rejectUnknownFields runs BEFORE input validation, so an empty
  // pdfs array still surfaces the unknown field.
  const mergeWm = await req('/v1/merge', { method: 'POST', key, body: { pdfs: [], watermark: 'x' } });
  assert.equal(mergeWm.res.status, 400);
  assert.equal(mergeWm.json.error.code, 'unknown_field');
  const mergePw = await req('/v1/merge', { method: 'POST', key, body: { pdfs: [], password: 'x' } });
  assert.equal(mergePw.res.status, 400);
  assert.equal(mergePw.json.error.code, 'unknown_field');
  // On /v1/image pickSource runs BEFORE rejectUnknownFields, so the request
  // carries a normal content field to surface the unknown password.
  const imgPw = await req('/v1/image', { method: 'POST', key, body: { html: '<p>x</p>', password: 'x' } });
  assert.equal(imgPw.res.status, 400);
  assert.equal(imgPw.json.error.code, 'unknown_field');
  // An empty watermark object is a known field with an invalid value.
  const emptyWm = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>x</h1>', watermark: {} } });
  assert.equal(emptyWm.res.status, 400);
  assert.equal(emptyWm.json.error.code, 'invalid_option');
});
