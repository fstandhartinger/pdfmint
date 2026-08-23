'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { execFileSync } = require('node:child_process');
const os = require('node:os');

const { req, newAccount } = require('./helpers');
const { config, PLANS } = require('../src/config');
const { REFILL_PER_MINUTE, CAPACITY } = require('../src/ratelimit');
const { DEFAULT_MARGIN, FORMATS, MIN_HF_MARGIN_MM } = require('../src/options');
const { markdownToHtml } = require('../src/markdown');

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
    ['header/footer margin floor', `${MIN_HF_MARGIN_MM} mm`, '15 mm'],
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


/* -------------------------------------------------------------------------
 * The page-break claims. Each of these was wrong on a shipped page once: the
 * docs promised behaviour Chromium does not have, or a recipe that printed a
 * grand total three times. Each test renders the thing the page claims and
 * reads the resulting PDF back.
 * ---------------------------------------------------------------------- */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-claims-'));
const textOf = (buffer, args = []) => {
  const dir = tmp();
  const file = path.join(dir, 'x.pdf');
  fs.writeFileSync(file, buffer);
  try { return execFileSync('pdftotext', [...args, file, '-']).toString(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const words = (xml) => [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
  .map((m) => ({ xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: m[5] }));

/** A table of `rows` body rows whose <thead> is exactly `headerPx` tall. */
const tallHeaderTable = (headerPx) => {
  const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>row ${i + 1} lorem ipsum dolor sit amet</td></tr>`).join('');
  return `<style>body{font:12px sans-serif;margin:0}table{width:100%;border-collapse:collapse}`
    + `th,td{border:0;padding:0}thead{display:table-header-group}tr{break-inside:avoid}`
    + `th{height:${headerPx}px;vertical-align:top}td{height:14px}</style>`
    + `<table><thead><tr><th>HDRMARKER</th></tr></thead><tbody>${rows}</tbody></table>`;
};

describe('the page-break behaviour the docs promise', () => {
  test('a <thead> up to a quarter of the text area repeats; a taller one does not, and the docs say so', async () => {
    const { key } = await newAccount();
    // A4 minus the default 12 mm margins is 273 mm of text area = 1031.8 px.
    // Chromium repeats a header only up to a quarter of that: 258 px.
    const render = async (headerPx) => {
      const { buffer } = await req('/v1/pdf', {
        method: 'POST', key, raw: true,
        body: { html: tallHeaderTable(headerPx), options: { format: 'A4', margin: '12mm' } },
      });
      return (textOf(buffer).match(/HDRMARKER/g) || []).length;
    };

    assert.ok(await render(250) > 1, 'a header under a quarter of the text area must repeat');
    assert.equal(await render(270), 1, 'a header over a quarter of the text area is drawn once — if this changed, the docs must change too');

    assert.ok(docs.includes("quarter of the page's text area"), 'the docs must state the quarter-page ceiling');
    assert.ok(docs.includes('258 px'), 'the docs must state the measured A4 ceiling of 258 px');
    assert.ok(/first page only/.test(docs), 'the docs must say what happens above the ceiling');
  });

  test('a table row that does not fit moves to the next page whole', async () => {
    const { key } = await newAccount();
    const html = '<style>body{margin:0;font:12px sans-serif}table{width:100%;border-collapse:collapse}'
      + 'td{border:1px solid #ccc;vertical-align:top}tr{break-inside:avoid}</style>'
      + '<div style="height:180mm">filler</div><table><tbody><tr>'
      + '<td style="height:150mm;position:relative">ROWTOP<span style="position:absolute;bottom:0">ROWBOT</span></td>'
      + '</tr></tbody></table>';
    const { buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html, options: { format: 'A4', margin: '12mm' } } });
    const pages = textOf(buffer).split('\f');
    const top = pages.findIndex((p) => p.includes('ROWTOP'));
    const bottom = pages.findIndex((p) => p.includes('ROWBOT'));
    assert.ok(top > 0, 'the row must have moved off page 1');
    assert.equal(top, bottom, 'a row that fits on a page must not be split across the break');
  });

  test("the docs' invoice recipe prints its grand total exactly once", async () => {
    const { key } = await newAccount();
    const m = docs.match(/<div class="cap">invoice\.json<\/div>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(m, 'the invoice recipe must still be on the docs page');
    const body = JSON.parse(m[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&middot;/g, '.').replace(/&euro;/g, '€').replace(/&nbsp;/g, ' '));

    // Long enough to run to several pages, with arithmetic that adds up.
    const fmt = (n) => '€' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let sum = 0;
    body.data.lines = Array.from({ length: 60 }, (_, i) => {
      const qty = (i % 7) + 1;
      const unit = 26 + i;
      sum += qty * unit;
      return { desc: `Line item ${i + 1} — consulting work`, qty, unit: fmt(unit), amount: fmt(qty * unit) };
    });
    body.data.total = fmt(sum);

    const { res, buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body });
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('x-pdfmint-pages')) >= 3, 'the fixture must be several pages long');

    const text = textOf(buffer, ['-layout']);
    assert.equal((text.match(/Total/g) || []).length, 1,
      'a repeated <tfoot> prints the grand total on every page — the recipe needs tfoot { display: table-row-group }');
    assert.equal(text.split(body.data.total).length - 1, 1, `the figure ${body.data.total} must appear exactly once`);
    assert.ok(docs.includes('table-row-group'), 'the recipe must carry the rule that makes this true');
  });
});

describe('a header is measured before it is printed', () => {
  const letterhead = '<div style="display:flex;justify-content:space-between;align-items:flex-start;width:100%;'
    + 'border-bottom:1px solid #12a37a;padding-bottom:6px">'
    + '<div style="width:46px;height:46px;background:#12a37a;border-radius:6px"></div>'
    + '<div style="text-align:right;font-size:8pt;line-height:1.4">Acme GmbH<br>Musterstrasse 1, 10115 Berlin'
    + '<br>VAT DE123456789<br>hello@acme.example</div></div>';

  test('a letterhead taller than the 15 mm floor does not print over the body', async () => {
    const { key } = await newAccount();
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: {
        html: '<style>body{margin:0;font:13px sans-serif}h1{margin:0;font-size:26px}</style><h1>BODYHEADLINE</h1><p>Body.</p>',
        options: { format: 'A4', headerHtml: letterhead },
      },
    });
    assert.equal(res.status, 200);
    const w = words(textOf(buffer, ['-bbox']));
    const headerBottom = Math.max(...w.filter((x) => /DE123456789|acme\.example|Musterstrasse/.test(x.text)).map((x) => x.yMax));
    const bodyTop = Math.min(...w.filter((x) => x.text === 'BODYHEADLINE').map((x) => x.yMin));
    assert.ok(Number.isFinite(headerBottom) && Number.isFinite(bodyTop), 'both the header and the body must be on the page');
    assert.ok(headerBottom < bodyTop,
      `the header ends at ${headerBottom.toFixed(1)}pt but the body starts at ${bodyTop.toFixed(1)}pt — the header is printing over the body`);
  });

  test('a header wanting more than a third of the page is capped and the caller is told', async () => {
    const { key } = await newAccount();
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>body</p>', output: 'base64', options: { headerHtml: '<div style="height:200mm">TALL</div>' } },
    });
    assert.equal(res.status, 200);
    assert.ok(json.warnings && json.warnings.some((x) => /third of the page/.test(x)),
      `a header over the cap must warn; got ${JSON.stringify(json.warnings)}`);
    assert.ok(docs.includes('a third of the page'), 'the docs must state the cap the code enforces');
  });
});

describe('the Markdown claims', () => {
  test('GFM column alignment survives the built-in stylesheet', async () => {
    const { key } = await newAccount();
    const table = (dashes) => `# T\n\n| Item | Amount |\n|---|${dashes}|\n| Design retainer | 2400.00 |\n`;
    const render = async (dashes) => {
      const { buffer } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { markdown: table(dashes), options: { format: 'A4', margin: '20mm' } } });
      const cell = words(textOf(buffer, ['-bbox'])).find((x) => x.text === '2400.00');
      assert.ok(cell, 'the money cell must be extractable');
      return cell;
    };
    const left = await render('---');
    const right = await render('---:');
    assert.ok(right.xMin > left.xMin + 20,
      `|---:| must right-align the column: left-aligned starts at ${left.xMin.toFixed(1)}pt, right-aligned at ${right.xMin.toFixed(1)}pt`);
    assert.ok(docs.includes('Column alignment is honoured'), 'the docs must claim what the stylesheet now does');
  });

  test('footnotes are not supported, and the docs do not pretend otherwise', () => {
    const html = markdownToHtml('Text with a note[^1].\n\n[^1]: The note.\n');
    assert.ok(html.includes('[^1]'), 'footnote syntax reaches the page as literal text');
    assert.ok(!/<sup|footnote/i.test(html), 'nothing turns it into a real footnote');
    assert.ok(/footnotes \(<code>\[\^1\]<\/code>\)/.test(docs), 'the docs must name footnotes as unsupported');
    assert.ok(/not<\/strong> implemented/.test(docs), 'the docs must say plainly that these are not implemented');
  });
});
