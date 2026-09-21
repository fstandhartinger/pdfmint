'use strict';

// Truthfulness test for public/privacy.html: what the privacy page claims
// must match what the code actually does. Retention windows are asserted
// directly against the source, so a code change forces the page to change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

test('privacy page claims match the code', () => {
  const text = toText(read('public/privacy.html')).toLowerCase();

  const absent = [
    'does not send email at all',
    'no password reset',
    'neon',
    'own server in frankfurt',
    'server in frankfurt',
    'runs the application and keeps http request logs',
    'three companies',
    'cleared as soon as it is used',
  ];
  for (const phrase of absent) {
    assert.ok(!text.includes(phrase), `privacy page must not contain: ${phrase}`);
  }

  const present = [
    'hetzner',
    'helsinki',
    'password-reset',
    'smtp.gmail.com',
    '30 minutes',
    '3 hours',
    '2 hours',
    'pdfmint-b9tt.onrender.com',
    'hetzner online gmbh',
    'the request time stays with the account',
  ];
  for (const phrase of present) {
    assert.ok(text.includes(phrase), `privacy page must contain: ${phrase}`);
  }
});

test('privacy page retention windows match the code', () => {
  const recovery = read('src/recovery.js');
  assert.ok(
    recovery.includes("interval '30 minutes'"),
    'src/recovery.js must keep interval \'30 minutes\' (reset link validity)',
  );
  assert.ok(
    recovery.includes("interval '2 hours'"),
    'src/recovery.js must keep interval \'2 hours\' (reset attempt limiter)',
  );

  const api = read('src/api.js');
  assert.ok(
    api.includes("interval '3 hours'"),
    'src/api.js must keep interval \'3 hours\' (demo usage rows)',
  );
});
