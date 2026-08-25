'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { req, newAccount, isPdf } = require('./helpers');
const { STRICT } = require('../src/api');
const { PAINT_SCAN_BUDGET } = require('../src/render');

/**
 * Strict mode is the thing we are selling: Zapier and Make users get a green
 * tick and a blank file, and nobody finds out until the customer does. Every
 * test here goes through the real HTTP API, a real Chromium and a real
 * database, because the only claim worth making is about what the service does.
 *
 * The false-positive tests matter more than the true-positive ones. Refusing a
 * document somebody meant to print would be a worse product than the bug.
 */

const docs = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'), 'utf8')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

let key;

before(async () => {
  const health = await req('/healthz');
  assert.equal(health.res.status, 200, 'the server under test must be running');
  ({ key } = await newAccount());
});

const creditsUsed = async () => (await req('/v1/me', { key })).json.credits_used;

/** Reads the words back off the paper, with a tool that is not ours. */
function pdfText(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmint-strict-'));
  const file = path.join(dir, 'x.pdf');
  fs.writeFileSync(file, buffer);
  try { return execFileSync('pdftotext', [file, '-']).toString(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A 1x1 PNG, as a data URI — a real image with real bytes behind it. */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A syntactically valid PDF that contains no pages, written by hand rather than
 * by our own merge code. pdf-lib will not produce one, and it is the input that
 * merges cleanly while contributing nothing.
 */
function zeroPagePdf() {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [ ] /Count 0 >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 3\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

describe('strict mode refuses a document that would be wrong', () => {
  test('an unresolved placeholder is refused before anything is rendered', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>Invoice for {{client_name}}</h1><p>Total {{total}}</p>', data: { total: '9.00' }, strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unresolved_placeholders');
    assert.deepEqual(json.error.details.unresolved, ['client_name']);
    assert.match(json.error.message, /client_name/, 'the error must name the placeholder, not just count it');
    assert.match(json.error.docs, /#strict$/);
    assert.ok(json.error.hint, 'every strict rejection carries a hint');
  });

  test('a placeholder with no "data" field at all is refused, not printed onto the paper', async () => {
    // The regression this whole feature exists for. Until this was fixed the
    // scan only ran when "data" was present, so the request below came back 200
    // with "Hi {{client_name}}" printed on the page — with strict on.
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>Hi {{client_name}}</h1>', strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unresolved_placeholders');
    assert.deepEqual(json.error.details.unresolved, ['client_name']);
    assert.equal(json.error.details.data_supplied, false,
      'the caller must be able to tell "no data sent" from "value missing"');
    assert.match(json.error.message, /no "data"/);
  });

  test('the same, on markdown and on a saved template', async () => {
    const md = await req('/v1/pdf', { method: 'POST', key, body: { markdown: '# Hi {{client_name}}', strict: true } });
    assert.equal(md.res.status, 400);
    assert.equal(md.json.error.code, 'unresolved_placeholders');

    const name = `strict-${Date.now()}`;
    const put = await req(`/v1/templates/${name}`, { method: 'PUT', key, body: { html: '<h1>{{client_name}}</h1>' } });
    assert.equal(put.res.status, 200);
    const tpl = await req('/v1/pdf', { method: 'POST', key, body: { template: name, strict: true } });
    assert.equal(tpl.res.status, 400);
    assert.equal(tpl.json.error.code, 'unresolved_placeholders');
    await req(`/v1/templates/${name}`, { method: 'DELETE', key });
  });

  test('a document with no placeholders and no "data" is untouched', async () => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>Ordinary document</h1><p>Nothing templated here.</p>', strict: true },
    });
    assert.equal(res.status, 200, 'the common case must not pay for the scan');
    assert.ok(isPdf(buffer));
    assert.equal(res.headers.get('x-pdfmint-warning'), null);
  });

  test('a document that renders with nothing on it is refused', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<div class="invoice"><span></span></div>', strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'blank_document');
    assert.deepEqual(json.error.details, { visible_text_chars: 0, images: 0, painted_elements: 0 });
    assert.match(json.error.hint, /strict/, 'the hint must say how to get the document anyway');
  });

  test('a template whose data goes missing renders blank, and strict catches that too', async () => {
    // The placeholder check and the blank check are different mechanisms: this
    // one resolves cleanly and still produces an empty page.
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>{{title}}</h1>', data: { title: '' }, strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'blank_document');
  });

  test('a page numbers footer does not make an empty body acceptable', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<div></div>', strict: true, options: { pageNumbers: true } },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'blank_document');
    assert.equal(json.error.details.header_or_footer, true,
      'the caller must be able to tell this case apart from a wholly empty page');
  });

  test('a stylesheet printed as text is refused', async () => {
    const css = 'body { font-family: Helvetica, Arial, sans-serif; margin: 0; padding: 0; } '
      + '.invoice-header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; } '
      + 'table.lines { width: 100%; border-collapse: collapse; margin-top: 24px; } '
      + 'table.lines th { text-align: left; background: #f4f4f4; padding: 8px; } '
      + 'table.lines td { padding: 8px; border-bottom: 1px solid #ddd; }';
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: css, strict: true } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unrendered_markup');
    assert.ok(json.error.details.markup_ratio >= STRICT.markupMinRatio);
    assert.ok(json.error.details.css_declarations >= STRICT.markupMinDeclarations);
  });

  test('HTML that arrived escaped, and printed its own tags, is refused', async () => {
    // Exactly what a Zapier or Make step does when it formats a field on the way in.
    const escaped = '&lt;html&gt;&lt;head&gt;&lt;style&gt;body{font-family:sans-serif}&lt;/style&gt;&lt;/head&gt;&lt;body&gt;'
      + '&lt;h1&gt;Invoice 2024-018&lt;/h1&gt;&lt;table&gt;&lt;tr&gt;&lt;td&gt;Consulting&lt;/td&gt;&lt;td&gt;1200.00&lt;/td&gt;&lt;/tr&gt;'
      + '&lt;tr&gt;&lt;td&gt;Expenses&lt;/td&gt;&lt;td&gt;84.20&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;/body&gt;&lt;/html&gt;';
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: escaped, strict: true } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unrendered_markup');
    assert.ok(json.error.details.literal_tags >= STRICT.tagMinCount);
    assert.match(json.error.message, /literal text/);
  });
});

