'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A live API key was once pasted into the docs page by the tooling that wrote
 * it. This makes that impossible to ship again.
 */
const SECRET_PATTERNS = [
  [/pm_live_[A-Za-z0-9_-]{20,}/g, 'a live PDFMint API key', /^pm_live_x+$/],
  [/sk_live_[A-Za-z0-9]{20,}/g, 'a live Stripe secret key', null],
  [/whsec_[A-Za-z0-9]{20,}/g, 'a Stripe webhook secret', null],
  [/npg_[A-Za-z0-9]{20,}/g, 'a Neon database password', null],
  [/ghp_[A-Za-z0-9]{30,}/g, 'a GitHub token', null],
  [/rnd_[A-Za-z0-9]{20,}/g, 'a Render API key', null],
  // A throwaway localhost URL in CI is not a secret; anything pointing off-box is.
  [/postgres(?:ql)?:\/\/[^\s"'`]*:[^\s"'`@]+@(?!localhost|127\.0\.0\.1)[^\s"'`/]+/g, 'a database URL with a password', null],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'test'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(html|css|js|json|md|ts|yml|yaml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no committed file contains a real credential', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const file of walk(root)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const [pattern, what, allowed] of SECRET_PATTERNS) {
      for (const match of content.match(pattern) || []) {
        if (allowed && allowed.test(match)) continue;
        offenders.push(`${path.relative(root, file)}: ${what} (${match.slice(0, 14)}…)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `found credentials in committed files:\n${offenders.join('\n')}`);
});
