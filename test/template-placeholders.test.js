'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fillTemplate, templatePlaceholders, templateUsageData } = require('../src/api');

/**
 * The placeholder list exists so a client — the n8n node, the Zapier app, the
 * Make module — can draw one input field per marker. Until this test existed,
 * every marker inside a {{#items}} repeat block was missing from that list,
 * because the scan ran the template against empty data and an absent section
 * renders to nothing. An invoice is the common case and the line-item columns
 * are exactly what nobody can retype from memory.
 *
 * No database and no browser: these are pure string functions.
 */

const INVOICE = `
  <h1>Invoice {{invoice_number}}</h1>
  <table>{{#items}}<tr><td>{{description}}</td><td>{{qty}}</td><td>{{amount}}</td></tr>{{/items}}</table>
  {{^items}}<p>Nothing to bill.</p>{{/items}}
  <p>Total {{grand_total}}</p>`;

const names = (list) => list.map((p) => p.name).sort();

test('markers inside a repeat block are reported, with the block as their scope', () => {
  const found = templatePlaceholders(INVOICE, {});
  assert.deepEqual(names(found), ['amount', 'description', 'grand_total', 'invoice_number', 'items', 'qty']);
  const desc = found.find((p) => p.name === 'description');
  assert.equal(desc.scope, 'items', 'a row field carries the block it belongs to');
  assert.equal(desc.kind, 'scalar');
  assert.equal(found.find((p) => p.name === 'invoice_number').scope, undefined, 'a top-level field has no scope');
  // {{#items}} and {{^items}} are the same field asked about twice, so it is
  // listed once, as the section — a client draws one input for it, not two.
  assert.equal(found.filter((p) => p.name === 'items').length, 1);
  assert.equal(found.find((p) => p.name === 'items').kind, 'section');
});

test('the usage example is an array of rows, not the string a section cannot take', () => {
  const usage = templateUsageData(templatePlaceholders(INVOICE, {}));
  assert.deepEqual(usage.items, [{ description: 'value', qty: 'value', amount: 'value' }]);
  assert.equal(usage.invoice_number, 'value');
  assert.equal(usage.grand_total, 'value');
});

test('two blocks may reuse a field name and stay distinct', () => {
  const tpl = '{{#items}}{{amount}}{{/items}}{{#fees}}{{amount}}{{/fees}}';
  const found = templatePlaceholders(tpl, {});
  const amounts = found.filter((p) => p.name === 'amount').map((p) => p.scope).sort();
  assert.deepEqual(amounts, ['fees', 'items']);
  assert.deepEqual(templateUsageData(found), { items: [{ amount: 'value' }], fees: [{ amount: 'value' }] });
});

test('a header or footer stored with the template is scanned too', () => {
  const found = templatePlaceholders('<p>{{body_field}}</p>', {
    footerHtml: '<span>{{invoice_number}}</span>',
    watermark: 'DRAFT {{stage}}',
  });
  assert.deepEqual(names(found), ['body_field', 'invoice_number', 'stage']);
});

test('rendering is unchanged: an absent section still prints nothing', () => {
  // The scan walks into empty blocks; a render must not. If this ever flips,
  // every template with a missing key starts printing its raw row markup.
  const r = fillTemplate(INVOICE, {});
  assert.ok(!r.html.includes('{{'), 'no raw markers survive');
  assert.ok(!r.html.includes('<tr>'), 'the row markup of an absent block is not emitted');
  assert.ok(r.html.includes('Nothing to bill.'), 'the inverted block still prints');
  assert.ok(r.unresolved.includes('items'), 'an absent section is still reported as unresolved');
});

test('a filled section reports its row fields with scope as well', () => {
  const r = fillTemplate(INVOICE, { invoice_number: '1', items: [{ description: 'a', qty: '1', amount: '2' }], grand_total: '2' });
  assert.ok(r.html.includes('<td>a</td>'));
  assert.equal(r.placeholders.find((p) => p.name === 'description').scope, 'items');
  assert.deepEqual(r.unresolved, [], 'nothing is missing when every field is supplied');
});

test('scanning does not leak row markers into strict mode', () => {
  // scanPlaceholders (strict mode) calls fillTemplate WITHOUT scanSections, so
  // an unfilled block must not add its inner names to unresolved.
  const r = fillTemplate(INVOICE, { invoice_number: '1', grand_total: '2' });
  assert.deepEqual(r.unresolved, ['items'], 'only the block itself, not description/qty/amount');
});