describe('a header, a footer and a watermark are content too', () => {
  test('placeholders in headerHtml are filled from the same data', async () => {
    // They went to the renderer raw, so "Invoice {{invoice_number}}" printed on
    // every page with strict on and the data right there in the request.
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, output: 'base64',
      body: {
        html: '<p>Body text.</p>', data: { invoice_number: '2024-018', customer: 'Acme' },
        strict: true, output: 'base64',
        options: { headerHtml: '<div>Invoice {{invoice_number}} for {{customer}}</div>' },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(json && json.error));
    const text = pdfText(Buffer.from(json.base64, 'base64'));
    assert.match(text, /Invoice 2024-018 for Acme/);
    assert.ok(!/\{\{/.test(text), 'no marker may survive onto the paper');
  });

  test('a placeholder the header uses and the data lacks is refused', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: {
        html: '<p>Body.</p>', data: { customer: 'Acme' }, strict: true,
        options: { headerHtml: '<div>Invoice {{invoice_number}}</div>' },
      },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unresolved_placeholders');
    assert.deepEqual(json.error.details.unresolved, ['invoice_number']);
  });

  test('the same for a footer and for a watermark', async () => {
    const footer = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>Body.</p>', data: {}, strict: true, options: { footerHtml: '<div>{{tenant}}</div>' } },
    });
    assert.equal(footer.res.status, 400);
    assert.deepEqual(footer.json.error.details.unresolved, ['tenant']);

    const wm = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>Body.</p>', data: {}, strict: true, watermark: { text: 'DRAFT {{stage}}' } },
    });
    assert.equal(wm.res.status, 400);
    assert.deepEqual(wm.json.error.details.unresolved, ['stage']);
  });

  test('a watermark value is stamped raw, not HTML-escaped', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>Body.</p>', data: { co: 'Smith & Sons' }, output: 'base64', watermark: { text: '{{co}}' } },
    });
    assert.equal(res.status, 200);
    // The watermark prints at 45 degrees, so assert on the glyph set: an escaped
    // value would put "a m p ;" on the page instead of "&".
    const letters = pdfText(Buffer.from(json.base64, 'base64')).replace(/[^A-Za-z&;]/g, '');
    assert.ok(letters.includes('&'), 'the ampersand must reach the page');
    assert.ok(!/amp;/.test(letters), `the value must not be HTML-escaped, got ${JSON.stringify(letters)}`);
  });

  test("a template's own stored header is filled as well", async () => {
    const name = `hdr-${Date.now()}`;
    await req(`/v1/templates/${name}`, {
      method: 'PUT', key,
      body: { html: '<p>{{body_text}}</p>', options: { headerHtml: '<div>{{invoice_number}}</div>' } },
    });
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, body: { template: name, data: { body_text: 'x' }, strict: true },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(json.error.details.unresolved, ['invoice_number']);
    await req(`/v1/templates/${name}`, { method: 'DELETE', key });
  });
});

