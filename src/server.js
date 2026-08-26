'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');

const { config } = require('./config');
const { ApiError } = require('./errors');
const { query } = require('./db');
const { migrate } = require('./migrate');
const api = require('./api');
const billing = require('./billing');
const web = require('./web');
const status = require('./status');
const render = require('./render');
const jobs = require('./jobs');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  res.set('X-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    console.log(`${res.statusCode} ${req.method} ${req.path} ${Date.now() - started}ms id=${req.id}`);
  });
  next();
});

/**
 * One page, one URL. The same site answers on pdfmint-b9tt.onrender.com,
 * mintapis.com and pdf.mintapis.com; without this a search engine sees three
 * copies of every page and has to guess which one is real. Browsers get a 301
 * to the canonical host.
 *
 * Only GET and HEAD, and only outside the API surface: the Stripe webhook, the
 * n8n node and every hosted-file link were issued against whatever host the
 * caller already had, and a redirect would break them. Those keep answering
 * wherever they are asked.
 */
const CANONICAL_HOST = config.publicUrl ? new URL(config.publicUrl).host : '';
const NEVER_REDIRECT = ['/v1/', '/stripe/', '/f/', '/healthz'];

app.use((req, res, next) => {
  if (!CANONICAL_HOST) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (NEVER_REDIRECT.some((p) => req.path === p || req.path.startsWith(p))) return next();
  const host = (req.get('host') || '').toLowerCase();
  if (!host || host === CANONICAL_HOST) return next();
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return next();
  return res.redirect(301, `${config.publicUrl}${req.originalUrl}`);
});

// Stripe signature verification needs the untouched body.
app.use('/stripe', express.raw({ type: 'application/json' }), billing.router);

app.use(express.json({ limit: config.maxRequestBytes }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, ...render.stats() }));

app.get('/f/:token', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT filename, content_type, bytes, size FROM files WHERE token = $1 AND expires_at > now()`,
      [String(req.params.token)],
    );
    if (!rows.length) {
      return res.status(404).type('html').send(web.shell('Link expired', `
        <main class="auth"><a class="logo" href="/">PDF<span>Mint</span></a>
        <h1>This link has expired</h1>
        <p class="sub">Hosted files are deleted when their expiry passes. Generate the document again, or use the default binary output so the bytes come straight back in the response.</p>
        <p class="alt"><a href="/docs#output">Read about output modes</a></p></main>`));
    }
    const f = rows[0];
    res.set({
      'Content-Type': f.content_type,
      'Content-Length': String(f.size),
      'Content-Disposition': `inline; filename="${f.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    });
    res.end(f.bytes);
  } catch (e) { next(e); }
});

app.use('/', status.router);
app.use('/v1', api.router);
app.use('/', web.router);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/v1/')) {
    return res.status(404).json({ error: {
      code: 'unknown_endpoint',
      message: `There is no ${req.method} ${req.path} endpoint.`,
      hint: 'The endpoint list is in the documentation.',
      docs: `${config.publicUrl}/docs`,
      request_id: req.id,
    } });
  }
  res.status(404).type('html').send(web.shell('Not found', `
    <main class="auth"><a class="logo" href="/">PDF<span>Mint</span></a><h1>Not found</h1>
    <p class="sub">There is nothing at <code>${String(req.path).replace(/[<>&]/g, '')}</code>.</p>
    <p class="alt"><a href="/">Home</a> · <a href="/docs">Docs</a></p></main>`));
});

/**
 * Someone who clicked a button in a browser must get a page, not a JSON blob.
 * The request id stays visible so support can still find the log line.
 */
function wantsHtml(req) {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/stripe/')) return false;
  return (req.get('accept') || '').includes('text/html');
}

