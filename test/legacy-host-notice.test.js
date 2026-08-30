'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { req, newAccount } = require('./helpers');

/**
 * Der alte Render-Host bleibt an, weil der einzige zahlende Kunde noch ueber ihn
 * rendert. Statt ihn abzuschalten, sagt jede Antwort von dort, wohin er wechseln
 * soll — im JSON als `warnings`, im Binaermodus als `X-PDFMint-Warning`, den der
 * n8n-Node als Feld `warning` anzeigt.
 *
 * Zwei Dinge muessen stimmen, und das zweite ist das wichtigere: der Hinweis muss
 * auf dem alten Host erscheinen, und auf dem kanonischen Host darf er unter
 * keinen Umstaenden erscheinen. Ein Hinweis auf pdf.mintapis.com wuerde jedem
 * Nutzer sagen, sein Host werde abgeschaltet — das Gegenteil von wahr.
 */
describe('the retirement notice on the old Render host', () => {
  test('binary renders carry it in the warning header', async () => {
    const { key } = await newAccount('starter');
    const r = await req('/v1/pdf', {
      method: 'POST', key, raw: true,
      headers: { 'X-Forwarded-Host': 'pdfmint-b9tt.onrender.com' },
      body: { html: '<h1>legacy host</h1>' },
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    const warning = r.res.headers.get('x-pdfmint-warning') || '';
    assert.match(warning, /being retired/);
    assert.match(warning, /pdf\.mintapis\.com/);
  });

  test('json responses carry it in warnings', async () => {
    const { key } = await newAccount('starter');
    const r = await req('/v1/pdf', {
      method: 'POST', key,
      headers: { 'X-Forwarded-Host': 'pdfmint-b9tt.onrender.com' },
      body: { html: '<h1>legacy host</h1>', output: 'base64' },
    });
    assert.equal(r.res.status, 200);
    assert.ok(Array.isArray(r.json.warnings), 'warnings must be an array');
    assert.ok(r.json.warnings.some((w) => /being retired/.test(w)));
  });

  test('the canonical host says nothing of the kind', async () => {
    const { key } = await newAccount('starter');
    const r = await req('/v1/pdf', {
      method: 'POST', key,
      headers: { 'X-Forwarded-Host': 'pdf.mintapis.com' },
      body: { html: '<h1>canonical host</h1>', output: 'base64' },
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.res.headers.get('x-pdfmint-warning'), null);
    for (const w of r.json.warnings || []) {
      assert.doesNotMatch(w, /being retired/, 'the live host must never announce its own retirement');
    }
  });
});
