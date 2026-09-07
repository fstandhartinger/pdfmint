'use strict';

const express = require('express');
const Stripe = require('stripe');
const { config, PLANS, planPriceId } = require('./config');
const { query, tx } = require('./db');
const { ApiError } = require('./errors');

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey, {
  apiVersion: '2025-01-27.acacia',
  // Bounded on purpose. The checkout path makes several sequential Stripe
  // calls while it holds a database connection and a row lock, and the pool
  // is small. With the library's defaults (80 s, two retries) one Stripe
  // slowdown would hold every connection long enough to take the whole
  // service down, not just billing.
  timeout: 10000,
  maxNetworkRetries: 1,
}) : null;

// The name a buyer sees at the top of the Stripe Checkout page.
const BRAND_NAME = 'PDFMint';
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

// A payment in one of these states may still succeed. Voiding its invoice is how
// money gets taken for nothing, so an attempt in flight is never touched.
// `requires_action` and `requires_payment_method` are deliberately NOT here: those
// are the abandoned 3-D Secure step and the declined card, which is exactly what
// the abandoned-attempt sweep exists to clear.
const SETTLING = ['processing', 'requires_capture', 'succeeded'];

/**
 * What is still payable about an `incomplete` subscription's first invoice.
 *
 * Where the payment intent lives depends on the API version: on the version this
 * client pins (`2025-01-27.acacia`) it is `invoice.payment_intent`; on the
 * account's newer default it has moved under `payments.data[].payment.payment_intent`.
 * Both expansions are accepted by both versions, so both are asked for and
 * whichever answers is used — otherwise a future default-version bump would
 * silently switch this guard off.
 *
 * Unreadable is reported as `null`, which the caller treats as "do not touch".
 */
