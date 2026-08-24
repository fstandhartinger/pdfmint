'use strict';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',

  // Rendering limits. These are the numbers quoted in the docs; keep them in sync.
  maxHtmlBytes: num(process.env.MAX_HTML_BYTES, 10 * 1024 * 1024), // 10 MB
  maxRequestBytes: num(process.env.MAX_REQUEST_BYTES, 12 * 1024 * 1024),
  defaultTimeoutMs: num(process.env.DEFAULT_TIMEOUT_MS, 30000),
  maxTimeoutMs: num(process.env.MAX_TIMEOUT_MS, 120000),
  maxConcurrentRenders: num(process.env.MAX_CONCURRENT_RENDERS, 2),
  renderQueueLimit: num(process.env.RENDER_QUEUE_LIMIT, 40),
  fileTtlMinutesDefault: num(process.env.FILE_TTL_MINUTES, 60),
  fileTtlMinutesMax: num(process.env.FILE_TTL_MINUTES_MAX, 10080), // 7 days
  maxStoredFileBytes: num(process.env.MAX_STORED_FILE_BYTES, 20 * 1024 * 1024),

  allowPrivateNetwork: process.env.ALLOW_PRIVATE_NETWORK === '1',

  // Identifies this deployment in the usage log, so the public status page can
  // report on production alone rather than on every process sharing the database.
  origin: process.env.PDFMINT_ORIGIN
    || ((process.env.PUBLIC_URL || '').includes('onrender.com') ? 'production' : 'dev'),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },
};

// Plans. `credits` is PDFs (or images) per calendar month.
const PLANS = {
  // Deliberately small: enough to paste the first curl, wire up an n8n node and
  // see a real PDF, not enough to run a workflow on for free indefinitely.
  free:  { id: 'free',  name: 'Free',  credits: 10,      priceUsd: 0,   stripePriceEnv: null },
  starter:{ id: 'starter', name: 'Starter', credits: 5000,  priceUsd: 9,   stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  pro:   { id: 'pro',   name: 'Pro',   credits: 50000,   priceUsd: 29,  stripePriceEnv: 'STRIPE_PRICE_PRO' },
  scale: { id: 'scale', name: 'Scale', credits: 250000,  priceUsd: 99,  stripePriceEnv: 'STRIPE_PRICE_SCALE' },
};

function planPriceId(planId) {
  const p = PLANS[planId];
  if (!p || !p.stripePriceEnv) return null;
  return process.env[p.stripePriceEnv] || null;
}

module.exports = { config, PLANS, planPriceId };
