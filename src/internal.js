'use strict';

/**
 * Which accounts are ours rather than the world's.
 *
 * This exists because the public status page was counting our own traffic as
 * evidence of demand. On 2026-08-30 it advertised 2,387 documents rendered in
 * seven days; 1,330 of those were load tests and manual probes we had run
 * ourselves, and only 772 came from accounts outside the house. A status page
 * is a trust surface — its whole job is to let a stranger check a claim — so an
 * inflated number there is worse than no number at all.
 *
 * The rule is expressed once, here, and consumed three ways: `isInternalEmail`
 * stamps new signups, `SQL_PREDICATE` backfills the accounts that pre-date the
 * column, and the status queries simply join on the resulting flag. Writing the
 * domain rule out a second time in SQL is exactly how the two copies drift.
 */

// Reserved by RFC 2606 / RFC 6761: these can never belong to a real user, so
// anything under them is ours by construction and needs no maintenance.
const RESERVED_SUFFIXES = ['.test', '.invalid', '.localhost', '.example'];

// Domains that resolve for real but are only ever us: the example domains, the
// throwaway inbox we use for signup tests, and Florian's own company domain.
const INTERNAL_DOMAINS = [
  'example.com', 'example.net', 'example.org',
  'mailinator.com',
  'mintapis.com',
  'pdfmint.dev',
];

// Two more shapes that no filter on the domain can catch, both established by the
// account audit in GOAL.md and both measured on 2026-08-30: our scripted signups
// carry the unix timestamp of their own creation in the local part
// (`verify-1787633960@gmail.com` alone accounts for 707 usage events), and
// Florian's own address appears both plain and plus-addressed. Filtering only on
// the domain left 763 events -- every one of them ours -- being published as the
// world's demand.
const TIMESTAMP_IN_LOCAL = /[0-9]{6}/;
const OWNER_LOCALPARTS = ['florian.standhartinger'];

function localOf(email) {
  return String(email || '').trim().toLowerCase().split('@')[0] || '';
}

function domainOf(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || '';
}

function isInternalEmail(email) {
  const d = domainOf(email);
  if (!d) return false;
  if (RESERVED_SUFFIXES.some((s) => d.endsWith(s)) || INTERNAL_DOMAINS.includes(d)) return true;
  const l = localOf(email);
  // Plus-addressing is the same mailbox, so compare on the part before the '+'.
  if (OWNER_LOCALPARTS.includes(l.split('+')[0])) return true;
  return TIMESTAMP_IN_LOCAL.test(l);
}

// The same rule as SQL, for the one-time backfill of accounts created before the
// column existed. Built from the constants above so there is nothing to keep in
// sync by hand.
const SQL_PREDICATE = [
  ...RESERVED_SUFFIXES.map((s) => `email LIKE '%${s}'`),
  `split_part(email, '@', 2) = ANY (ARRAY[${INTERNAL_DOMAINS.map((d) => `'${d}'`).join(', ')}])`,
  // Postgres has no /[0-9]{6}/ literal; ~ with the same class is the equivalent.
  `split_part(email, '@', 1) ~ '[0-9]{6}'`,
  `split_part(split_part(email, '@', 1), '+', 1) = ANY (ARRAY[${OWNER_LOCALPARTS.map((l) => `'${l}'`).join(', ')}])`,
].join(' OR ');

module.exports = { isInternalEmail, SQL_PREDICATE, RESERVED_SUFFIXES, INTERNAL_DOMAINS, OWNER_LOCALPARTS };
