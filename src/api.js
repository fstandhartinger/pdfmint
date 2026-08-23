'use strict';

const express = require('express');
const crypto = require('node:crypto');

const { config, PLANS } = require('./config');
const { ApiError, bad } = require('./errors');
const { query } = require('./db');
const { authenticate, consumeCredits, refundCredits, issueApiKey } = require('./auth');
const jobs = require('./jobs');
const { normalisePdfOptions, asBool } = require('./options');
const { rateLimit } = require('./ratelimit');
const { markdownToHtml } = require('./markdown');
const render = require('./render');
const { assertPublicUrl } = require('./net');

const router = express.Router();

/* --------------------------------------------------------------- helpers */

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const authenticateOnly = asyncRoute(async (req, res, next) => {
  req.account = await authenticate(req);
  next();
});

/** Authenticate, then spend one token from the account's rate-limit bucket. */
const withAuth = [authenticateOnly, rateLimit];

function pickSource(body) {
  const given = ['html', 'url', 'markdown', 'template'].filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (given.length === 0) {
    throw bad('missing_content', 'Nothing to render: send one of "html", "markdown", "url" or "template".', {
      hint: 'For example: {"html": "<h1>Hello</h1>"}.',
      docs: '/docs#input',
    });
  }
  if (given.length > 1) {
    throw bad('ambiguous_content', `Send exactly one of "html", "markdown", "url" or "template" — got ${given.join(' and ')}.`, {
      hint: 'Pick the one you meant. If you want a template filled with data, use "template" plus "data".',
      docs: '/docs#input',
    });
  }
  return given[0];
}

const OUTPUT_MODES = ['binary', 'url', 'base64'];
function outputModeFor(body, allowed = OUTPUT_MODES) {
  const mode = String(body.output || 'binary').toLowerCase();
  if (!allowed.includes(mode)) {
    const list = allowed.map((m) => `"${m}"`);
    const readable = list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}` : list[0];
    throw bad('invalid_option', `"output" must be ${readable} — got ${JSON.stringify(body.output)}.`, {
      hint: '"binary" returns the file itself in this response; "url" returns a temporary link; "base64" returns the bytes inside the JSON.',
      docs: '/docs#output',
    });
  }
  return mode;
}

function timeoutFor(body) {
  const raw = body.timeout ?? body.timeoutMs;
  if (raw === undefined || raw === null || raw === '') return config.defaultTimeoutMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) {
    throw bad('invalid_option', `"timeout" must be at least 1000 milliseconds — got ${JSON.stringify(raw)}.`, {
      docs: '/docs#timeout',
    });
  }
  return Math.min(n, config.maxTimeoutMs);
}

function sanitiseFilename(name, fallback) {
  const s = String(name || fallback).trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120);
  return s || fallback;
}

/**
 * Renders a mustache-lite template: {{name}}, {{a.b}}, {{#list}}...{{/list}},
 * {{^empty}}...{{/empty}} and {{{raw}}}. Deliberately tiny and dependency-free.
 */
function fillTemplate(tpl, data) {
  const unresolved = new Set();
  const lookup = (ctxStack, path) => {
    if (path === '.') return ctxStack[ctxStack.length - 1];
    const parts = path.split('.');
    for (let i = ctxStack.length - 1; i >= 0; i -= 1) {
      let cur = ctxStack[i];
      let ok = true;
      for (const p of parts) {
        if (cur !== null && typeof cur === 'object' && p in cur) cur = cur[p];
        else { ok = false; break; }
      }
      if (ok) return cur;
    }
    return undefined;
  };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const sectionRe = /\{\{([#^])\s*([\w.$]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  const renderStr = (str, ctxStack) => {
    let out = str;
    let guard = 0;
    let m;
    while ((m = sectionRe.exec(out)) && guard < 200) {
      guard += 1;
      const [full, kind, name, inner] = m;
      const val = lookup(ctxStack, name);
      let replacement = '';
      if (kind === '#') {
        if (Array.isArray(val)) replacement = val.map((item) => renderStr(inner, ctxStack.concat([item]))).join('');
        else if (val) replacement = renderStr(inner, ctxStack.concat([typeof val === 'object' ? val : {}]));
      } else if (!val || (Array.isArray(val) && val.length === 0)) {
        replacement = renderStr(inner, ctxStack);
      }
      out = out.slice(0, m.index) + replacement + out.slice(m.index + full.length);
    }
    out = out.replace(/\{\{\{\s*([\w.$]+)\s*\}\}\}/g, (_, p) => {
      const v = lookup(ctxStack, p);
      if (v === undefined || v === null) { unresolved.add(p); return ''; }
      return String(v);
    });
    out = out.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, p) => {
      const v = lookup(ctxStack, p);
      if (v === undefined || v === null) { unresolved.add(p); return ''; }
      return esc(v);
    });
    return out;
  };
  const html = renderStr(String(tpl), [data && typeof data === 'object' ? data : {}]);
  return { html, unresolved: Array.from(unresolved) };
}

function parseData(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); }
  catch (e) {
    throw bad('invalid_data', 'The "data" field is a string but is not valid JSON.', {
      hint: '"data" must be a JSON object, or a string containing one.',
      details: { parse_error: String(e.message).slice(0, 160) },
      docs: '/docs#templates',
    });
  }
}

async function storeFile(accountId, buffer, filename, contentType, ttlMinutes) {
  if (buffer.length > config.maxStoredFileBytes) {
    throw bad('file_too_large', `The generated file is ${(buffer.length / 1048576).toFixed(1)} MB, which is over the ${(config.maxStoredFileBytes / 1048576).toFixed(0)} MB limit for hosted files.`, {
      hint: 'Use output "binary" (the default) to get the bytes back directly with no size limit.',
      docs: '/docs#output',
    });
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const ttl = Math.min(Math.max(Number(ttlMinutes) || config.fileTtlMinutesDefault, 1), config.fileTtlMinutesMax);
  await query(
    `INSERT INTO files (token, account_id, filename, content_type, bytes, size, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
    [token, accountId, filename, contentType, buffer, buffer.length, String(ttl)],
  );
  return { token, url: `${config.publicUrl || ''}/f/${token}`, expiresInMinutes: ttl };
}