async function abandonedInvoice(sub) {
  const id = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
  if (!id) return null;
  try {
    const invoice = await stripe.invoices.retrieve(id, {
      expand: ['payment_intent', 'payments.data.payment.payment_intent'],
    });
    const intents = [
      invoice.payment_intent,
      ...(invoice.payments?.data || []).map((entry) => entry.payment?.payment_intent),
    ].filter((intent) => intent && typeof intent === 'object');
    return {
      url: invoice.hosted_invoice_url || null,
      status: invoice.status,
      inFlight: intents.some((intent) => SETTLING.includes(intent.status)),
    };
  } catch (e) {
    console.warn(`[stripe] could not read invoice ${id} of abandoned attempt ${sub.id}: ${e.message}`);
    return null;
  }
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Available plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ')}.`,
    });
  }
  // The Stripe customer is created and committed in its OWN short transaction.
  // Inside the long one below, any later failure rolled the stored id back while
  // the Stripe object survived — so every failed checkout during a Stripe incident
  // minted another orphaned customer carrying the buyer's email address, and
  // nothing ever reclaimed them.
  //
  // These are two transactions, so the lock taken here is released before the one
  // below starts — an earlier version of this comment claimed the lock was "held
  // across it", and that was simply false. What keeps two simultaneous clicks to
  // one customer is that BOTH transactions take the row lock and re-read the row
  // under it: the second click blocks here and then reads the customer id the
  // first one committed. Measured 2026-09-07 against the deployed build: four
  // simultaneous clicks produced one customer and one checkout session.
  const customerId = await tx(async (client) => {
    const run = client.query.bind(client);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    if (!rows[0]) throw new ApiError(404, 'account_not_found', 'Account not found.');
    return ensureCustomer(rows[0], run);
  });
  // Serialize clicks across all instances, and re-read the authoritative row.
  return tx(async client => {
    const run = client.query.bind(client);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    account = rows[0];
    if (!account) throw new ApiError(404, 'account_not_found', 'Account not found.');
    const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (listed.has_more) throw new ApiError(409, 'billing_review_required', 'Please manage subscriptions through the billing portal.');
    const current = listed.data.filter(sub =>
      // `incomplete` means the very first payment has not cleared. Stripe
      // leaves it that way for about a day before expiring it, and it never
      // granted anything — treating it as "current" sent a buyer whose 3-D
      // Secure failed to a billing portal with nothing to manage, for 24
      // hours, instead of letting them simply pay again.
      !['canceled', 'incomplete', 'incomplete_expired'].includes(sub.status)
      && sub.items.data.some(item => planForPriceId(item.price.id)));
    if (current.length > 1) throw new ApiError(409, 'multiple_subscriptions', 'Multiple subscriptions exist. Contact support before changing your plan.');

    /**
     * An `incomplete` subscription grants nothing, but its first invoice stays
     * PAYABLE for about a day — so ignoring it and opening a second checkout
     * beside it is how one buyer ends up paying for two. Measured in DocMint on
     * 2026-09-06 in test mode against the same code: an abandoned $9 attempt, a
     * completed $29 checkout, then the abandoned invoice paid afterwards = two
     * active subscriptions, $38 a month, and the account left on the CHEAPER
     * plan's quota because the later webhook won.
     *
     * The buyer must still be able to pay. What they must not be able to do is
     * pay twice for one intention. So: finish the attempt they made, or make it
     * unpayable — never leave it payable next to a new one.
     */
    const abandoned = listed.data.filter((sub) => sub.status === 'incomplete'
      && sub.items.data.some((item) => planForPriceId(item.price.id)));
    let finish = null;     // the attempt to hand the buyer back to
    let blocked = false;   // ...or one we may not judge, which also forbids a second
    for (const sub of abandoned) {
      const item = sub.items.data.find((entry) => planForPriceId(entry.price.id));
      // eslint-disable-next-line no-await-in-loop
      const attempt = await abandonedInvoice(sub);
      if (attempt && attempt.status !== 'open') continue;   // nothing payable is left
      // Same plan and nothing live to upgrade: finishing the payment they started
      // is the retry they actually want, and it cannot produce a second
      // subscription. An unreadable or still-settling attempt goes the same way,
      // because the one thing worse than a confusing page is a double charge.
      const samePlan = Boolean(item && item.price.id === priceId && !current.length);
      if (samePlan || !attempt || attempt.inFlight) {
        // Remembered, not returned: every OTHER abandoned attempt still has to be
        // made unpayable before this call ends, or it sits there for a day.
        blocked = true;
        if (!finish && attempt && attempt.url) finish = attempt;
        continue;
      }
      // They changed their mind. Cancelling an incomplete subscription voids its
      // open invoice, and Stripe then refuses a late payment outright — measured:
      // "Voided invoices cannot be paid."
      // eslint-disable-next-line no-await-in-loop
      await stripe.subscriptions.cancel(sub.id);
      console.log(`[stripe] account ${account.id}: cancelled abandoned attempt ${sub.id}`
        + ` (${item && item.price.id}) so its invoice cannot be paid beside a new one`);
    }
    if (blocked) {
      return finish
        ? { url: finish.url }
        : stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
    }

    if (current.length) {
      const sub = current[0];
      const item = sub.items.data.find(item => planForPriceId(item.price.id));
      if (!['active', 'trialing'].includes(sub.status) || sub.pending_update) {
        return stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
      }
      if (item.price.id === priceId) {
        // `sub` came straight from subscriptions.list a moment ago, under the row
        // lock: it is already what Stripe holds, so do not pay for a second call.
        await applySubscription(sub, run, { refresh: false });
        return { url: `${config.publicUrl}/dashboard?checkout=updated` };
      }
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId, quantity: item.quantity || 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
      });
      // No idempotency key here, and that is the fix rather than an omission.
      // The key was `…-{sub}-{from}-{to}-{30-minute bucket}`, so Starter -> Pro ->
      // Starter -> Pro inside one window sent the FIRST key again and Stripe
      // replayed its stored response: the subscription stayed on Starter while we
      // read Pro out of the replay and granted the Pro quota. The customer would
      // have paid $9 for 50,000 documents. What actually collapses a double click
      // is the account row lock plus the re-read of Stripe above — the second
      // click sees Pro and takes the "already on this plan" branch. The Stripe
      // client still generates its own key per request, so an SDK network retry
      // cannot duplicate anything.
      // A pending update is an UNPAID upgrade: Stripe keeps the old price until
      // the prorated invoice clears. Writing the new plan here would hand out the
      // larger quota before the money moved, so the entitlement is left alone and
      // the customer is sent to the invoice. `invoice.paid` / `subscription.updated`
      // applies it once it is real.
      if (updated.pending_update) {
        const invoiceUrl = updated.latest_invoice?.hosted_invoice_url;
        return { url: invoiceUrl || `${config.publicUrl}/dashboard?checkout=pending` };
      }
      // `updated` is Stripe's own response to the update we just made.
      await applySubscription(updated, run, { refresh: false });
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
  // No idempotency key on this call either, for the same reason and with a worse
  // symptom. The key spanned a 30-minute window, and choosing a different plan
  // EXPIRES the session created for the first one — so Starter, then Pro, then
  // Starter again replayed the dead Starter session and Stripe's page told the
  // buyer "You're all done here. You've either completed your payment or this
  // checkout session has timed out." They could not pay, and nothing said why.
  // The replayed body is no help in spotting it: it still reads `status: "open"`
  // while a fresh retrieve of the same id says `expired`. Keying the retry on the
  // dead session's id only moves the problem, because that key is replayable too.
  // What stops two sessions is the row lock plus the reuse of the OPEN session
  // listed immediately above.
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // The session id comes back so the dashboard can VERIFY the payment with
    // Stripe instead of believing `?checkout=success`. See verifyCheckoutReturn.
    success_url: `${config.publicUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
    // One Stripe account sells several products, so its business name is the
    // portfolio's ("Amazing AI Apps") and a PDFMint buyer had no idea who was
    // charging them. branding_settings overrides the name on THIS session only;
    // the legal entity, receipts, statement descriptor and support details are
    // account-level and deliberately untouched.
    branding_settings: { display_name: BRAND_NAME },
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
    metadata: { account_id: String(account.id), plan: planId, service: 'pdfmint' },
  });
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

/**
 * `refresh` decides whether the subscription's status is re-read from Stripe
 * before it is acted on. Callers that were handed an authoritative object by
 * Stripe a moment ago — the checkout path — pass `false`; webhook bodies, which
 * are snapshots, do not. See the block below.
 */
/**
 * Asks Stripe what a subscription is now, and turns a failure into something the
 * caller may not confuse with an answer.
 *
 * The old code fell back to the event body here, on the reasoning that asking
 * Stripe is better information and not a new dependency to fail on. Measured on
 * 2026-09-07 against this deployed image (547ff2d), with Stripe genuinely
 * unreachable from the container, that fallback is what stripped a paying
 * customer: the `created` body says `incomplete` every time, so a paid account
 * went from `starter / 5000` to `free / 10` with the subscription id cleared —
 * answered HTTP 200, so nothing was retried, and consumed the event id, so the
 * retry would have been a duplicate.
 *
 * So a snapshot we cannot confirm is never acted on. What differs is the answer:
 *
 *   transient — a connection failure, a timeout, a rate limit, a Stripe 5xx, and
 *     also a key that is wrong or restricted: all of those are fixed by somebody,
 *     and Stripe redelivers for three days. The delivery fails, the event id rolls
 *     back with the transaction, and the plan is decided minutes late instead of
 *     wrongly. A wrong key also shows up in Stripe's own failed-delivery list,
 *     which answering 200 would hide.
 *   permanent — "no such subscription", and only that. Redelivering cannot make
 *     the object exist, and an endpoint that fails continuously eventually gets
 *     disabled, which would take the deliveries that DO work with it. So it is
 *     answered — still writing nothing, still not consuming the event id.
 *
 * The read is bounded and does NOT retry in-process: it happens while an account
 * row is locked and the pool is small (PG_POOL_MAX defaults to 5), and Stripe's
 * own redelivery is the retry. A 429 carrying Retry-After would otherwise hold
 * that lock for up to a minute.
 */
function unverifiable(subscriptionId, e) {
  const permanent = Boolean(e && (e.code === 'resource_missing' || e.statusCode === 404));
  console.warn(`[stripe] could not confirm subscription ${subscriptionId} (${e && e.message});`
    + ` refusing to act on the event body (permanent=${permanent})`);
  const failure = new ApiError(503, 'subscription_unverifiable',
    `Could not confirm subscription ${subscriptionId} with Stripe; refusing to act on the event body.`);
  failure.stripePermanent = permanent;
  return failure;
}

async function confirmSubscription(id) {
  try {
    return await stripe.subscriptions.retrieve(String(id), {}, { timeout: 5000, maxNetworkRetries: 0 });
  } catch (e) {
    throw unverifiable(id, e);
  }
}

async function applySubscription(subscription, run = query, { refresh = true } = {}) {
  const accountId = subscription.metadata?.account_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  // One Stripe account serves more than one product, and every endpoint on it
  // receives every event. A subscription whose price is not one of ours belongs
  // to a sibling product; acting on it once downgraded a live, paying PDFMint
  // customer because a DocMint subscription tagged with the same account_id was
  // cancelled. Anything we cannot price is not ours to act on. Checked on the
  // event body first, before we lock one of our rows or spend a Stripe call on
  // something that was never ours.
  if (!planForPriceId(subscription.items?.data?.[0]?.price?.id)) {
    console.warn(`[stripe] ignoring subscription ${subscription.id}:`
      + ` price ${subscription.items?.data?.[0]?.price?.id} is not a PDFMint plan`);
    return { ignored: 'foreign_price' };
  }

  let target = null;
  if (accountId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]);
    target = rows[0] || null;
  }
  if (!target && customerId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE stripe_customer_id = $1 FOR UPDATE`, [customerId]);
    target = rows[0] || null;
  }
  if (!target) {
    console.warn('[stripe] subscription for unknown account', subscription.id);
    return;
  }

  // `metadata.account_id` is a number we put there ourselves, and the sibling
  // products on this Stripe account number their accounts from 1 as well. So the
  // id alone is not proof of ownership: the subscription must also sit on the
  // Stripe customer this account is bound to. An account that has never paid has
  // no customer yet, and there the price check above is what carries the weight.
  if (customerId && target.stripe_customer_id && target.stripe_customer_id !== customerId) {
    console.warn(`[stripe] ignoring subscription ${subscription.id}: customer ${customerId}`
      + ` is not account ${target.id}'s customer`);
    return { ignored: 'foreign_customer' };
  }

  /**
   * The event body is a SNAPSHOT of the moment Stripe emitted it, and Stripe
   * emits a purchase's four events at once and delivers them concurrently, in no
   * guaranteed order. `customer.subscription.created` is emitted the instant the
   * subscription exists — which for a card payment is BEFORE the card is charged
   * — so its body says `status: "incomplete"` every single time. Acted on as
   * written and processed last, it set a paying customer back to `free` and
   * cleared the subscription id. Reproduced against this exact deployed image on
   * 2026-09-06 with genuine Stripe events; the live webhook endpoint is enabled
   * for `customer.subscription.created`, so it is reachable in production.
   * Evidence: ops/proofs/remaining-readiness/pdfmint-event-order/.
   *
   * So the status and the price are read from Stripe as they are NOW, after the
   * account row is locked. That is what makes the outcome independent of delivery
   * order: Stripe gives the same answer to all four events, their snapshots do not.
   *
   * A failure here is NOT a licence to use the snapshot — see unverifiable()
   * above for what happens instead, and for the measurement that changed it.
   */
  let current = subscription;
  if (refresh && stripe && subscription.id) {
    try {
      // Bounded, and deliberately without an in-process retry: this happens while
      // an account row is locked and the pool is PG_POOL_MAX (5 by default), so a
      // Stripe incident must cost one webhook five seconds rather than hold a lock
      // and a connection. The retry is Stripe's redelivery. See unverifiable().
      const found = await stripe.subscriptions.retrieve(String(subscription.id), {},
        { timeout: 5000, maxNetworkRetries: 0 });
      if (found && found.id) {
        // Metadata is ours, and may exist only on the body we were handed: the
        // checkout path stamps account_id onto it from client_reference_id.
        current = { ...found, metadata: { ...(subscription.metadata || {}), ...(found.metadata || {}) } };
        if (found.status !== subscription.status) {
          console.log(`[stripe] subscription ${subscription.id} refreshed:`
            + ` the event said ${subscription.status}, Stripe says ${found.status}`);
        }
      }
    } catch (e) {
      throw unverifiable(subscription.id, e);
    }
  }

  const priceId = current.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId);
  const active = ['active', 'trialing', 'past_due'].includes(current.status);
  // The price is checked again on what Stripe holds now, because an upgrade or a
  // migration can move a subscription onto a price we do not sell.
  if (!plan) {
    console.warn(`[stripe] ignoring subscription ${current.id}: price ${priceId} is not a PDFMint plan`);
    return { ignored: 'foreign_price' };
  }

  // A cancellation only speaks for the subscription it names. When an account has
  // since moved to a different subscription, an older one ending must not revoke
  // the current one.
  if (!active && target.stripe_subscription_id && target.stripe_subscription_id !== subscription.id) {
    console.warn(`[stripe] ignoring ${current.status} of stale subscription ${subscription.id};`
      + ` account ${target.id} is on ${target.stripe_subscription_id}`);
    return { ignored: 'stale_subscription' };
  }

  const newPlan = active ? plan : PLANS.free;
  await run(
    `UPDATE accounts SET plan = $2, credits_limit = $3, stripe_subscription_id = $4, stripe_customer_id = COALESCE(stripe_customer_id, $5)
     WHERE id = $1`,
    [target.id, newPlan.id, newPlan.credits, active ? subscription.id : null, customerId || null],
  );
  console.log(`[stripe] account ${target.id} -> plan ${newPlan.id} (${newPlan.credits} credits), sub ${subscription.id} ${current.status}`);
}

