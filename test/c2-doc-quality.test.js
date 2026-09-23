'use strict';

// C2 document-quality contract tests (round pdfmint-r0-191a22a6): a three-page document
// with header, footer and page numbers, in both orientations, with page dimensions within
// 1 pt of the requested ISO A4 size and a raster proof that header, body and footer never
// overlap (the measured-margin mechanism in src/render.js / src/options.js proven end to end).
//
// Environment contract:
// (a) The server under test must already be running (the suite starts it pinned at
//     TEST_BASE_URL, default http://127.0.0.1:3000); before() asserts /healthz answers 200.
// (b) The full-suite classification runs execute the whole suite with
//     RATE_LIMIT_BURST=300 ALLOW_PRIVATE_NETWORK=1 PUBLIC_URL=http://127.0.0.1:3000 so every
//     file sees the same stable rate budget. This file inherits them from the environment and
//     sends no URL input, so it never leaves the machine.
// (c) Tests only ever talk to the local disposable test Postgres, never production. The
//     documented disposable DSN for this round is
//     postgresql://pdfmint:pdfmint@127.0.0.1:55436/pdfmint_test (supplied via DATABASE_URL).
//     This file issues no direct SQL of its own; accounts are throwaway (@pdfmint.test) and
//     the API key stays inside this process.
// (d) PDF inspection is done with the preinstalled CLI tools pdftotext, pdftoppm, pdfinfo
//     (execFileSync), never with the service's own code.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { req, newAccount, isPdf, countPagesIndependently } = require('./helpers');

// ISO A4 in PostScript points (the register's 1 pt bound is measured against these).
const A4_PORTRAIT = { width: 595.276, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.276 };
const DIMENSION_TOLERANCE_PT = 1.0;

// Raster analysis constants: grayscale PGM at 60 dpi, a pixel is ink below 160.
const RASTER_DPI = 60;
const INK_THRESHOLD = 160;

// A single blank row inside a band is tolerated; two or more consecutive blank rows split it.
const BAND_SPLIT_BLANK_ROWS = 2;
// The top band must start within the top 15 % and the bottom band end within the bottom 15 %.
const EDGE_FRACTION = 0.15;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c2-text-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c2-dims-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    // -f/-l make pdfinfo print one "Page N size:" line per page; the upper bound is clamped
    // to the document's page count, so this reports every page without knowing it up front.
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

/** Parses a binary P5 PGM: header tokens then one byte per pixel. */
function parsePgm(buf) {
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'P5', 'the raster must be a binary PGM');
  let i = 2;
  const tokens = [];
  while (tokens.length < 3) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
    if (buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i += 1;
      continue;
    }
    const start = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i += 1;
    tokens.push(Number(buf.subarray(start, i).toString('latin1')));
  }
  i += 1; // exactly one whitespace byte separates the maxval token from the pixel data
  const [width, height, maxval] = tokens;
  return { width, height, maxval, pixels: buf.subarray(i, i + width * height) };
}

/**
 * Rasterizes one page and returns its ink bands as {start, end} row indexes. A row is ink
 * when any pixel is below INK_THRESHOLD; bands are split by BAND_SPLIT_BLANK_ROWS consecutive
 * blank rows (a single blank row stays inside the band).
 */
