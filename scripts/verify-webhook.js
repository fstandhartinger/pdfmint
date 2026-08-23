#!/usr/bin/env node
'use strict';

/**
 * Proves the Stripe -> quota path end to end with REAL live Stripe events.
 *
 * It creates a genuine live subscription for a throwaway customer using
 * collection_method: 'send_invoice' (so no card and no charge is involved),
 * waits for our webhook to move that account onto the paid plan, then cancels
 * the subscription and checks the account falls back to Free. Everything it
 * creates in Stripe is voided and cancelled before it exits.
 */

const Stripe = require('stripe');
const { query } = require('../src/db');
const { PLANS } = require('../src/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' });
const PRICE = process.env.STRIPE_PRICE_STARTER;
const EMAIL = process.env.VERIFY_EMAIL;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function accountRow() {
  const { rows } = await query(`SELECT id, email, plan, credits_limit, credits_used, stripe_customer_id, stripe_subscription_id FROM accounts WHERE email = $1`, [EMAIL]);
  return rows[0];
}

async function waitForPlan(expected, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const a = await accountRow();
    if (a && a.plan === expected) return a;
    await wait(3000);
  }
  return null;
}

(async () => {
  const before = await accountRow();
  if (!before) throw new Error(`No PDFMint account for ${EMAIL}`);
  console.log(`before:  plan=${before.plan} limit=${before.credits_limit}`);

  const customer = await stripe.customers.create({
    email: EMAIL,
    name: 'PDFMint webhook verification',
    metadata: { account_id: String(before.id), pdfmint_verification: 'true' },
  });
  await query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [before.id, customer.id]);
  console.log(`customer: ${customer.id}`);

  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: PRICE }],
    collection_method: 'send_invoice',
    days_until_due: 30,
    metadata: { account_id: String(before.id), plan: 'starter', pdfmint_verification: 'true' },
  });
  console.log(`subscription: ${sub.id} status=${sub.status}  (live event customer.subscription.created emitted)`);

  const upgraded = await waitForPlan('starter');
  console.log(upgraded
    ? `AFTER UPGRADE: plan=${upgraded.plan} limit=${upgraded.credits_limit} (expected ${PLANS.starter.credits})`
    : 'AFTER UPGRADE: TIMED OUT — webhook did not move the account');

  console.log('\ncancelling…');
  await stripe.subscriptions.cancel(sub.id);
  const downgraded = await waitForPlan('free');
  console.log(downgraded
    ? `AFTER CANCEL: plan=${downgraded.plan} limit=${downgraded.credits_limit}`
    : 'AFTER CANCEL: TIMED OUT — webhook did not downgrade the account');

  // Clean up everything this script created in Stripe.
  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 20 });
  for (const inv of invoices.data) {
    if (inv.status === 'draft') { await stripe.invoices.del(inv.id); console.log(`deleted draft invoice ${inv.id}`); }
    else if (inv.status === 'open') { await stripe.invoices.voidInvoice(inv.id); console.log(`voided invoice ${inv.id}`); }
  }
  await stripe.customers.del(customer.id);
  await query(`UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [before.id]);
  console.log(`deleted customer ${customer.id}`);

  const final = await accountRow();
  console.log(`\nfinal:   plan=${final.plan} limit=${final.credits_limit} used=${final.credits_used}`);
  process.exit(upgraded && downgraded ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
