'use strict';

const express = require('express');
const Stripe = require('stripe');
const { config, PLANS, planPriceId } = require('./config');
const { query, tx } = require('./db');
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

async function createCustomerFor(account, run = query) {
  const customer = await stripe.customers.create({
    email: account.email,
    metadata: { account_id: String(account.id) },
  });
  await run(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [account.id, customer.id]);
  return customer.id;
}

async function ensureCustomer(account, run = query) {
  if (await isUsableCustomer(account.stripe_customer_id)) return account.stripe_customer_id;
  if (account.stripe_customer_id) {
    console.warn(`[stripe] account ${account.id} pointed at unusable customer ${account.stripe_customer_id}; creating a new one`);
  }
  return createCustomerFor(account, run);
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Available plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ')}.`,
    });
  }
  // Serialize clicks across all instances, and re-read the authoritative row.
  return tx(async client => {
    const run = client.query.bind(client);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    account = rows[0];
    if (!account) throw new ApiError(404, 'account_not_found', 'Account not found.');
    const customerId = await ensureCustomer(account, run);
    const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (listed.has_more) throw new ApiError(409, 'billing_review_required', 'Please manage subscriptions through the billing portal.');
    const current = listed.data.filter(sub =>
      !['canceled', 'incomplete_expired'].includes(sub.status)
      && sub.items.data.some(item => planForPriceId(item.price.id)));
    if (current.length > 1) throw new ApiError(409, 'multiple_subscriptions', 'Multiple subscriptions exist. Contact support before changing your plan.');
    if (current.length) {
      const sub = current[0];
      const item = sub.items.data.find(item => planForPriceId(item.price.id));
      if (!['active', 'trialing'].includes(sub.status) || sub.pending_update) {
        return stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
      }
      if (item.price.id === priceId) {
        await applySubscription(sub, run);
        return { url: `${config.publicUrl}/dashboard?checkout=updated` };
      }
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId, quantity: item.quantity || 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
      }, { idempotencyKey: `pdfmint-upgrade-${sub.id}-${item.price.id}-${priceId}-${Math.floor(Date.now() / 1800000)}` });
      // Pending updates keep the old price until the prorated invoice is paid.
      await applySubscription(updated, run);
      if (updated.pending_update) {
        const invoiceUrl = updated.latest_invoice?.hosted_invoice_url;
        return { url: invoiceUrl || `${config.publicUrl}/dashboard?checkout=pending` };
      }
      return { url: `${config.publicUrl}/dashboard?checkout=updated` };
    }
    // Reuse the open session so double clicks cannot create two subscriptions.
    const open = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
    if (open.has_more) throw new ApiError(409, 'billing_review_required', 'Please contact support before starting another checkout.');
    for (const session of open.data) {
      if (session.mode !== 'subscription' || session.metadata?.account_id !== String(account.id)) continue;
      if (session.metadata.plan === planId) return session;
      await stripe.checkout.sessions.expire(session.id);
    }
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.publicUrl}/dashboard?checkout=success`,
    cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
    allow_promotion_codes: true,
    // An EU business needs its VAT ID on the invoice or its accountant will not
    // accept the receipt. Optional on purpose: Stripe shows an "Add VAT ID" link
    // that a private buyer can simply ignore, so nobody is forced to have one.
    tax_id_collection: { enabled: true },
    billing_address_collection: 'auto',
    // Stripe requires this whenever a session both attaches an existing customer
    // and collects an address or a tax id; without it the session is rejected.
    customer_update: { name: 'auto', address: 'auto' },
    client_reference_id: String(account.id),
    subscription_data: { metadata: { account_id: String(account.id), plan: planId } },
    metadata: { account_id: String(account.id), plan: planId },
  }, { idempotencyKey: `pdfmint-checkout-${account.id}-${planId}-${Math.floor(Date.now() / 1800000)}` });
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

async function applySubscription(subscription, run = query) {
  const accountId = subscription.metadata?.account_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId);
  const active = ['active', 'trialing', 'past_due'].includes(subscription.status);

  // One Stripe account serves more than one product, and every endpoint on it
  // receives every event. A subscription whose price is not one of ours belongs
  // to a sibling product; acting on it once downgraded a live, paying PDFMint
  // customer because a DocMint subscription tagged with the same account_id was
  // cancelled. Anything we cannot price is not ours to act on.
  if (!plan) {
    console.warn(`[stripe] ignoring subscription ${subscription.id}: price ${priceId} is not a PDFMint plan`);
    return { ignored: 'foreign_price' };
  }

  let target = null;
  if (accountId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    target = rows[0] || null;
  }
  if (!target && customerId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE stripe_customer_id = $1`, [customerId]);
    target = rows[0] || null;
  }
  if (!target) {
    console.warn('[stripe] subscription for unknown account', subscription.id);
    return;
  }

  // A cancellation only speaks for the subscription it names. When an account has
  // since moved to a different subscription, an older one ending must not revoke
  // the current one.
  if (!active && target.stripe_subscription_id && target.stripe_subscription_id !== subscription.id) {
    console.warn(`[stripe] ignoring ${subscription.status} of stale subscription ${subscription.id};`
      + ` account ${target.id} is on ${target.stripe_subscription_id}`);
    return { ignored: 'stale_subscription' };
  }

  const newPlan = active ? plan : PLANS.free;
  await run(
    `UPDATE accounts SET plan = $2, credits_limit = $3, stripe_subscription_id = $4, stripe_customer_id = COALESCE(stripe_customer_id, $5)
     WHERE id = $1`,
    [target.id, newPlan.id, newPlan.credits, active ? subscription.id : null, customerId || null],
  );
  console.log(`[stripe] account ${target.id} -> plan ${newPlan.id} (${newPlan.credits} credits), sub ${subscription.id} ${subscription.status}`);
}

async function handleEvent(event) {
  return tx(async client => {
  const run = client.query.bind(client);
  const { rowCount } = await run(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return { duplicate: true };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(String(session.subscription));
        if (!sub.metadata?.account_id && session.client_reference_id) {
          sub.metadata = { ...(sub.metadata || {}), account_id: session.client_reference_id };
        }
        await applySubscription(sub, run);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object, run);
      break;
    case 'invoice.paid': {
      // A renewal starts a new period — but only if the current one has actually
      // ended. rollPeriod() already resets the counter on the calendar 1st, so
      // resetting again on the billing anniversary handed a customer who
      // subscribed mid-month a second full quota every cycle. The number of
      // documents is the only thing being sold, so that was giving it away.
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        await run(
          `UPDATE accounts
              SET credits_used = 0,
                  period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
            WHERE stripe_customer_id = $1
              AND period_start < date_trunc('month', now() AT TIME ZONE 'UTC')`,
          [customerId],
        );
      }
      break;
    }
    default:
      break;
  }
  return { handled: event.type };
  });
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