describe('a section whose key is absent is a missing table, not an empty one', () => {
  const table = '<table>{{#items}}<tr><td>{{name}}</td></tr>{{/items}}</table><p>{{customer}}</p>';

  test('a key that is not in the data at all is reported', async () => {
    // The most likely shape of the real failure: the trigger returned no line
    // items, the section vanished, and the invoice went out with none.
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, body: { html: table, data: { customer: 'Acme' }, strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'unresolved_placeholders');
    assert.deepEqual(json.error.details.unresolved, ['items']);
  });

  test('a key that is present and holds an empty list is a real document', async () => {
    const { res } = await req('/v1/pdf', {
      method: 'POST', key, body: { html: table, data: { customer: 'Acme', items: [] }, strict: true, output: 'base64' },
    });
    assert.equal(res.status, 200, 'an invoice with no extras is not a mistake');
  });

  test('a section that is present and populated is untouched', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: table, data: { customer: 'Acme', items: [{ name: 'Widget' }] }, strict: true, output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.match(pdfText(Buffer.from(json.base64, 'base64')), /Widget/);
  });

  test('an inverted section is not reported, because handling absence is what it is for', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<p>{{^extras}}No extras{{/extras}}</p><p>{{customer}}</p>', data: { customer: 'Acme' }, strict: true, output: 'base64' },
    });
    assert.equal(res.status, 200, 'flagging this would make {{^x}} unusable under strict');
    assert.match(pdfText(Buffer.from(json.base64, 'base64')), /No extras/);
  });
});

describe('a value that cannot be printed is never printed', () => {
  test('an object is refused rather than stamped as [object Object]', async () => {
    // Zapier and Make hand back nested objects from most triggers.
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, body: { html: '<h1>Hello {{customer}}</h1>', data: { customer: { name: 'Ada' } }, strict: true },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_placeholder_value');
    assert.deepEqual(json.error.details.unprintable, [{ name: 'customer', type: 'object' }]);
    assert.match(json.error.hint, /\{\{customer\.name\}\}/, 'the hint must show the path that would work');
  });

  test('without strict it warns, and the warning survives the response header', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, body: { html: '<h1>Hello {{customer}}</h1>', data: { customer: { name: 'Ada' } }, output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.ok(json.warnings.some((w) => /object Object/.test(w)), JSON.stringify(json.warnings));

    // A warning carrying an em dash used to answer 500: Node refuses a header
    // byte above U+00FF. Advice must never be what fails the call.
    const binary = await req('/v1/pdf', {
      method: 'POST', key, raw: true, body: { html: '<h1>Hello {{customer}}</h1>', data: { customer: { name: 'Ada' } } },
    });
    assert.equal(binary.res.status, 200);
    assert.match(binary.res.headers.get('x-pdfmint-warning') || '', /object Object/);
  });

  test('an array of scalars still prints, because that is what the caller meant', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key, body: { html: '<h1>{{tags}}</h1>', data: { tags: ['red', 'blue'] }, strict: true, output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.match(pdfText(Buffer.from(json.base64, 'base64')), /red,blue/);
  });
});

describe('all three spellings of "no data" behave the same', () => {
  for (const [name, data] of [['omitted', undefined], ['null', null], ['an empty object', {}]]) {
    test(`data ${name}: strict refuses and names the field`, async () => {
      const body = { html: '<h1>Hi {{client_name}}</h1>', strict: true };
      if (data !== undefined) body.data = data;
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body });
      assert.equal(res.status, 400, `data ${name} must not render a document saying {{client_name}}`);
      assert.equal(json.error.code, 'unresolved_placeholders');
      assert.deepEqual(json.error.details.unresolved, ['client_name']);
    });
  }
});