function logUsage(accountId, kind, ok, extra = {}) {
  query(
    `INSERT INTO usage_events (account_id, kind, pages, duration_ms, ok, error_code) VALUES ($1,$2,$3,$4,$5,$6)`,
    [accountId, kind, extra.pages ?? null, extra.durationMs ?? null, ok, extra.errorCode ?? null],
  ).catch(() => {});
}

/* ------------------------------------------------------------------ /v1/me */

router.get('/me', withAuth, asyncRoute(async (req, res) => {
  const a = req.account;
  const plan = PLANS[a.plan] || PLANS.free;
  const periodStart = new Date(a.period_start);
  const resetAt = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  res.json({
    email: a.email,
    plan: a.plan,
    plan_name: plan.name,
    credits_limit: a.credits_limit,
    credits_used: a.credits_used,
    credits_remaining: Math.max(0, a.credits_limit - a.credits_used),
    period_resets_at: resetAt.toISOString(),
    dashboard_url: `${config.publicUrl || ''}/dashboard`,
  });
}));

/* ----------------------------------------------------------------- /v1/pdf */

/**
 * Builds the render job from a request body. Shared by the synchronous route
 * and the async worker so both behave identically.
 */
async function preparePdf(account, body) {
  const source = pickSource(body);
  const timeoutMs = timeoutFor(body);
  const options = normalisePdfOptions(body.options || body);
  const outputMode = outputModeFor(body);

  let html = null;
  let url = null;
  let unresolved = [];
  if (source === 'html') {
    html = String(body.html);
    const data = body.data ? parseData(body.data) : null;
    if (data) ({ html, unresolved } = fillTemplate(html, data));
  } else if (source === 'markdown') {
    let md = String(body.markdown);
    const data = body.data ? parseData(body.data) : null;
    if (data) {
      const filled = fillTemplate(md, data);
      md = filled.html;
      unresolved = filled.unresolved;
    }
    html = markdownToHtml(md, {
      title: body.metadata?.title || body.title,
      css: body.css,
      googleFonts: body.googleFonts,
    });
  } else if (source === 'url') {
    url = (await assertPublicUrl(String(body.url), 'url')).toString();
  } else if (source === 'template') {
    const { rows } = await query(`SELECT * FROM templates WHERE account_id = $1 AND name = $2`, [account.id, String(body.template)]);
    if (!rows.length) {
      const { rows: all } = await query(`SELECT name FROM templates WHERE account_id = $1 ORDER BY name LIMIT 10`, [account.id]);
      throw bad('template_not_found', `You have no template called "${body.template}".`, {
        hint: all.length
          ? `Templates on this account: ${all.map((t) => t.name).join(', ')}.`
          : 'You have not saved any templates yet. You do not need one — send "html" or "markdown" directly instead.',
        docs: '/docs#templates',
      });
    }
    const tpl = rows[0];
    ({ html, unresolved } = fillTemplate(tpl.html, parseData(body.data)));
    Object.assign(options, normalisePdfOptions({ ...(tpl.options || {}), ...(body.options || {}) }));
  }

  // Every other vendor renders a silently blank document when the data keys do
  // not match the placeholder names. We refuse to do that quietly.
  if (unresolved.length) {
    if (asBool(body.strict, 'strict', false)) {
      throw bad('unresolved_placeholders',
        `The template uses ${unresolved.length} placeholder${unresolved.length === 1 ? '' : 's'} that "data" does not provide: ${unresolved.slice(0, 12).join(', ')}.`, {
          hint: 'Check the spelling against your data, or set "strict": false to render them as empty instead.',
          details: { unresolved },
          docs: '/docs#templates',
        });
    }
    options.warnings.push(`${unresolved.length} placeholder(s) had no value and rendered empty: ${unresolved.slice(0, 12).join(', ')}`);
  }

  if (html && Buffer.byteLength(html, 'utf8') > config.maxHtmlBytes) {
    throw bad('html_too_large', `The HTML is ${(Buffer.byteLength(html, 'utf8') / 1048576).toFixed(1)} MB, over the ${(config.maxHtmlBytes / 1048576).toFixed(0)} MB limit.`, {
      hint: 'Large base64 images inline are the usual cause. Host the images and reference them by URL instead.',
      docs: '/docs#limits',
    });
  }

  return { html, url, options, timeoutMs, outputMode };
}

