'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { BASE } = require('./helpers');
const { query } = require('../src/db');
const ads = require('../src/ads');

const CAMPAIGN = 'growth-ads-pdfmint-20260910';

/**
 * First-party attribution for the authorised Google Ads measurement test.
 *
 * What is being protected here, in one sentence: a conversion row in
 * `ad_signup_conversions` must mean "one real, new account signed up through
 * the allowlisted campaign link" — and nothing else. Not an error page, not an
 * already-taken email, not a dashboard reload, not a forged campaign, never an
 * email address, an IP or a gclid.
 *
 * The mail addresses below use letters-only local parts on purpose: a local
 * part containing six consecutive digits is classified as one of OUR scripted
 * signups by src/internal.js, and hex strings can produce exactly that.
 * Letters only are unambiguous, so the qa flag assertion tests the flag and
 * not an accident of the random generator.
 */
function lettersRandom(n = 8) {
  return [...crypto.randomBytes(n)].map((b) => 'abcdefghijklmnop'[b % 16]).join('');
}
const externalEmail = () => `ads-cohort-${lettersRandom()}@gmail.com`;
const internalEmail = () => `pdfmint-test-${lettersRandom()}@gmail.com`;

async function getSignupForm(campaignQuery) {
  const res = await fetch(`${BASE}/signup${campaignQuery}`, { redirect: 'manual' });
  const body = await res.text();
  const token = (body.match(/name="ads" value="([^"]+)"/) || [])[1] || null;
  return { status: res.status, body, token };
}