describe('strict mode leaves real documents alone', () => {
  test('an ordinary document is unaffected', async () => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: '<h1>Invoice 2024-018</h1><p>Consulting services, 1200.00 EUR.</p>', strict: true },
    });
    assert.equal(res.status, 200);
    assert.ok(isPdf(buffer));
    assert.equal(res.headers.get('x-pdfmint-warning'), null, 'a good document warns about nothing');
  });

  test('a document with only an image on it is not blank', async () => {
    const { res, buffer } = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      body: { html: `<img src="${PNG_1PX}" style="width:300px;height:200px">`, strict: true },
    });
    assert.equal(res.status, 200, 'a scan, a chart or a QR code is a real document');
    assert.ok(isPdf(buffer));
  });

  test('a document with only a canvas or an SVG on it is not blank', async () => {
    for (const [what, html] of [
      ['canvas', '<canvas width="400" height="300"></canvas>'],
      ['svg', '<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#000"/></svg>'],
      ['a painted block', '<div style="width:200px;height:200px;background:#c00"></div>'],
      ['generated content', '<style>p::before{content:"Paid in full"}</style><p></p>'],
    ]) {
      const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html, strict: true, output: 'base64' } });
      assert.equal(res.status, 200, `${what} must not be called blank (got ${JSON.stringify(json && json.error)})`);
    }
  });

  test('content that only exists in the print stylesheet is measured as printed, not as seen', async () => {
    const html = '<style>.p{display:none}@media print{.p{display:block}}</style>'
      + '<div class="p">This exists only on paper: invoice total 1200.00 EUR.</div>';
    const { res } = await req('/v1/pdf', { method: 'POST', key, body: { html, strict: true, output: 'base64' } });
    assert.equal(res.status, 200, 'the check runs after @media print is applied, so this is not blank');
  });

  test('a document whose content is a code sample is not mistaken for leaked markup', async () => {
    const html = '<h1>House stylesheet</h1><p>The whole sheet, for reference:</p><pre><code>'
      + 'body { margin: 0; padding: 0; font: 13px/1.5 sans-serif; }\n'
      + 'h1 { font-size: 26px; margin: 0 0 8px; }\n'
      + 'table { width: 100%; border-collapse: collapse; }\n'
      + 'th { text-align: left; padding: 6px 8px; background: #eee; }\n'
      + 'td { padding: 6px 8px; border-bottom: 1px solid #ddd; }\n'
      + '.total { font-weight: 700; text-align: right; }\n'
      + '.muted { color: #666; font-size: 11px; }</code></pre>';
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html, strict: true, output: 'base64' } });
    assert.equal(res.status, 200,
      `a printed stylesheet inside <pre> is a real document (got ${JSON.stringify(json && json.error)})`);
  });

  test('prose that merely mentions tag names is not leaked markup', async () => {
    const html = '<h1>Migration notes</h1><p>Replace the old &lt;center&gt; wrapper with a &lt;div&gt; and close it '
      + 'with &lt;/div&gt;. The &lt;font&gt; element is gone; use &lt;span&gt; with a class instead, and remember '
      + 'that &lt;br&gt; is void so it never needs a closing tag.</p><p>Everything else in the document is '
      + 'unchanged, so the only visible difference is the spacing around headings.</p>';
    const { res } = await req('/v1/pdf', { method: 'POST', key, body: { html, strict: true, output: 'base64' } });
    assert.equal(res.status, 200);
  });
});