/** Runs a prepared job and returns the finished buffer plus its facts. */
async function producePdf(account, body, prepared) {
  const { html, url, options, timeoutMs } = prepared;
  const result = await render.render({
    html, url, options, timeoutMs, kind: 'pdf',
    waitFor: body.waitFor,
    debug: asBool(body.debug, 'debug', false),
    javascript: body.javascript,
    emulateDarkMode: asBool(body.emulateDarkMode, 'emulateDarkMode', false),
    headers: body.headers && typeof body.headers === 'object' ? body.headers : undefined,
  });

  let buffer = await render.applyMetadata(result.buffer, body.metadata);
  if (body.watermark) {
    const spec = typeof body.watermark === 'string' ? { text: body.watermark } : body.watermark;
    buffer = await render.addWatermark(buffer, spec);
  }
  if (body.password) {
    buffer = await render.encrypt(buffer, {
      password: String(body.password),
      ownerPassword: body.ownerPassword ? String(body.ownerPassword) : undefined,
      allowPrinting: asBool(body.allowPrinting, 'allowPrinting', true),
      allowCopying: asBool(body.allowCopying, 'allowCopying', false),
    });
  }
  const pages = body.password ? null : await render.countPages(buffer);
  const filename = sanitiseFilename(body.filename, 'document.pdf').replace(/(\.pdf)?$/i, '.pdf');
  return { buffer, pages, filename, durationMs: result.durationMs, debug: result.debug };
}