async function postSignup(email, adsToken, password = 'testpassword123') {
  const fields = { email, password };
  if (adsToken) fields.ads = adsToken;
  const res = await fetch(`${BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: await res.text(), cookie, location: res.headers.get('location') };
}

const conversionsFor = async (email) => {
  const { rows } = await query(
    `SELECT c.account_id, c.campaign_id, c.qa, c.created_at
       FROM ad_signup_conversions c JOIN accounts a ON a.id = c.account_id
      WHERE a.email = $1`,
    [String(email).trim().toLowerCase()],
  );
  return rows;
};

/* ------------------------------------------------------------ the token */

describe('the signed campaign token', () => {
  test('a token the server minted verifies back to the campaign', () => {
    assert.equal(ads.verifyToken(ads.signToken(CAMPAIGN)), CAMPAIGN);
  });

  test('a tampered signature does not verify', () => {
    const token = ads.signToken(CAMPAIGN);
    assert.equal(ads.verifyToken(`${token.slice(0, -2)}xx`), null);
    assert.equal(ads.verifyToken(`${token}x`), null);
  });

  test('an invented campaign id is never signed and never verifies', () => {
    assert.equal(ads.signToken('my-own-campaign'), null);
    assert.equal(ads.verifyToken('my-own-campaign.1789044737055.deadbeefcafe'), null);
  });

  test('a token older than its seven-day window is dead', () => {
    const old = ads.signToken(CAMPAIGN, Date.now() - (8 * 24 * 3600 * 1000));
    assert.equal(ads.verifyToken(old), null);
  });

  test('malformed shapes are refused before any crypto work', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', `${CAMPAIGN}..y`, `${CAMPAIGN}.notanumber.y`, null, undefined]) {
      assert.equal(ads.verifyToken(bad), null, JSON.stringify(bad));
    }
  });
});

/* ------------------------------------------------------- the landing page */

describe('the /ads/pdf landing page', () => {
  test('carries the allowlisted campaign id in its signup link — and nothing else anywhere', async () => {
    const res = await fetch(`${BASE}/ads/pdf`, { redirect: 'manual' });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes(`/signup?campaign=${CAMPAIGN}`), 'the signup link must carry the campaign id');

    // First-party means first-party: no third-party tag, no tracking cookie.
    for (const tag of ['googletagmanager', 'google-analytics', 'gtag(', 'doubleclick', 'facebook.net']) {
      assert.ok(!body.toLowerCase().includes(tag), `the landing page must not load ${tag}`);
    }
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    assert.deepEqual(cookies, [], 'viewing the landing page must not set any cookie');

    // It is a campaign variant of the homepage, not a page search should index.
    assert.match(body, /robots" content="noindex, nofollow"/);
  });

  test('a misspelled or invented campaign renders the same page with a plain signup link', async () => {
    const res = await fetch(`${BASE}/ads/pdf?campaign=growth-ads-pdfmint-20260999`, { redirect: 'manual' });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!body.includes('campaign='), 'an unknown campaign must not be echoed into the page');
    assert.ok(body.includes('href="/signup"'), 'the signup link degrades to the unattributed form');
  });
});

/* --------------------------------------------------- token into the form */

describe('the signup form carries the token only for the allowlisted campaign', () => {
  test('?campaign=<allowlisted> embeds the hidden signed token', async () => {
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    assert.equal(form.status, 200);
    assert.ok(form.token, 'the form must carry the hidden field');
    assert.equal(ads.verifyToken(form.token), CAMPAIGN);
  });

  test('an unknown campaign id yields the plain form', async () => {
    const form = await getSignupForm('?campaign=totally-invented');
    assert.equal(form.status, 200);
    assert.equal(form.token, null, 'no signature is ever minted for an id outside the allowlist');
  });

  test('no campaign at all also yields the plain form', async () => {
    const form = await getSignupForm('');
    assert.equal(form.status, 200);
    assert.equal(form.token, null);
  });
});

/* ------------------------------------------- the exact conversion moment */

describe('a conversion is recorded exactly once — at account creation and nowhere else', () => {
  test('the full attributed journey: landing link → form → signup → one row, qa=false', async () => {
    const email = externalEmail();
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    const signup = await postSignup(email, form.token);
    assert.equal(signup.status, 302, 'the signup itself must succeed');
    assert.equal(signup.location, '/dashboard?welcome=1');
    assert.ok(signup.cookie.includes('pdfmint_session='), 'the normal session flow is preserved');

    const rows = await conversionsFor(email);
    assert.equal(rows.length, 1, 'exactly one conversion');
    assert.equal(rows[0].campaign_id, CAMPAIGN);
    assert.equal(rows[0].qa, false, 'a real-domain signup is not house traffic');
    assert.ok(rows[0].created_at instanceof Date);

    // A dashboard reload is a page view, not a conversion, and nothing about
    // it may write a second row.
    for (let i = 0; i < 2; i++) {
      const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: signup.cookie }, redirect: 'manual' });
      assert.equal(dash.status, 200);
    }
    assert.equal((await conversionsFor(email)).length, 1, 'dashboard reloads must not re-count');

    // Trying the same email again reaches the existing-account path, which
    // must not count either — one per account, full stop.
    const again = await postSignup(email, form.token);
    assert.equal(again.status, 409);
    assert.equal((await conversionsFor(email)).length, 1, 'an existing account must not re-count');
  });

  test('our own signup through the same flow is recorded but stamped qa=true', async () => {
    const email = internalEmail();
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    const signup = await postSignup(email, form.token);
    assert.equal(signup.status, 302);
    const rows = await conversionsFor(email);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].qa, true, 'house traffic is flagged so reporting can exclude it');
  });

  test('a forged token neither blocks the signup nor attributes anything', async () => {
    const email = externalEmail();
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    const forged = `${form.token.slice(0, -2)}xx`;
    const signup = await postSignup(email, forged);
    assert.equal(signup.status, 302, 'attribution must never break the signup flow');
    assert.equal((await conversionsFor(email)).length, 0, 'a forged token records nothing');

    const invented = await postSignup(externalEmail(), 'invented-campaign.1789044737055.deadbeefcafe');
    assert.equal(invented.status, 302);
    assert.equal((await query(`SELECT count(*)::int AS n FROM ad_signup_conversions WHERE campaign_id = 'invented-campaign'`)).rows[0].n, 0);
  });

  test('a failing signup counts nothing, even with a valid token', async () => {
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    const before = Number((await query(`SELECT count(*) AS n FROM ad_signup_conversions`)).rows[0].n);
    const bad = await postSignup(`ads-cohort-${lettersRandom()}@nx-${lettersRandom(12)}.com`, form.token);
    assert.equal(bad.status, 400, 'an undeliverable domain does not create an account');
    const short = await postSignup(externalEmail(), form.token, 'short');
    assert.equal(short.status, 400);
    const after = Number((await query(`SELECT count(*) AS n FROM ad_signup_conversions`)).rows[0].n);
    assert.equal(after, before, 'erroneous signups must not count');
  });

  test('the database itself enforces one conversion per account', async () => {
    const email = externalEmail();
    const form = await getSignupForm(`?campaign=${CAMPAIGN}`);
    await postSignup(email, form.token);
    const [row] = await conversionsFor(email);
    assert.ok(row, 'setup: one conversion must exist');

    // The same valid token, replayed for the same account, must hit the
    // primary key and add nothing — recorded once, null the second time.
    const { rows: [account] } = await query(`SELECT id, email FROM accounts WHERE email = $1`, [email]);
    assert.equal(await ads.recordSignupConversion(account, form.token), null);
    assert.equal((await conversionsFor(email)).length, 1);
  });
});

/* ------------------------------------------------- privacy of the record */

describe('the record contains no personal or third-party identifiers', () => {
  test('the table has exactly the four agreed columns: id, campaign, qa, time', async () => {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ad_signup_conversions' ORDER BY column_name`,
    );
    assert.deepEqual(rows.map((r) => r.column_name), ['account_id', 'campaign_id', 'created_at', 'qa'],
      'no email, no IP, no gclid, no user agent — by schema, not by promise');
  });

  test('signing up without any attribution still works and records nothing', async () => {
    const email = externalEmail();
    const signup = await postSignup(email, null);
    assert.equal(signup.status, 302);
    assert.ok(signup.cookie.includes('pdfmint_session='), 'the plain signup flow is untouched');
    assert.equal((await conversionsFor(email)).length, 0);
  });
});