describe('without strict, the same findings arrive as warnings', () => {
  test('an unresolved placeholder renders empty and says so', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>Hello {{client_name}}</h1><p>Body text.</p>', data: { other: 'x' }, output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.ok(json.warnings.some((w) => /client_name/.test(w)), `expected a placeholder warning, got ${JSON.stringify(json.warnings)}`);
  });

  test('a document that rendered empty comes back with a warning, not an error', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>{{name}}</h1>', data: { name: '' }, output: 'base64' },
    });
    assert.equal(res.status, 200, 'without strict the caller still gets the bytes they asked for');
    assert.ok(Buffer.from(json.base64, 'base64').subarray(0, 5).toString('latin1') === '%PDF-');
    assert.ok(json.warnings.some((w) => /no visible text/.test(w)),
      `the blank document must still be reported: ${JSON.stringify(json.warnings)}`);
    assert.ok(json.warnings.some((w) => /"strict": true/.test(w)), 'and must say how to make it fatal');
  });

  test('a placeholder with no "data" warns, and the bytes are left exactly as they were', async () => {
    const { res, json } = await req('/v1/pdf', {
      method: 'POST', key,
      body: { html: '<h1>Hi {{client_name}}</h1>', output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.ok(json.warnings.some((w) => /client_name/.test(w)), JSON.stringify(json.warnings));
    assert.ok(json.warnings.some((w) => /exactly as written/.test(w)),
      'the warning must say the marker was printed, not that it rendered empty');

    // Nothing is substituted when no data was sent: whoever prints {{…}} on
    // purpose keeps getting the document they always got.
    const text = pdfText(Buffer.from(json.base64, 'base64'));
    assert.match(text, /\{\{client_name\}\}/, 'the marker must still be on the page');
  });

  test('the warning also reaches a binary response, in the header', async () => {
    const { res } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<div></div>' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-pdfmint-warning') || '', /no visible text/);
  });
});