function rasterBands(buffer, page, dpi = RASTER_DPI) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-c2-raster-'));
  const file = path.join(dir, 'document.pdf');
  try {
    fs.writeFileSync(file, buffer);
    const prefix = path.join(dir, 'page');
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-f', String(page), '-l', String(page), file, prefix]);
    const pgms = fs.readdirSync(dir).filter((name) => name.endsWith('.pgm')).sort();
    assert.equal(pgms.length, 1, `pdftoppm must produce exactly one PGM for page ${page}`);
    const { width, height, pixels } = parsePgm(fs.readFileSync(path.join(dir, pgms[0])));

    const bands = [];
    let current = null;
    let blankRun = 0;
    for (let y = 0; y < height; y += 1) {
      let ink = false;
      for (let x = 0; x < width; x += 1) {
        if (pixels[y * width + x] < INK_THRESHOLD) { ink = true; break; }
      }
      if (ink) {
        blankRun = 0;
        if (current) current.end = y;
        else current = { start: y, end: y };
      } else if (current) {
        blankRun += 1;
        if (blankRun >= BAND_SPLIT_BLANK_ROWS) {
          bands.push(current);
          current = null;
          blankRun = 0;
        }
      }
    }
    if (current) bands.push(current);
    return bands;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** h is the raster page height in pixels (the same geometry pdftoppm rasterized). */
function assertNoOverlap(bands, h) {
  assert.ok(bands.length >= 3, `expected at least 3 ink bands, got ${bands.length}`);
  for (let i = 0; i + 1 < bands.length; i += 1) {
    assert.ok(
      bands[i + 1].start - bands[i].end >= BAND_SPLIT_BLANK_ROWS,
      `ink bands ${i} and ${i + 1} must be separated by at least ${BAND_SPLIT_BLANK_ROWS} blank rows`,
    );
  }
  assert.ok(bands[0].start <= EDGE_FRACTION * h, 'the top ink band must lie inside the top 15 % of the page');
  assert.ok(
    bands[bands.length - 1].end >= (1 - EDGE_FRACTION) * h,
    'the bottom ink band must lie inside the bottom 15 % of the page',
  );
}

/** Raster height in pixels for a page rendered at dpi from its MediaBox height in points. */
function rasterHeight(ptHeight, dpi = RASTER_DPI) {
  return Math.round((ptHeight / 72) * dpi);
}

function assertDimensions(dims, expected, pageCount, label) {
  assert.equal(dims.length, pageCount, `${label}: pdfinfo must report every page's size`);
  dims.forEach((dim, index) => {
    assert.ok(
      Math.abs(dim.width - expected.width) <= DIMENSION_TOLERANCE_PT
        && Math.abs(dim.height - expected.height) <= DIMENSION_TOLERANCE_PT,
      `${label}: page ${index + 1} is ${dim.width} x ${dim.height} pt, expected ${expected.width} x ${expected.height} pt within ${DIMENSION_TOLERANCE_PT} pt`,
    );
  });
}

const PAGE_BREAK_STYLE = 'break-after: page; page-break-after: page;';
const FILLER = [
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt',
  'ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco',
  'laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in',
  'voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat',
  'cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum',
].join(' ');

/** Three page-broken sections, each carrying its unique page-local marker and a 60+ word body. */
function bodyHtml(tag) {
  const sections = [1, 2, 3].map((page) => {
    const marker = `${tag}-page-${page}`;
    const style = page < 3 ? ` style="${PAGE_BREAK_STYLE}"` : '';
    return `<section${style}><p>${marker}</p><p>${FILLER}</p></section>`;
  });
  return `<!doctype html><html><body>${sections.join('')}</body></html>`;
}

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the server under test must be running');
});

