'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A worked invoice whose figures do not add up is the most credibility-
 * destroying mistake a PDF product can ship: a reader who checks the sum stops
 * believing every other number on the page. This walks every money example in
 * the published pages and re-does the arithmetic.
 */

const money = (s) => {
  const m = /-?[\d,.]+/.exec(String(s).replace(/[^\d.,-]/g, ''));
  if (!m) return null;
  // Our examples use 1,234.56 — thousands separator is a comma.
  return Number(m[0].replace(/,/g, ''));
};

/** Pulls every {"lines": [...], "total": ...} example out of a rendered page. */
function extractInvoiceExamples(html) {
  const decoded = html
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&middot;/g, '.')
    .replace(/&euro;/g, '€').replace(/&nbsp;/g, ' ');
  const examples = [];
  // Each example is a JSON object literal with a "lines" array in it.
  const re = /"lines"\s*:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(decoded))) {
    const rows = [];
    const rowRe = /\{[^{}]*\}/g;
    let r;
    while ((r = rowRe.exec(m[1]))) {
      const qty = /"qty"\s*:\s*"?([\d.,]+)"?/.exec(r[0]);
      const unit = /"unit"\s*:\s*"([^"]+)"/.exec(r[0]);
      const amount = /"amount"\s*:\s*"([^"]+)"/.exec(r[0]);
      if (qty && unit && amount) rows.push({ qty: money(qty[1]), unit: money(unit[1]), amount: money(amount[1]) });
    }
    // The total sits after the lines array in the same object.
    const after = decoded.slice(re.lastIndex, re.lastIndex + 400);
    const total = /"total"\s*:\s*"([^"]+)"/.exec(after);
    if (rows.length) examples.push({ rows, total: total ? money(total[1]) : null, at: m.index });
  }
  return examples;
}

const PAGES = ['index.html', 'docs.html'];

for (const page of PAGES) {
  test(`every invoice example in ${page} adds up`, () => {
    const file = path.join(__dirname, '..', 'public', page);
    const html = fs.readFileSync(file, 'utf8');
    const examples = extractInvoiceExamples(html);

    for (const ex of examples) {
      for (const row of ex.rows) {
        assert.equal(
          Math.round(row.qty * row.unit * 100) / 100,
          row.amount,
          `${page}: a line reads ${row.qty} x ${row.unit} but its amount is ${row.amount}`,
        );
      }
      if (ex.total !== null) {
        const sum = Math.round(ex.rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
        assert.equal(
          ex.total, sum,
          `${page}: the line items sum to ${sum} but the example's total says ${ex.total}`,
        );
      }
    }
    // Not an assertion about coverage — just so a silent regex breakage is visible.
    console.log(`  ${page}: checked ${examples.length} invoice example(s)`);
  });
}

test('the plans quoted in the published pages match the ones the code enforces', () => {
  const { PLANS } = require('../src/config');
  const pages = {
    'public/index.html': fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'),
    'public/docs.html': fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'), 'utf8'),
  };
  const readme = path.join(__dirname, '..', '..', 'n8n-nodes-pdfmint', 'README.md');
  if (fs.existsSync(readme)) pages['n8n-nodes-pdfmint/README.md'] = fs.readFileSync(readme, 'utf8');

  for (const [name, text] of Object.entries(pages)) {
    const plain = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    for (const plan of Object.values(PLANS)) {
      const credits = plan.credits.toLocaleString('en-US');
      // If a page names the plan at all, it must quote the right allowance.
      const namesPlan = new RegExp(`\\b${plan.name}\\b`).test(plain);
      if (!namesPlan) continue;
      assert.ok(
        plain.includes(credits) || plain.includes(String(plan.credits)),
        `${name} mentions the ${plan.name} plan but never its allowance of ${credits} documents`,
      );
      if (plan.priceUsd > 0) {
        assert.ok(
          plain.includes(`$${plan.priceUsd}`),
          `${name} mentions the ${plan.name} plan but not its price of $${plan.priceUsd}`,
        );
      }
    }
  }
});

test('the arithmetic checker actually catches a wrong total', () => {
  const broken = '{"lines":[{"desc":"a","qty":18,"unit":"&euro;95.00","amount":"&euro;1,710.00"}],"total":"&euro;3,250.20"}';
  const [ex] = extractInvoiceExamples(broken);
  assert.ok(ex, 'the extractor must find the example');
  const sum = ex.rows.reduce((a, r) => a + r.amount, 0);
  assert.notEqual(ex.total, sum, 'this fixture is deliberately wrong and must be detected');
});