describe('a strict rejection is free', () => {
  test('the credit is refunded on /v1/pdf', async () => {
    const before = await creditsUsed();
    const { res } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<div></div>', strict: true } });
    assert.equal(res.status, 400);
    assert.equal(await creditsUsed(), before, 'a refused render must not be charged for');
  });

  test('the credit is refunded on /v1/image', async () => {
    const before = await creditsUsed();
    const { res, json } = await req('/v1/image', { method: 'POST', key, body: { html: '<div></div>', strict: true } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'blank_document');
    assert.equal(await creditsUsed(), before);
  });

  test('a document that does render is still charged for, so the refund is not a hole', async () => {
    const before = await creditsUsed();
    const { res } = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<h1>charged</h1>', strict: true } });
    assert.equal(res.status, 200);
    assert.equal(await creditsUsed(), before + 1);
  });
});

describe('strict means the same thing on every endpoint', () => {
  test('/v1/image takes "data" and fills placeholders, exactly as /v1/pdf does', async () => {
    // It used to take neither, so <h1>Hello {{first_name}}</h1> was screenshotted
    // as written: one vendor, two contracts on adjacent endpoints.
    const filled = await req('/v1/image', {
      method: 'POST', key,
      body: { html: '<h1>Hello {{first_name}}</h1>', data: { first_name: 'Ada' }, strict: true, output: 'base64' },
    });
    assert.equal(filled.res.status, 200, JSON.stringify(filled.json && filled.json.error));

    const missing = await req('/v1/image', {
      method: 'POST', key, body: { html: '<h1>Hello {{first_name}}</h1>', data: {}, strict: true },
    });
    assert.equal(missing.res.status, 400);
    assert.equal(missing.json.error.code, 'unresolved_placeholders');
    assert.deepEqual(missing.json.error.details.unresolved, ['first_name']);

    const noData = await req('/v1/image', {
      method: 'POST', key, body: { html: '<h1>Hi {{client_name}}</h1>', strict: true },
    });
    assert.equal(noData.res.status, 400);
    assert.equal(noData.json.error.details.data_supplied, false);
  });

  test('/v1/image refuses a blank screenshot and passes an image-only one', async () => {
    const blank = await req('/v1/image', { method: 'POST', key, body: { html: '<div></div>', strict: true } });
    assert.equal(blank.res.status, 400);
    assert.equal(blank.json.error.code, 'blank_document');
    assert.match(blank.json.error.docs, /#strict$/);

    const chart = await req('/v1/image', {
      method: 'POST', key, raw: true,
      body: { html: `<img src="${PNG_1PX}" style="width:300px;height:200px">`, strict: true },
    });
    assert.equal(chart.res.status, 200, 'an image-only page is a legitimate screenshot');
  });

  test('/v1/merge refuses an input that contributed no pages, and names it', async () => {
    const real = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>page one</h1>', output: 'base64' } });
    const files = [{ base64: real.json.base64 }, { base64: zeroPagePdf() }];

    const strict = await req('/v1/merge', { method: 'POST', key, body: { files, strict: true, output: 'base64' } });
    assert.equal(strict.res.status, 400);
    assert.equal(strict.json.error.code, 'blank_document');
    assert.equal(strict.json.error.details.input_index, 1);
    assert.deepEqual(strict.json.error.details.page_counts, [1, 0]);
    assert.match(strict.json.error.message, /files\[1\]/);

    const loose = await req('/v1/merge', { method: 'POST', key, body: { files, output: 'base64' } });
    assert.equal(loose.res.status, 200, 'without strict the merge still happens');
    assert.equal(loose.json.pages, 1);
    assert.ok(loose.json.warnings.some((w) => /files\[1\]/.test(w)));
  });

  test('/v1/merge is unaffected when every input has pages', async () => {
    const one = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>one</h1>', output: 'base64' } });
    const two = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>two</h1>', output: 'base64' } });
    const { res, json } = await req('/v1/merge', {
      method: 'POST', key,
      body: { files: [{ base64: one.json.base64 }, { base64: two.json.base64 }], strict: true, output: 'base64' },
    });
    assert.equal(res.status, 200);
    assert.equal(json.pages, 2);
    assert.equal(json.warnings, undefined);
  });

  test('strict works inside the "options" wrapper too, on every endpoint that takes one', async () => {
    // /v1/image and /v1/merge fold the wrapper into the body, so a flag that
    // only worked flat on /v1/pdf would quietly do nothing for half the callers.
    const pdf = await req('/v1/pdf', { method: 'POST', key, body: { html: '<div></div>', options: { strict: true } } });
    assert.equal(pdf.res.status, 400);
    assert.equal(pdf.json.error.code, 'blank_document');

    const image = await req('/v1/image', { method: 'POST', key, body: { html: '<div></div>', options: { strict: true } } });
    assert.equal(image.res.status, 400);
    assert.equal(image.json.error.code, 'blank_document');
  });

  test('"strict" is not an unknown field anywhere it is documented', async () => {
    for (const [path, body] of [
      ['/v1/pdf', { html: '<h1>x</h1>', strict: false }],
      ['/v1/image', { html: '<h1>x</h1>', strict: false }],
    ]) {
      const { res } = await req(path, { method: 'POST', key, raw: true, body });
      assert.equal(res.status, 200, `${path} must accept "strict"`);
    }
  });
});

describe('strict is read the way automation tools send it', () => {
  test('the strings "true" and "false" work, because n8n and Make send them', async () => {
    const on = await req('/v1/pdf', { method: 'POST', key, body: { html: '<div></div>', strict: 'true' } });
    assert.equal(on.res.status, 400);
    assert.equal(on.json.error.code, 'blank_document');

    const off = await req('/v1/pdf', { method: 'POST', key, raw: true, body: { html: '<div></div>', strict: 'false' } });
    assert.equal(off.res.status, 200);
  });

  test('anything that is not a boolean is refused outright', async () => {
    const { res, json } = await req('/v1/pdf', { method: 'POST', key, body: { html: '<h1>fine</h1>', strict: 'yes' } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_option');
    assert.match(json.error.message, /"strict"/,
      'a strict flag we did not understand must never be treated as off');
  });
});

describe('the strict documentation states what the code enforces', () => {
  const cases = [
    ['the leaked-stylesheet ratio', `${Math.round(STRICT.markupMinRatio * 100)}%`],
    ['the minimum text length', `${STRICT.markupMinChars} characters`],
    ['the minimum declaration count', `at least ${STRICT.markupMinDeclarations} CSS declarations`],
    ['the minimum tag count', `at least ${STRICT.tagMinCount} literal HTML tags`],
    ['the minimum closing-tag count', `at least ${STRICT.tagMinClosing} of them are closing tags`],
    ['the tag ratio', `${Math.round(STRICT.tagMinRatio * 100)}% or more`],
    ['the paint-scan budget', `${PAINT_SCAN_BUDGET} elements`],
  ];
  for (const [what, text] of cases) {
    test(`${what} on the docs page is the number in the code`, () => {
      assert.ok(docs.includes(text), `the docs page never states ${what} as "${text}"`);
    });
  }

  test('every strict error code the API can return is in the error table', () => {
    for (const code of ['unresolved_placeholders', 'blank_document', 'unrendered_markup']) {
      assert.ok(docs.includes(`<code>${code}</code></td><td>400</td>`), `${code} is missing from the errors table`);
    }
  });
});