router.post('/pdf', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const webhookUrl = body.webhookUrl || body.webhook_url;
  const wantsAsync = Boolean(webhookUrl) || asBool(body.async, 'async', false);

  const prepared = await preparePdf(req.account, body);

  if (wantsAsync) {
    if (webhookUrl) await assertPublicUrl(String(webhookUrl), 'webhookUrl');
    const credits = await consumeCredits(req.account.id, 1);
    const jobId = await jobs.enqueue(req.account.id, 'pdf', body, webhookUrl ? String(webhookUrl) : null);
    return res.status(202).json({
      job_id: jobId,
      status: 'queued',
      status_url: `${config.publicUrl || ''}/v1/jobs/${jobId}`,
      webhook_url: webhookUrl ? String(webhookUrl) : undefined,
      credits_remaining: credits.remaining,
    });
  }

  const { options, outputMode } = prepared;
  const credits = await consumeCredits(req.account.id, 1);
  let out;
  try {
    out = await producePdf(req.account, body, prepared);
  } catch (e) {
    await refundCredits(req.account.id, 1);
    logUsage(req.account.id, 'pdf', false, { errorCode: e.code });
    throw e;
  }
  // Storing or encrypting can still fail after the render succeeded. The caller
  // got no document either way, so the credit goes back.
  const refundOnFailure = async (fn) => {
    try { return await fn(); } catch (e) {
      await refundCredits(req.account.id, 1);
      logUsage(req.account.id, 'pdf', false, { errorCode: e.code });
      throw e;
    }
  };
  const { buffer, pages, filename, durationMs, debug } = out;
  logUsage(req.account.id, 'pdf', true, { pages, durationMs });

  res.set({
    'X-PDFMint-Duration-Ms': String(durationMs),
    'X-PDFMint-Credits-Remaining': String(credits.remaining),
    'X-PDFMint-Credits-Limit': String(credits.limit),
  });
  if (pages) res.set('X-PDFMint-Pages', String(pages));
  if (options.warnings.length) res.set('X-PDFMint-Warning', options.warnings.join(' | '));
  if (debug && debug.pageErrors.length) res.set('X-PDFMint-Page-Errors', debug.pageErrors.join(' | ').slice(0, 900));

  if (outputMode === 'binary') {
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.length),
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return res.end(buffer);
  }
  if (outputMode === 'base64') {
    return res.json({
      filename, pages, size: buffer.length,
      duration_ms: durationMs,
      credits_remaining: credits.remaining,
      warnings: options.warnings.length ? options.warnings : undefined,
      debug: debug || undefined,
      base64: buffer.toString('base64'),
    });
  }
  const stored = await refundOnFailure(() => storeFile(req.account.id, buffer, filename, 'application/pdf', body.expiresInMinutes ?? body.expiration));
  return res.json({
    filename, pages, size: buffer.length,
    url: stored.url,
    expires_in_minutes: stored.expiresInMinutes,
    duration_ms: durationMs,
    credits_remaining: credits.remaining,
    warnings: options.warnings.length ? options.warnings : undefined,
    debug: debug || undefined,
  });
}));

router.get('/jobs/:id', withAuth, asyncRoute(async (req, res) => {
  res.json(await jobs.get(req.account.id, String(req.params.id)));
}));

/* --------------------------------------------------------------- /v1/image */