async function handleEvent(event) {
  try {
    return await handleEventInTransaction(event);
  } catch (e) {
    // Answered rather than retried, so a continuously-failing endpoint is not
    // disabled and does not take the deliveries that do work with it. Nothing was
    // written and the event id was not consumed: the transaction rolled back.
    if (e && e.stripePermanent) {
      console.error(`[stripe] event ${event.id} (${event.type}) could not be confirmed and never will be; ignoring`);
      return { ignored: 'subscription_unverifiable' };
    }
    throw e;
  }
}

async function handleEventInTransaction(event) {
  return tx(async client => {
  const run = client.query.bind(client);
  const { rowCount } = await run(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return { duplicate: true };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // A completed session is not a paid session. Asynchronous methods finish
      // later, and some finish as a failure; fulfilling here would hand out the
      // quota for a payment that never arrives. `invoice.paid` and
      // `customer.subscription.updated` deliver the real thing.
      if (!['paid', 'no_payment_required'].includes(session.payment_status)) {
        console.warn(`[stripe] session ${session.id} completed but payment_status=${session.payment_status}; not fulfilling`);
        break;
      }
      if (session.subscription) {
        const sub = await confirmSubscription(String(session.subscription));
        if (!sub.metadata?.account_id && session.client_reference_id) {
          sub.metadata = { ...(sub.metadata || {}), account_id: session.client_reference_id };
        }
        // Retrieved from Stripe on the line above, so it is already current.
        await applySubscription(sub, run, { refresh: false });
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
    return res.status(400).json({ error: { code: 'invalid_signature' } });
  }
  const out = await handleEvent(event);
  res.json({ received: true, ...out });
}));

/**
 * C3 — what a return from Checkout is actually allowed to claim.
 *
 * `?checkout=success` is a query parameter. Anyone can type it, a bookmark keeps
 * it, and a shared link carries it. It is not evidence of anything. Neither is
 * "this account is on a paid plan": that only says some earlier payment worked,
 * not that the checkout the customer just came back from was paid.
 *
 * So the page asks Stripe. It resolves the session id that Stripe itself put in
 * the URL, checks the session belongs to this account, checks Stripe considers it
 * paid, and checks our own fulfilment has landed. "Payment received" is returned
 * for exactly one state; everything else gets neutral, honest text.
 */
const CHECKOUT_RETURN = {
  paid: { ok: true, message: 'Payment received. Your new quota is live — it is shown below.' },
  activating: { ok: false, message: 'Payment confirmed. We are activating your plan now — this usually takes a few seconds. Reload this page to see it.' },
  pending: { ok: false, message: 'This checkout is not confirmed yet. Nothing has been charged or activated; your plan below is unchanged.' },
  expired: { ok: false, message: 'That checkout link has expired. Nothing was charged. Choose a plan below to start again.' },
  foreign: { ok: false, message: 'We could not match that checkout to this account. Your plan below is unchanged.' },
  unverified: { ok: false, message: 'We could not confirm a payment for this link. Your plan below is unchanged — if you have just paid, reload in a moment.' },
};

async function verifyCheckoutReturn(account, sessionId) {
  const state = (name, extra = {}) => ({ state: name, ...CHECKOUT_RETURN[name], ...extra });
  // No session id (an old bookmark, a hand-typed URL, a forged link) proves nothing.
  if (!sessionId || typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return state('unverified', { reason: 'no_session_id' });
  }
  if (!enabled()) return state('unverified', { reason: 'billing_disabled' });

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  } catch (e) {
    console.warn(`[stripe] could not verify checkout return ${sessionId}: ${e.message}`);
    return state('unverified', { reason: 'lookup_failed' });
  }

  const claimed = session.client_reference_id || session.metadata?.account_id;
  const sessionCustomer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (String(claimed || '') !== String(account.id)) return state('foreign', { reason: 'account_mismatch' });
  if (account.stripe_customer_id && sessionCustomer && sessionCustomer !== account.stripe_customer_id) {
    return state('foreign', { reason: 'customer_mismatch' });
  }
  // Expiry is a fact about the session and is answered before anything is priced.
  // Stripe does still return `line_items` for an expired session — measured — but
  // an ordering that only works because of that is an ordering waiting to break,
  // and "that link has expired, nothing was charged" is the honest answer either
  // way.
  if (session.status === 'expired') return state('expired');
  // All three products live on ONE Stripe account and all three number their
  // accounts from 1, so a matching account id is not proof either: a sibling
  // product's genuinely paid session would otherwise be accepted here and tell
  // someone who has paid US nothing that their payment is being activated. The
  // line item has to be a price we sell.
  //
  // A price we can read and do not sell is somebody else's. NO price at all is a
  // different thing — we simply could not read the session — and saying "we could
  // not match that checkout to this account" about it accuses the buyer of
  // arriving with someone else's link. Neither answer grants anything; only one
  // of them is true.
  const lineItems = session.line_items?.data || [];
  if (!lineItems.length) return state('unverified', { reason: 'no_line_items' });
  if (!lineItems.some((item) => planForPriceId(item.price?.id))) {
    return state('foreign', { reason: 'not_our_price' });
  }
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) {
    return state('pending', { reason: `payment_status=${session.payment_status}` });
  }

  // Stripe says paid. That still does not mean OUR side has applied it — the
  // webhook may not have landed. Claiming a live quota before the row moved is
  // the same lie in a different place.
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const fulfilled = account.plan !== 'free' && (!subId || account.stripe_subscription_id === subId);
  return fulfilled ? state('paid') : state('activating');
}

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
  handleEvent, ensureCustomer, isUsableCustomer, healStaleCustomers, verifyCheckoutReturn,
  BRAND_NAME,
};
