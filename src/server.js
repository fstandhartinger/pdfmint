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

app.use('/v1', api.router);
app.use('/', web.router);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/v1/')) {
    return res.status(404).json({ error: {
      code: 'unknown_endpoint',
      message: `There is no ${req.method} ${req.path} endpoint.`,
      hint: 'The endpoints are POST /v1/pdf, POST /v1/image, POST /v1/merge, GET /v1/me and /v1/templates.',
      docs: `${config.publicUrl}/docs`,
      request_id: req.id,
    } });
  }
  res.status(404).type('html').send(web.shell('Not found', `
    <main class="auth"><a class="logo" href="/">PDF<span>Mint</span></a><h1>Not found</h1>
    <p class="sub">There is nothing at <code>${String(req.path).replace(/[<>&]/g, '')}</code>.</p>
    <p class="alt"><a href="/">Home</a> · <a href="/docs">Docs</a></p></main>`));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
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
      hint: 'Check for a trailing comma or an unescaped quote. In n8n, use the JSON body mode rather than string concatenation.',
      request_id: req.id,
    } });
  }
  console.error(`[error] id=${req.id}`, err);
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
  jobs.startWorker(api.runJob);
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