router.post('/image', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const source = pickSource(body);
  if (source === 'template') throw bad('unsupported_source', 'Images can be rendered from "html", "markdown" or "url", not from a saved template.', { docs: '/docs#image' });
  const timeoutMs = timeoutFor(body);
  const imageOutputMode = outputModeFor(body);
  const type = String(body.type || 'png').toLowerCase();
  if (!['png', 'jpeg'].includes(type)) {
    throw bad('invalid_option', `"type" must be "png" or "jpeg" — got ${JSON.stringify(body.type)}.`, { docs: '/docs#image' });
  }

  let html = null; let url = null;
  if (source === 'html') html = String(body.html);
  else if (source === 'markdown') html = markdownToHtml(String(body.markdown), { css: body.css, googleFonts: body.googleFonts });
  else url = (await assertPublicUrl(String(body.url), 'url')).toString();

  const credits = await consumeCredits(req.account.id, 1);
  let result;
  try {
    result = await render.render({
      html, url, timeoutMs, kind: 'image', waitFor: body.waitFor,
      javascript: body.javascript,
      image: {
        type,
        quality: body.quality === undefined ? 85 : Number(body.quality),
        width: Number(body.width) || 1280,
        height: Number(body.height) || 800,
        deviceScaleFactor: Number(body.deviceScaleFactor) || 2,
        fullPage: body.fullPage !== false,
        omitBackground: body.omitBackground === true,
      },
    });
  } catch (e) {
    await refundCredits(req.account.id, 1);
    logUsage(req.account.id, 'image', false, { errorCode: e.code });
    throw e;
  }
  logUsage(req.account.id, 'image', true, { durationMs: result.durationMs });
  const filename = sanitiseFilename(body.filename, `image.${type}`);
  const outputMode = imageOutputMode;
  res.set({ 'X-PDFMint-Duration-Ms': String(result.durationMs), 'X-PDFMint-Credits-Remaining': String(credits.remaining) });
  if (outputMode === 'url') {
    const stored = await storeFile(req.account.id, result.buffer, filename, `image/${type}`, body.expiresInMinutes);
    return res.json({ filename, size: result.buffer.length, url: stored.url, expires_in_minutes: stored.expiresInMinutes, credits_remaining: credits.remaining });
  }
  if (outputMode === 'base64') {
    return res.json({ filename, size: result.buffer.length, base64: result.buffer.toString('base64'), credits_remaining: credits.remaining });
  }
  res.set({ 'Content-Type': `image/${type}`, 'Content-Length': String(result.buffer.length), 'Content-Disposition': `attachment; filename="${filename}"` });
  return res.end(result.buffer);
}));

/* --------------------------------------------------------------- /v1/merge */

router.post('/merge', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const inputs = body.files || body.urls || body.pdfs;
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw bad('invalid_input', '"files" must be an array of at least two PDFs.', {
      hint: 'Each entry is either a public URL string, or {"base64": "..."}.',
      docs: '/docs#merge',
    });
  }
  if (inputs.length > 50) throw bad('too_many_files', `You sent ${inputs.length} files; the limit is 50 per merge.`, { docs: '/docs#merge' });

  const buffers = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const item = inputs[i];
    if (typeof item === 'string' && /^https?:/i.test(item)) {
      const u = await assertPublicUrl(item, `files[${i}]`);
      const resp = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000) }).catch((e) => {
        throw bad('download_failed', `Could not download files[${i}]: ${String(e.message).slice(0, 120)}`, { docs: '/docs#merge' });
      });
      if (!resp.ok) throw bad('download_failed', `files[${i}] returned HTTP ${resp.status}.`, { docs: '/docs#merge' });
      buffers.push(Buffer.from(await resp.arrayBuffer()));
    } else if (item && typeof item === 'object' && item.base64) {
      buffers.push(Buffer.from(String(item.base64), 'base64'));
    } else if (typeof item === 'string') {
      buffers.push(Buffer.from(item, 'base64'));
    } else {
      throw bad('invalid_input', `files[${i}] must be a public URL or {"base64": "..."}.`, { docs: '/docs#merge' });
    }
  }

  const mergeOutputMode = outputModeFor(body);
  const credits = await consumeCredits(req.account.id, 1);
  let merged;
  try {
    merged = await render.mergePdfs(buffers);
  } catch (e) {
    await refundCredits(req.account.id, 1);
    throw e;
  }
  if (body.metadata) merged = await render.applyMetadata(merged, body.metadata);
  const pages = await render.countPages(merged);
  const filename = sanitiseFilename(body.filename, 'merged.pdf').replace(/(\.pdf)?$/i, '.pdf');
  logUsage(req.account.id, 'merge', true, { pages });
  res.set({ 'X-PDFMint-Pages': String(pages), 'X-PDFMint-Credits-Remaining': String(credits.remaining) });
  if (mergeOutputMode === 'url') {
    const stored = await storeFile(req.account.id, merged, filename, 'application/pdf', body.expiresInMinutes);
    return res.json({ filename, pages, size: merged.length, url: stored.url, expires_in_minutes: stored.expiresInMinutes, credits_remaining: credits.remaining });
  }
  if (mergeOutputMode === 'base64') {
    return res.json({ filename, pages, size: merged.length, base64: merged.toString('base64'), credits_remaining: credits.remaining });
  }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(merged.length), 'Content-Disposition': `attachment; filename="${filename}"` });
  return res.end(merged);
}));

