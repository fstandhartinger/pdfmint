#!/usr/bin/env node
'use strict';

/**
 * Creates (idempotently) the PDFMint products, monthly prices and the webhook
 * endpoint in Stripe, then prints the env vars to set on Render.
 *
 *   STRIPE_SECRET_KEY=sk_live_... PUBLIC_URL=https://... node scripts/setup-stripe.js
 */

const Stripe = require('stripe');
const { PLANS } = require('../src/config');

const key = process.env.STRIPE_SECRET_KEY;
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
if (!key) { console.error('STRIPE_SECRET_KEY is required'); process.exit(1); }
if (!publicUrl) { console.error('PUBLIC_URL is required'); process.exit(1); }

const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' });
const live = key.startsWith('sk_live_');

async function ensureProduct(plan) {
  const found = await stripe.products.search({ query: `metadata['pdfmint_plan']:'${plan.id}'` });
  if (found.data.length) return found.data[0];
  return stripe.products.create({
    name: `PDFMint ${plan.name}`,
    description: `${plan.credits.toLocaleString('en-US')} documents per month`,
    metadata: { pdfmint_plan: plan.id },
  });
}

async function ensurePrice(product, plan) {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = prices.data.find(
    (p) => p.unit_amount === plan.priceUsd * 100 && p.currency === 'usd' && p.recurring?.interval === 'month',
  );
  if (match) return match;
  return stripe.prices.create({
    product: product.id,
    unit_amount: plan.priceUsd * 100,
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: { pdfmint_plan: plan.id },
  });
}

async function ensureWebhook() {
  const url = `${publicUrl}/stripe/webhook`;
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = list.data.find((w) => w.url === url);
  const enabled_events = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
  ];
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events });
    return { endpoint: existing, secret: null };
  }
  const created = await stripe.webhookEndpoints.create({ url, enabled_events, description: 'PDFMint' });
  return { endpoint: created, secret: created.secret };
}

(async () => {
  console.log(`Mode: ${live ? 'LIVE' : 'test'}   Public URL: ${publicUrl}\n`);
  const out = {};
  for (const plan of Object.values(PLANS)) {
    if (!plan.stripePriceEnv) continue;
    const product = await ensureProduct(plan);
    const price = await ensurePrice(product, plan);
    out[plan.stripePriceEnv] = price.id;
    console.log(`${plan.name.padEnd(8)} $${String(plan.priceUsd).padEnd(4)} ${plan.credits.toLocaleString('en-US').padStart(8)} docs   product=${product.id} price=${price.id}`);
  }
  const { endpoint, secret } = await ensureWebhook();
  console.log(`\nWebhook ${secret ? 'created' : 'already existed'}: ${endpoint.id} -> ${endpoint.url}`);
  console.log(`  events: ${endpoint.enabled_events.join(', ')}`);
  if (secret) out.STRIPE_WEBHOOK_SECRET = secret;
  else console.log('  (secret is only shown at creation — reuse the one already set on the service)');

  console.log('\n--- env vars ---');
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