describe('C2 document quality', () => {
  test('T-C2a renders a three-page portrait A4 document with header and page-number footer', async () => {
    const { key } = await newAccount();
    const tag = randomMarker('c2a');
    const headerMarker = `${tag}-HEADER`;
    const pageMarkers = [1, 2, 3].map((page) => `${tag}-page-${page}`);

    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: {
        html: bodyHtml(tag),
        options: {
          format: 'A4',
          headerHtml: `<div style="font-size:9pt">${headerMarker}</div>`,
          pageNumbers: true,
        },
      },
    });

    assertPdfResponse({ res, buffer }, 3);

    const dims = pageDims(buffer);
    assertDimensions(dims, A4_PORTRAIT, 3, 'portrait A4');

    withPageText(buffer, 3, (pages) => {
      pages.forEach((text, index) => {
        assert.ok(text.includes(headerMarker), `the header marker must be on page ${index + 1}`);
      });
      pageMarkers.forEach((marker, index) => {
        assert.ok(pages[index].includes(marker), `marker ${index + 1} must be on page ${index + 1}`);
        for (let page = 0; page < pages.length; page += 1) {
          if (page !== index) assert.ok(!pages[page].includes(marker), `marker ${index + 1} must not be on page ${page + 1}`);
        }
      });
      assert.ok(pages[0].includes('Page 1 of 3'), 'page 1 must carry "Page 1 of 3"');
      assert.ok(pages[1].includes('Page 2 of 3'), 'page 2 must carry "Page 2 of 3"');
      assert.ok(pages[2].includes('Page 3 of 3'), 'page 3 must carry "Page 3 of 3"');
    });

    const h = rasterHeight(dims[0].height);
    assertNoOverlap(rasterBands(buffer, 1), h);
    assertNoOverlap(rasterBands(buffer, 3), h);
  });

  test('T-C2b renders a three-page landscape A4 document with custom header and footer', async () => {
    const { key } = await newAccount();
    const tag = randomMarker('c2b');
    const headerMarker = `${tag}-HEADER`;
    const footerMarker = `${tag}-FOOTER`;
    const pageMarkers = [1, 2, 3].map((page) => `${tag}-page-${page}`);

    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: {
        html: bodyHtml(tag),
        options: {
          format: 'A4',
          landscape: true,
          headerHtml: headerMarker,
          footerHtml: `<div style="font-size:9pt">${footerMarker}</div>`,
        },
      },
    });

    assertPdfResponse({ res, buffer }, 3);

    const dims = pageDims(buffer);
    assertDimensions(dims, A4_LANDSCAPE, 3, 'landscape A4');

    withPageText(buffer, 3, (pages) => {
      pages.forEach((text, index) => {
        assert.ok(text.includes(headerMarker), `the header marker must be on page ${index + 1}`);
        assert.ok(text.includes(footerMarker), `the footer marker must be on page ${index + 1}`);
      });
      pageMarkers.forEach((marker, index) => {
        assert.ok(pages[index].includes(marker), `marker ${index + 1} must be on page ${index + 1}`);
        for (let page = 0; page < pages.length; page += 1) {
          if (page !== index) assert.ok(!pages[page].includes(marker), `marker ${index + 1} must not be on page ${page + 1}`);
        }
      });
    });

    assertNoOverlap(rasterBands(buffer, 1), rasterHeight(dims[0].height));
  });

  test('T-C2c keeps a tall two-line header clear of the body on A4 portrait', async () => {
    const { key } = await newAccount();
    const tag = randomMarker('c2c');
    const headerMarker = `${tag}-HEADER`;
    const pageMarkers = [1, 2, 3].map((page) => `${tag}-page-${page}`);

    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: {
        html: bodyHtml(tag),
        options: {
          format: 'A4',
          headerHtml: `<div style="font-size:18pt">${headerMarker}</div><div style="font-size:18pt">Second header line</div>`,
          pageNumbers: true,
        },
      },
    });

    assertPdfResponse({ res, buffer }, 3);

    const dims = pageDims(buffer);
    assertDimensions(dims, A4_PORTRAIT, 3, 'portrait A4');

    withPageText(buffer, 3, (pages) => {
      pages.forEach((text, index) => {
        assert.ok(text.includes(headerMarker), `the header marker must be on page ${index + 1}`);
      });
      pageMarkers.forEach((marker, index) => {
        assert.ok(pages[index].includes(marker), `marker ${index + 1} must be on page ${index + 1}`);
        for (let page = 0; page < pages.length; page += 1) {
          if (page !== index) assert.ok(!pages[page].includes(marker), `marker ${index + 1} must not be on page ${page + 1}`);
        }
      });
      assert.ok(pages[0].includes('Page 1 of 3'), 'page 1 must carry "Page 1 of 3"');
    });

    assertNoOverlap(rasterBands(buffer, 1), rasterHeight(dims[0].height));
  });
});