/* ------------------------------------------------------------ /v1/templates */

router.get('/templates', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT name, options, updated_at, length(html) AS html_bytes FROM templates WHERE account_id = $1 ORDER BY name`,
    [req.account.id],
  );
  res.json({ templates: rows.map((r) => ({ name: r.name, options: r.options, html_bytes: Number(r.html_bytes), updated_at: r.updated_at })) });
}));

const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

router.put('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const name = String(req.params.name);
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw bad('invalid_template_name', `"${name}" is not a valid template name.`, {
      hint: 'Use 1-64 characters: letters, digits, spaces, dot, dash or underscore. Templates are addressed by this name, not by an opaque id.',
      docs: '/docs#templates',
    });
  }
  const html = req.body?.html;
  if (!html || typeof html !== 'string') throw bad('missing_content', 'Send the template body in "html".', { docs: '/docs#templates' });
  const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
  if (Buffer.byteLength(html, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw bad('template_too_large', `The template is ${(Buffer.byteLength(html, 'utf8') / 1048576).toFixed(1)} MB, over the 2 MB limit.`, {
      hint: 'A template is markup with {{placeholders}} in it. Host images by URL rather than inlining them as base64.',
      docs: '/docs#templates',
    });
  }
  const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
  normalisePdfOptions(options); // validate now rather than at render time
  const { rows } = await query(
    `INSERT INTO templates (account_id, name, html, options) VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id, name) DO UPDATE SET html = EXCLUDED.html, options = EXCLUDED.options, updated_at = now()
     RETURNING name, updated_at`,
    [req.account.id, name, html, JSON.stringify(options)],
  );
  res.json({ template: rows[0], usage: { template: name, data: { example: 'value' } } });
}));

router.get('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(`SELECT name, html, options, updated_at FROM templates WHERE account_id = $1 AND name = $2`, [req.account.id, String(req.params.name)]);
  if (!rows.length) throw bad('template_not_found', `You have no template called "${req.params.name}".`, { docs: '/docs#templates' });
  res.json(rows[0]);
}));

router.delete('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const { rowCount } = await query(`DELETE FROM templates WHERE account_id = $1 AND name = $2`, [req.account.id, String(req.params.name)]);
  if (!rowCount) throw bad('template_not_found', `You have no template called "${req.params.name}".`, { docs: '/docs#templates' });
  res.json({ deleted: req.params.name });
}));

/* ------------------------------------------------------------------ keys */

router.post('/keys', withAuth, asyncRoute(async (req, res) => {
  const key = await issueApiKey(req.account.id, String(req.body?.label || 'default').slice(0, 40));
  res.json({ api_key: key });
}));

async function runJob(job) {
  const { rows } = await query(`SELECT * FROM accounts WHERE id = $1`, [job.account_id]);
  const account = rows[0];
  if (!account) throw new ApiError(404, 'account_gone', 'The account that queued this job no longer exists.');
  const body = job.request;
  const prepared = await preparePdf(account, body);
  let out;
  try {
    out = await producePdf(account, body, prepared);
  } catch (e) {
    await refundCredits(account.id, 1);
    logUsage(account.id, 'pdf', false, { errorCode: e.code });
    throw e;
  }
  const { buffer, pages, filename, durationMs } = out;
  logUsage(account.id, 'pdf', true, { pages, durationMs });
  const stored = await storeFile(account.id, buffer, filename, 'application/pdf', body.expiresInMinutes ?? body.expiration);
  return {
    filename, pages, size: buffer.length,
    url: stored.url,
    expires_in_minutes: stored.expiresInMinutes,
    duration_ms: durationMs,
  };
}

module.exports = { router, fillTemplate, storeFile, runJob };
