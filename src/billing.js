'use strict';

const express = require('express');
const Stripe = require('stripe');
const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const { ApiError } = require('./errors');

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey, { apiVersion: '2025-01-27.acacia' }) : null;
const enabled = () => Boolean(stripe);

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * A stored Stripe customer id is not permanent. It can be deleted in the Stripe
 * dashboard, vanish when an account is switched, or come back `deleted: true`
 * from a restore. Trusting it blindly meant the checkout threw
 * "No such customer" and answered 500 — so the one user who wanted to pay could
 * never pay again. Every use of a stored id goes through here, which verifies it
 * and quietly replaces it if it has gone.
 */
async function isUsableCustomer(customerId) {
  if (!customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !customer.deleted;
  } catch (e) {
    if (e && (e.code === 'resource_missing' || e.statusCode === 404 || /No such customer/i.test(e.message || ''))) {
      return false;
    }
    throw e; // a network or auth failure is not the same as a missing customer
  }
}

async function createCustomerFor(account) {
  const customer = await stripe.customers.create({
    email: account.email,
    metadata: { account_id: String(account.id) },
  });
  await query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [account.id, customer.id]);
  return customer.id;
}

async function ensureCustomer(account) {
  if (await isUsableCustomer(account.stripe_customer_id)) return account.stripe_customer_id;
  if (account.stripe_customer_id) {
    console.warn(`[stripe] account ${account.id} pointed at unusable customer ${account.stripe_customer_id}; creating a new one`);
  }
  return createCustomerFor(account);
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Available plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ')}.`,
    });
  }
  const customerId = await ensureCustomer(account);
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.publicUrl}/dashboard?checkout=success`,
    cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
    allow_promotion_codes: true,
    client_reference_id: String(account.id),
    subscription_data: { metadata: { account_id: String(account.id), plan: planId } },
    metadata: { account_id: String(account.id), plan: planId },
  });
}

async function createPortalSession(account) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  if (!account.stripe_customer_id) {
    throw new ApiError(400, 'no_subscription', 'This account has never had a paid subscription.', {
      hint: 'Choose a plan first; the billing portal only exists once there is something to manage.',
    });
  }
  if (!(await isUsableCustomer(account.stripe_customer_id))) {
    // Nothing to manage: the customer this account pointed at is gone, so the
    // honest answer is "there is no subscription", not a 500.
    await query(`UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [account.id]);
    throw new ApiError(400, 'no_subscription', 'There is no billing record for this account any more.', {
      hint: 'Choose a plan to start a new subscription.',
    });
  }
  return stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${config.publicUrl}/dashboard`,
  });
}

/** Maps a Stripe price id back to one of our plans. */
function planForPriceId(priceId) {
  for (const id of Object.keys(PLANS)) {
    if (planPriceId(id) === priceId) return PLANS[id];
  }
  return null;
}

async function applySubscription(subscription) {
  const accountId = subscription.metadata?.account_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId);
  const active = ['active', 'trialing', 'past_due'].includes(subscription.status);

  let target = null;
  if (accountId) {
    const { rows } = await query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    target = rows[0] || null;
  }
  if (!target && customerId) {
    const { rows } = await query(`SELECT * FROM accounts WHERE stripe_customer_id = $1`, [customerId]);
    target = rows[0] || null;
  }
  if (!target) {
    console.warn('[stripe] subscription for unknown account', subscription.id);
    return;
  }

  const newPlan = active && plan ? plan : PLANS.free;
  await query(
    `UPDATE accounts SET plan = $2, credits_limit = $3, stripe_subscription_id = $4, stripe_customer_id = COALESCE(stripe_customer_id, $5)
     WHERE id = $1`,
    [target.id, newPlan.id, newPlan.credits, active ? subscription.id : null, customerId || null],
  );
  console.log(`[stripe] account ${target.id} -> plan ${newPlan.id} (${newPlan.credits} credits), sub ${subscription.id} ${subscription.status}`);
}

async function handleEvent(event) {
  const { rowCount } = await query(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return { duplicate: true };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(String(session.subscription));
        if (!sub.metadata?.account_id && session.client_reference_id) {
          sub.metadata = { ...(sub.metadata || {}), account_id: session.client_reference_id };
        }
        await applySubscription(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object);
      break;
    case 'invoice.paid': {
      // A new billing period starts: reset the monthly counter immediately.
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        await query(
          `UPDATE accounts SET credits_used = 0, period_start = date_trunc('month', now() AT TIME ZONE 'UTC') WHERE stripe_customer_id = $1`,
          [customerId],
        );
      }
      break;
    }
    default:
      break;
  }
  return { handled: event.type };
}

// Stripe needs the raw body to verify the signature, so this route is mounted
// with express.raw() in server.js before the JSON parser.
router.post('/webhook', asyncRoute(async (req, res) => {
  if (!enabled() || !config.stripe.webhookSecret) return res.status(503).json({ error: { code: 'billing_unavailable' } });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    console.warn('[stripe] signature verification failed:', e.message);
    return res.status(400).json({ error: { code: 'invalid_signature', message: e.message } });
  }
  const out = await handleEvent(event);
  res.json({ received: true, ...out });
}));

/**
 * Finds every account whose stored customer id no longer resolves and clears it,
 * so the next checkout creates a fresh one instead of failing. Runs at boot.
 */
async function healStaleCustomers() {
  if (!enabled()) return { checked: 0, healed: 0 };
  const { rows } = await query(`SELECT id, email, stripe_customer_id FROM accounts WHERE stripe_customer_id IS NOT NULL`);
  let healed = 0;
  for (const row of rows) {
    try {
      if (await isUsableCustomer(row.stripe_customer_id)) continue;
      await query(`UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [row.id]);
      healed += 1;
      console.warn(`[stripe] cleared dead customer ${row.stripe_customer_id} from account ${row.id} (${row.email})`);
    } catch (e) {
      console.warn(`[stripe] could not check customer for account ${row.id}: ${e.message}`);
    }
  }
  if (rows.length) console.log(`[stripe] customer health check: ${rows.length} checked, ${healed} cleared`);
  return { checked: rows.length, healed };
}

module.exports = {
  router, stripe, enabled, createCheckoutSession, createPortalSession, applySubscription,
  handleEvent, ensureCustomer, isUsableCustomer, healStaleCustomers,
};