function errorPage(req, res, status, title, message, opts = {}) {
  const rid = req.id;
  return res.status(status).type('html').send(web.shell(title, `
    <main class="auth">
      <a class="logo" href="/">PDF<span>Mint</span></a>
      <h1>${web.escape(title)}</h1>
      <p class="sub">${web.escape(message)}</p>
      ${opts.hint ? `<p class="sub">${web.escape(opts.hint)}</p>` : ''}
      <p class="alt">
        <a href="${opts.back || '/dashboard'}">${web.escape(opts.backLabel || 'Back to the dashboard')}</a>
        &middot; <a href="/docs">Docs</a>
        &middot; <a href="https://github.com/fstandhartinger/pdfmint/issues" rel="noopener">Report this</a>
      </p>
      <p class="alt" style="font-size:.8rem">Quote this if you get in touch: <code>${web.escape(rid)}</code></p>
    </main>`));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError && wantsHtml(req)) {
    if (err.status >= 500) console.error(`[error] id=${req.id}`, err);
    return errorPage(req, res, err.status, err.status >= 500 ? 'Something went wrong' : 'That did not work', err.message, { hint: err.hint });
  }
  if (err instanceof ApiError) {
    const body = err.toJSON(req.id);
    if (body.error.docs && body.error.docs.startsWith('/')) body.error.docs = `${config.publicUrl}${body.error.docs}`;
    return res.status(err.status).json(body);
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: {
      code: 'request_too_large',
      message: `The request body is larger than the ${(config.maxRequestBytes / 1048576).toFixed(0)} MB limit.`,
      hint: 'Inline base64 images are the usual cause. Host them and reference them by URL instead.',
      docs: `${config.publicUrl}/docs#limits`,
      request_id: req.id,
    } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: {
      code: 'invalid_json',
      message: 'The request body is not valid JSON.',
      hint: 'Check for a trailing comma or an unescaped quote.',
      docs: `${config.publicUrl}/docs`,
      request_id: req.id,
    } });
  }
  console.error(`[error] id=${req.id}`, err);
  if (wantsHtml(req)) {
    return errorPage(req, res, 500, 'Something went wrong', 'This one is on us, not on you. Nothing was charged.', {
      hint: 'Try again in a moment. If it keeps happening, open an issue with the reference below and we can find the exact request in the log.',
    });
  }
  res.status(500).json({ error: {
    code: 'internal_error',
    message: 'Something went wrong on our side.',
    hint: 'If this keeps happening, send us the request id below.',
    request_id: req.id,
  } });
});

/** Deletes expired hosted files. Cheap enough to run in-process. */
function startReaper() {
  const tick = () => query(`DELETE FROM files WHERE expires_at < now()`)
    .then((r) => { if (r.rowCount) console.log(`[reaper] deleted ${r.rowCount} expired files`); })
    .catch((e) => console.warn('[reaper]', e.message));
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 20000).unref();
}

process.on('unhandledRejection', (reason) => {
  console.error('[pdfmint] unhandled rejection (not fatal):', reason && reason.stack ? reason.stack : reason);
});

async function main() {
  await migrate();
  startReaper();
  jobs.startJobReaper();
  // A customer id stored here can stop existing in Stripe. Clear the dead ones at
  // boot so nobody meets a 500 on the way to paying.
  billing.healStaleCustomers().catch((e) => console.warn('[stripe] health check failed:', e.message));
  // The queue lives in the database, so any process pointed at that database would
  // otherwise pick up its jobs — including a developer's laptop, which would stamp
  // its own host onto the result. Only a process that says it is the worker runs it.
  if (process.env.JOBS_WORKER !== '0') {
    jobs.startWorker(api.runJob);
    console.log('[pdfmint] job worker running');
  } else {
    console.log('[pdfmint] job worker disabled (JOBS_WORKER=0)');
  }
  const server = app.listen(config.port, () => {
    console.log(`[pdfmint] listening on :${config.port} (public url: ${config.publicUrl || 'not set'})`);
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  render.warmup()
    .then(() => console.log('[pdfmint] chromium warm'))
    .catch((e) => console.error('[pdfmint] chromium warmup failed:', e.message));

  const shutdown = async (sig) => {
    console.log(`[pdfmint] ${sig}, shutting down`);
    server.close();
    await render.closeBrowser();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { app };
