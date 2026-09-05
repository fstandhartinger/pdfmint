'use strict';

const express = require('express');
const crypto = require('node:crypto');

const { config, PLANS } = require('./config');
const { clientOf } = require('./client');
const { ApiError, bad } = require('./errors');
const { query } = require('./db');
const { authenticate, consumeCredits, refundCredits, issueApiKey, revokeApiKey } = require('./auth');
const jobs = require('./jobs');
const { normalisePdfOptions, asBool } = require('./options');
const { rateLimit } = require('./ratelimit');
const { markdownToHtml } = require('./markdown');
const render = require('./render');
const { assertPublicUrl } = require('./net');

const router = express.Router();

/* ------------------------------------------------- Abkuendigung Render-Host */

// Der alte Render-Host bleibt an, weil der einzige zahlende Kunde (Konto 1501)
// noch ueber ihn rendert: elf von elf Aufrufen am 29./30.08. gingen dorthin,
// der letzte vier Minuten nach seiner ersten Zahlung. Ihn abzuschalten haette
// seinen Workflow zerstoert. Also stattdessen dieser Hinweis — nicht brechend,
// nur sichtbar.
//
// Warum ueber die Warnung und nicht per Mail: Kaltakquise am einzigen Kunden
// ist das groessere Risiko. Der n8n-Node blendet `X-PDFMint-Warning` als Feld
// `warning` in seine Ausgabe ein — nachgesehen in 0.1.0 UND 0.3.0, also in jeder
// Version, die er installiert haben kann, und auch im Binaermodus, den er nutzt.
//
// Die Bedingung haengt am Host, nicht an einer Umgebungsvariablen: damit wirkt
// der Block ausschliesslich auf *.onrender.com und auf pdf.mintapis.com
// nachweislich gar nicht. Wenn der Verkehr auf dem alten Host versiegt, kann
// dieser ganze Abschnitt ersatzlos weg.
const LEGACY_HOST_NOTICE = 'This host (pdfmint-b9tt.onrender.com) is being retired. '
  + 'Point the Base URL in your PDFMint credentials at https://pdf.mintapis.com — '
  + 'same API key, same endpoints, nothing else changes.';

router.use((req, res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (!host.includes('onrender.com')) return next();

  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body.warnings = Array.isArray(body.warnings)
        ? [...body.warnings, LEGACY_HOST_NOTICE]
        : [LEGACY_HOST_NOTICE];
    }
    return json(body);
  };

  // Der Binaermodus schickt gar kein JSON — dort ist der Header der einzige Weg
  // nach draussen, und `res.end` ist die letzte Stelle, an der er noch gesetzt
  // werden kann. Ein vorhandener Warntext bleibt stehen, statt ueberschrieben zu
  // werden: die echten Render-Warnungen sind wichtiger als diese hier.
  const end = res.end.bind(res);
  res.end = (...args) => {
    // warningHeader() statt res.set() mit rohem Text: der Hinweis enthaelt einen
    // Gedankenstrich, und Node wirft bei jedem Zeichen ausserhalb von Latin-1 im
    // Headerwert ERR_INVALID_CHAR. Beim ersten Deploy passierte das im
    // on-finished-Listener, also ausserhalb jeder Fehlerbehandlung von Express -
    // der Prozess starb an einer Hoeflichkeitsmeldung. Deshalb zusaetzlich das
    // try/catch: ein Hinweis darf unter keinen Umstaenden einen Request toeten,
    // erst recht nicht auf dem Host des einzigen zahlenden Kunden.
    try {
      if (!res.headersSent) {
        const prev = res.get('X-PDFMint-Warning');
        res.set('X-PDFMint-Warning', warningHeader(prev ? [prev, LEGACY_HOST_NOTICE] : [LEGACY_HOST_NOTICE]));
      }
    } catch { /* lieber ohne Hinweis ausliefern als gar nicht */ }
    return end(...args);
  };
  next();
});

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

function requireSourceString(body, source) {
  if (typeof body[source] !== 'string') {
    throw bad('invalid_option', `"${source}" must be a string — got ${Array.isArray(body[source]) ? 'an array' : typeof body[source]}.`, {
      hint: source === 'html'
        ? 'Send HTML markup as a JSON string, for example {"html":"<h1>Hello</h1>"}.'
        : `Send "${source}" as a JSON string.`,
      docs: '/docs#input',
    });
  }
  return body[source];
}

/**
 * An API that refuses two content fields but silently ignores a typo'd option is
 * inconsistent, and the typo is the case that actually costs someone an hour.
 * Unknown fields are refused, with the closest known field named.
 */
function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Confusions worth naming outright, because edit distance will never catch them. */
const FIELD_ALIASES = {
  format: 'type',           // /v1/image: the image format is "type"
  imageType: 'type',
  fileName: 'filename',
  file_name: 'filename',
  name: 'filename',
  header: 'headerHtml',
  footer: 'footerHtml',
  waitUntil: 'waitFor',
  wait: 'waitFor',
  delay: 'waitFor',
  pageNumber: 'pageNumbers',
  paperFormat: 'format',
  pageSize: 'format',
  orientation: 'landscape',
  background: 'printBackground',
  variables: 'data',
  context: 'data',
  templateId: 'template',
  template_id: 'template',
  callback: 'webhookUrl',
  callbackUrl: 'webhookUrl',
  webhook: 'webhookUrl',
  content: 'html',
  body: 'html',
  source: 'html',
  encrypt: 'password',
};

/**
 * `/v1/pdf` has always taken its settings either flat or inside an `options`
 * object. `/v1/image` and `/v1/merge` only took them flat, so the same wrapper
 * that works on one endpoint answered `400 unknown_field` on its neighbour —
 * one vendor, adjacent endpoints, two contracts. This folds the wrapper into
 * the body so all three behave the same. A flat key wins over the same key
 * inside `options`, because the more specific spelling should not be silently
 * overridden by the more general one.
 */
function foldOptionsWrapper(body) {
  const wrapper = body && body.options;
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return body;
  const { options, ...flat } = body;
  return { ...wrapper, ...flat };
}

function rejectUnknownFields(body, known, where) {
  const unknown = Object.keys(body || {}).filter((k) => !known.has(k));
  if (!unknown.length) return;
  const field = unknown[0];
  const lower = field.toLowerCase();
  const alias = FIELD_ALIASES[field] && known.has(FIELD_ALIASES[field]) ? FIELD_ALIASES[field] : null;
  const near = alias ? { k: alias } : [...known]
    .map((k) => ({ k, d: levenshtein(lower, k.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(field.length / 3)))
    .sort((a, b) => a.d - b.d)[0];
  throw bad('unknown_field',
    `"${field}" is not a field ${where} accepts${unknown.length > 1 ? ` (nor ${unknown.slice(1, 4).map((u) => `"${u}"`).join(', ')})` : ''}.`, {
      hint: near
        ? `Did you mean "${near.k}"?`
        : `Accepted fields: ${[...known].sort().join(', ')}.`,
      details: { unknown },
      docs: '/docs#options',
    });
}

const PDF_FIELDS = new Set([
  'html', 'markdown', 'url', 'template', 'data', 'strict', 'options', 'output', 'filename',
  'timeout', 'timeoutMs', 'waitFor', 'javascript', 'emulateDarkMode', 'headers', 'css',
  'googleFonts', 'metadata', 'password', 'ownerPassword', 'allowPrinting', 'allowCopying',
  'watermark', 'debug', 'expiresInMinutes', 'expiration', 'async', 'webhookUrl', 'webhook_url',
  'title',
  // page options are also accepted at the top level, not only inside "options"
  'format', 'width', 'height', 'landscape', 'margin', 'scale', 'printBackground',
  'headerHtml', 'footerHtml', 'headerTemplate', 'footerTemplate', 'pageNumbers', 'pageRanges',
  'mediaType', 'preferCssPageSize', 'preferCSSPageSize', 'tagged', 'outline',
]);

/**
 * What a STORED template may carry as options. The render endpoints have named
 * their unknown fields since day one, but PUT /v1/templates did not: it ran the
 * options through normalisePdfOptions — which validates the values it knows and
 * ignores keys it does not — so {"fromat": "A5"} was stored with a 200 and then
 * silently ignored on every render after that. The endpoint you call once
 * caught the typo; the one you set up and then render a thousand times from did
 * not. The content keys are absent on purpose: a template's markup lives in
 * "html" next to the options, not inside them.
 */
const TEMPLATE_OPTION_FIELDS = new Set(
  [...PDF_FIELDS].filter((f) => !['html', 'markdown', 'url', 'template', 'data', 'options'].includes(f)),
);

const IMAGE_FIELDS = new Set([
  'html', 'markdown', 'url', 'type', 'output', 'filename', 'quality', 'width', 'height',
  'deviceScaleFactor', 'fullPage', 'omitBackground', 'waitFor', 'timeout', 'timeoutMs',
  'javascript', 'css', 'googleFonts', 'expiresInMinutes', 'strict', 'data',
]);

const MERGE_FIELDS = new Set(['files', 'urls', 'pdfs', 'output', 'filename', 'metadata', 'expiresInMinutes', 'strict']);

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

function timeoutWarning(body) {
  const raw = Number(body.timeout ?? body.timeoutMs);
  if (Number.isFinite(raw) && raw > config.maxTimeoutMs) {
    return `"timeout" was ${raw} ms, above the ${config.maxTimeoutMs} ms maximum, so ${config.maxTimeoutMs} ms was used.`;
  }
  return null;
}

/**
 * The extension has to match the bytes. A caller who asks for "chart" gets
 * "chart.png", exactly as the PDF path appends ".pdf" — without it the file
 * uploads to Drive with no extension and will not preview. A caller who asks for
 * "chart.png" as a JPEG gets "chart.jpeg" and a warning: a file whose name lies
 * about its format is worse than a renamed one.
 */
function imageFilename(requested, type, warnings) {
  const base = sanitiseFilename(requested, `image.${type}`);
  const wrong = /\.(png|jpe?g)$/i.exec(base);
  if (wrong && wrong[1].toLowerCase().replace('jpg', 'jpeg') === type) return base;
  const named = `${base.replace(/\.(png|jpe?g)$/i, '')}.${type}`;
  if (wrong && warnings) warnings.push(`"filename" ended in "${wrong[0]}" but the image is a ${type.toUpperCase()}, so it was named "${named}"`);
  return named;
}

/**
 * A warning is advice, and advice must never be the thing that fails the call.
 * Node refuses a header byte above U+00FF, so one em dash in a warning answered
 * 500 to a request whose document was perfectly fine.
 */
const TYPOGRAPHY = { '\u2014': '-', '\u2013': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...' };
function warningHeader(warnings) {
  return warnings.join(' | ')
    .replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/g, (c) => TYPOGRAPHY[c])
    .replace(/[^\t\x20-\x7e\xa0-\xff]/g, ' ')
    .slice(0, 900);
}

function sanitiseFilename(name, fallback) {
  const s = String(name || fallback).trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120);
  return s || fallback;
}

/**
 * A value that cannot be printed as text. `{{customer}}` where customer is an
 * object puts "[object Object]" on an invoice, and Zapier and Make hand back
 * nested objects from most triggers, so this happens constantly. An array of
 * scalars is fine — `{{tags}}` giving "red,blue" is what the caller meant.
 */
function unprintableType(v) {
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === 'object') ? 'array of objects' : null;
  return 'object';
}

/**
 * Renders a mustache-lite template: {{name}}, {{a.b}}, {{#list}}...{{/list}},
 * {{^empty}}...{{/empty}} and {{{raw}}}. Deliberately tiny and dependency-free.
 *
 * Returns, besides the markup: every name it could not resolve, every name whose
 * value cannot be printed, and every marker it met at all. That last one is what
 * `GET /v1/templates/{name}` reports, so the list a client builds its fields from
 * comes from this exact traversal and cannot drift from what a render does.
 *
 * `opts.escape: false` inserts values raw — for a watermark, which is drawn as
 * text by pdf-lib and would otherwise show a literal "&amp;".
 */
function fillTemplate(tpl, data, opts = {}) {
  const escapeValues = opts.escape !== false;
  // Walk into a repeat block even when no row data exists, so the markers
  // inside it get reported. Only the placeholder scan asks for this; a render
  // must keep leaving an absent section empty.
  const scanSections = opts.scanSections === true;
  const unresolved = new Set();
  const unprintable = new Map();
  const seen = new Map();
  // Two blocks may both use {{amount}} and mean different columns, so the key
  // is the scope and the name together, not the name alone.
  const record = (name, kind, scope) => {
    const key = `${scope || ''}\u0000${name}`;
    if (!seen.has(key)) seen.set(key, scope ? { name, kind, scope } : { name, kind });
  };
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
  const renderStr = (str, ctxStack, scope) => {
    let out = str;
    let guard = 0;
    let m;
    while ((m = sectionRe.exec(out)) && guard < 200) {
      guard += 1;
      const [full, kind, name, inner] = m;
      const val = lookup(ctxStack, name);
      record(name, kind === '#' ? 'section' : 'inverted', scope);
      let replacement = '';
      const rendered = kind === '#'
        ? (Array.isArray(val) ? val.length > 0 : Boolean(val))
        : (!val || (Array.isArray(val) && val.length === 0));
      if (kind === '#') {
        // A key that is present and holds an empty list is a real invoice with
        // no extras. A key that is absent altogether is a misspelling, and the
        // section — usually the whole line-item table — silently disappears.
        if (val === undefined) unresolved.add(name);
        if (Array.isArray(val)) replacement = val.map((item) => renderStr(inner, ctxStack.concat([item]), name)).join('');
        else if (val) replacement = renderStr(inner, ctxStack.concat([typeof val === 'object' ? val : {}]), name);
      } else if (rendered) {
        // An inverted section exists to handle the missing case, so a missing
        // key here is the author doing what the syntax is for, not a mistake.
        replacement = renderStr(inner, ctxStack, scope);
      }
      // Nothing was walked, so the markers inside are still unseen. Walk the
      // body once against an empty row purely to record them; the output is
      // thrown away, and only the scan turns this on.
      if (scanSections && !rendered) renderStr(inner, ctxStack.concat([{}]), kind === '#' ? name : scope);
      out = out.slice(0, m.index) + replacement + out.slice(m.index + full.length);
    }
    out = out.replace(/\{\{\{\s*([\w.$]+)\s*\}\}\}/g, (_, p) => {
      record(p, 'raw', scope);
      const v = lookup(ctxStack, p);
      if (v === undefined || v === null) { unresolved.add(p); return ''; }
      const bad = unprintableType(v);
      if (bad) unprintable.set(p, bad);
      return String(v);
    });
    out = out.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, p) => {
      record(p, 'scalar', scope);
      const v = lookup(ctxStack, p);
      if (v === undefined || v === null) { unresolved.add(p); return ''; }
      const bad = unprintableType(v);
      if (bad) unprintable.set(p, bad);
      return escapeValues ? esc(v) : String(v);
    });
    return out;
  };
  const html = renderStr(String(tpl), [data && typeof data === 'object' ? data : {}], null);
  return {
    html,
    unresolved: Array.from(unresolved),
    unprintable: Array.from(unprintable, ([name, type]) => ({ name, type })),
    placeholders: Array.from(seen.values()),
  };
}

/**
 * Finds the placeholders a source uses, without substituting anything.
 *
 * A request that sent no "data" at all used to skip the scan entirely, so
 * `{"html": "<h1>Hi {{client_name}}</h1>", "strict": true}` came back 200 with
 * the raw token printed on the paper — the exact complaint strict mode exists to
 * answer. Returns null when the source cannot contain a placeholder, so the
 * common case never pays for the scan.
 */
function scanPlaceholders(source) {
  const s = String(source || '');
  if (!s.includes('{{')) return null;
  return fillTemplate(s, {}).unresolved;
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
  // Only the path is stored. The absolute URL is built per response from the host
  // that is actually answering, so a link can never point at whichever instance
  // happened to do the rendering.
  return { token, path: `/f/${token}`, expiresInMinutes: ttl };
}

/** Turns a stored path into an absolute URL for the request currently being answered. */
function absoluteUrl(req, pathname) {
  if (config.publicUrl) return `${config.publicUrl}${pathname}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${proto}://${host}${pathname}` : pathname;
}

function logUsage(accountId, kind, ok, extra = {}) {
  query(
    `INSERT INTO usage_events (account_id, kind, pages, duration_ms, ok, error_code, origin, client)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [accountId, kind, extra.pages ?? null, extra.durationMs ?? null, ok, extra.errorCode ?? null,
     config.origin, extra.client ?? null],
  ).catch(() => {});
}

/* -------------------------------------------------------------- strict mode */

/**
 * The failure Zapier and Make users actually complain about is not an error at
 * all — it is a 200 with a blank or garbled file behind it. Strict mode is the
 * promise that we refuse instead of handing that over.
 *
 * Both markup thresholds are measured on the text *outside* code samples, since
 * a <pre> is the one place a real document shows CSS and tags on purpose. They
 * are still deliberately severe: a false accusation here would be worse than the
 * bug being caught, so a page has to be almost nothing but source to be refused.
 */
const STRICT = {
  markupMinChars: 200,
  markupMinRatio: 0.85,
  markupMinDeclarations: 3,
  tagMinCount: 8,
  tagMinClosing: 3,
  tagMinRatio: 0.3,
  docs: '/docs#strict',
};

/**
 * One greppable line per strict decision, whether strict is on or off. A daily
 * observer reads these to know the check is running and what it decided.
 */
function logStrict(ctx, fields) {
  const parts = [`id=${(ctx && ctx.id) || '-'}`, `endpoint=${(ctx && ctx.endpoint) || '-'}`];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  console.log(`[strict] ${parts.join(' ')}`);
}

/**
 * The placeholder verdict, shared by /v1/pdf and /v1/image so both say the same
 * thing about the same document. `filled` records whether "data" was applied at
 * all: without it the marker is printed exactly as written rather than as an
 * empty string, and an error that got that backwards would send the reader
 * looking in the wrong place.
 */
function gatePlaceholders({ ctx, strict, unresolved = [], unprintable = [], filled, scan, warnings, durationMs }) {
  const n = unresolved.length;
  const names = unresolved.slice(0, 12).join(', ');
  let problem = null;
  if (n && filled) {
    problem = bad('unresolved_placeholders',
      `The template uses ${n} placeholder${n === 1 ? '' : 's'} that "data" does not provide: ${names}.`, {
        hint: 'Check the spelling against your data, or set "strict": false to render them as empty instead.',
        details: { unresolved, data_supplied: true },
        docs: STRICT.docs,
      });
  } else if (n) {
    problem = bad('unresolved_placeholders',
      `The document still contains ${n} unfilled placeholder${n === 1 ? '' : 's'} and the request sent no "data": ${names}.`, {
        hint: `Send the values in "data", for example {"data": {"${unresolved[0]}": "…"}}. With no "data" at all the marker is printed on the page exactly as you wrote it.`,
        details: { unresolved, data_supplied: false },
        docs: STRICT.docs,
      });
  } else if (unprintable.length) {
    const first = unprintable[0];
    problem = bad('invalid_placeholder_value',
      `"${first.name}" is an ${first.type}, so it would print as "[object Object]".`, {
        hint: `A placeholder can only print text or a number. Use a path into the object, such as {{${first.name}.name}}, or build the string before you send it. Triggers in Zapier and Make hand back nested objects, which is where this usually comes from.`,
        details: { unprintable },
        docs: STRICT.docs,
      });
  }
  logStrict(ctx, {
    strict: strict ? 'on' : 'off',
    unresolved: n,
    unprintable: unprintable.length,
    placeholder_scan: scan,
    visible_text_chars: '-',
    images: '-',
    painted: '-',
    markup_ratio: '-',
    tag_ratio: '-',
    verdict: problem ? (strict ? 'rejected' : 'warned') : 'ok',
    reason: problem ? problem.code : 'none',
    ms: durationMs === undefined ? '-' : durationMs,
  });
  if (!problem) return null;
  if (strict) return problem;
  if (warnings) {
    if (n) {
      warnings.push(filled
        ? `${n} placeholder(s) had no value and rendered empty: ${names}`
        : `${n} placeholder(s) are printed on the page exactly as written because no "data" was sent: ${names}`);
    }
    for (const u of unprintable) {
      warnings.push(`"${u.name}" is an ${u.type} and printed as "[object Object]" — use a path into it, such as {{${u.name}.name}}`);
    }
  }
  return null;
}

const BLANK_TEXT = {
  pdf: {
    message: 'The rendered document body contains no visible text and no images, so the pages would come out blank.',
    hint: 'Check that "data" really filled the template, that anything built by JavaScript has finished (use "waitFor"), and that a print stylesheet is not hiding the content. A header or footer does not count as content. Send "strict": false to receive the blank document anyway.',
  },
  image: {
    message: 'The rendered page contains no visible text and no images, so the screenshot would come out blank.',
    hint: 'Check that the markup has content, and that anything built by JavaScript has finished (use "waitFor"). Send "strict": false to receive the blank image anyway.',
  },
};

/**
 * Turns the measurements taken inside Chromium into a verdict. Returns the error
 * that describes what is wrong with the document, or null when it is fine.
 * A measurement we could not take is never a reason to refuse anything.
 */
function contentProblem(content, kind, extra = {}) {
  if (!content || content.error) return null;
  if (content.textChars === 0 && content.images === 0 && content.painted === 0 && !content.truncated) {
    const t = BLANK_TEXT[kind] || BLANK_TEXT.pdf;
    return bad('blank_document', t.message, {
      hint: t.hint,
      details: { visible_text_chars: 0, images: 0, painted_elements: 0, ...extra },
      docs: STRICT.docs,
    });
  }
  const markupHint = 'The markup was almost certainly HTML-escaped somewhere on the way here, or a <style> tag lost its brackets, so the source arrived as text. In Zapier or Make, map the raw field rather than a formatted one. Send "strict": false to print it as it is.';
  const markupDetails = {
    visible_text_chars: content.textChars,
    analysed_chars: content.proseChars,
    markup_ratio: Number((content.markupRatio || 0).toFixed(3)),
    tag_ratio: Number((content.tagRatio || 0).toFixed(3)),
    css_declarations: content.declarations,
    literal_tags: content.tags,
  };
  // Two different accidents, so two different measurements. A leaked stylesheet
  // is CSS all the way down; escaped markup is prose with tags printed through it.
  if (content.proseChars >= STRICT.markupMinChars
      && content.markupRatio >= STRICT.markupMinRatio
      && content.declarations >= STRICT.markupMinDeclarations) {
    return bad('unrendered_markup',
      `${Math.round(content.markupRatio * 100)}% of the visible text is raw CSS — the stylesheet was printed instead of being applied.`, {
        hint: markupHint, details: markupDetails, docs: STRICT.docs,
      });
  }
  if (content.tags >= STRICT.tagMinCount
      && content.closingTags >= STRICT.tagMinClosing
      && content.tagRatio >= STRICT.tagMinRatio) {
    return bad('unrendered_markup',
      `The document shows ${content.tags} HTML tags as literal text — the markup was printed instead of being applied.`, {
        hint: markupHint, details: markupDetails, docs: STRICT.docs,
      });
  }
  return null;
}

const orDash = (v) => (v === undefined || v === null ? '-' : v);

/**
 * Decides, logs, and in strict mode hands back the error to throw. A caller who
 * did not ask to be protected still gets told, as a warning — being quiet about
 * a document we know looks blank is the behaviour we are selling against.
 */
function gateContent({ ctx, strict, content, kind, unresolved = 0, scan = '-', warnings, durationMs, extra }) {
  const problem = contentProblem(content, kind, extra);
  const c = content || {};
  logStrict(ctx, {
    strict: strict ? 'on' : 'off',
    unresolved,
    unprintable: '-',
    placeholder_scan: scan,
    visible_text_chars: c.error ? '-' : orDash(c.textChars),
    images: c.error ? '-' : orDash(c.images),
    painted: c.error ? '-' : orDash(c.painted),
    markup_ratio: c.error ? '-' : (typeof c.markupRatio === 'number' ? c.markupRatio.toFixed(2) : '-'),
    tag_ratio: c.error ? '-' : (typeof c.tagRatio === 'number' ? c.tagRatio.toFixed(2) : '-'),
    verdict: problem ? (strict ? 'rejected' : 'warned') : 'ok',
    // A "0 painted, but fine" line would otherwise read as a contradiction: say
    // outright when the paint scan was skipped for being too big to trust.
    reason: problem ? problem.code : (c.error ? 'not_measured' : (c.truncated ? 'paint_scan_skipped' : 'none')),
    ms: durationMs === undefined ? '-' : durationMs,
    check_ms: orDash(c.ms),
  });
  if (!problem) return null;
  if (strict) return problem;
  if (warnings) warnings.push(`${problem.message} Set "strict": true to make this an error instead.`);
  return null;
}

/**
 * A merge has no page to look at, so the equivalent question is whether any
 * pages came out — in total, and from each input. An input that contributed
 * nothing is the merge version of the same silent failure.
 */
function gateMerge({ ctx, strict, pageCounts, warnings, durationMs }) {
  const total = pageCounts.reduce((a, b) => a + b, 0);
  const emptyIndex = pageCounts.findIndex((n) => n === 0);
  let problem = null;
  if (total === 0) {
    problem = bad('blank_document', 'The merged document has no pages: every input was an empty PDF.', {
      hint: 'Check that the inputs are the documents you meant to merge. Send "strict": false to receive the empty document anyway.',
      details: { pages: 0, page_counts: pageCounts },
      docs: STRICT.docs,
    });
  } else if (emptyIndex >= 0) {
    problem = bad('blank_document', `files[${emptyIndex}] is a valid PDF with no pages, so it contributed nothing to the merge.`, {
      hint: 'That input is empty — check what produced it. Send "strict": false to merge the remaining inputs anyway.',
      details: { input_index: emptyIndex, pages: 0, page_counts: pageCounts },
      docs: STRICT.docs,
    });
  }
  logStrict(ctx, {
    strict: strict ? 'on' : 'off',
    unresolved: '-',
    unprintable: '-',
    placeholder_scan: '-',
    visible_text_chars: '-',
    images: '-',
    painted: '-',
    markup_ratio: '-',
    tag_ratio: '-',
    inputs: pageCounts.length,
    pages: total,
    empty_inputs: pageCounts.filter((n) => n === 0).length,
    verdict: problem ? (strict ? 'rejected' : 'warned') : 'ok',
    reason: problem ? problem.code : 'none',
    ms: durationMs === undefined ? '-' : durationMs,
  });
  if (!problem) return null;
  if (strict) return problem;
  if (warnings) warnings.push(`${problem.message} Set "strict": true to make this an error instead.`);
  return null;
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
async function preparePdf(account, rawBody, ctx = {}) {
  const startedAt = Date.now();
  // Fold "options" into the body the way /v1/image and /v1/merge already do.
  // Without it a caller who sent page options flat had them computed and then
  // thrown away by a saved template's stored options, and a "waitFor" inside
  // the wrapper was read by one endpoint and ignored by its neighbour.
  const body = foldOptionsWrapper(rawBody || {});
  rejectUnknownFields(body, PDF_FIELDS, 'POST /v1/pdf');
  // Read once, up front: a "strict": "maybe" must be refused whether or not the
  // document happens to have anything wrong with it.
  const strict = asBool(body.strict, 'strict', false);
  const source = pickSource(body);
  const timeoutMs = timeoutFor(body);
  const options = normalisePdfOptions(body);
  const outputMode = outputModeFor(body);

  let html = null;
  let url = null;
  // Whether "data" was applied at all, and what the placeholder scan did. Both
  // reach the caller: a marker rendered empty and a marker printed as written
  // are different failures with different fixes.
  let dataApplied = false;
  let scan = 'none';
  const data = body.data ? parseData(body.data) : null;
  const unresolved = [];
  const unprintable = [];
  const collect = (r) => {
    for (const n of r.unresolved) if (!unresolved.includes(n)) unresolved.push(n);
    for (const u of r.unprintable) if (!unprintable.some((x) => x.name === u.name)) unprintable.push(u);
    return r;
  };

  /**
   * Fills one fragment that is not the body — a header, a footer, a watermark.
   * These went to the renderer raw, so "Invoice {{invoice_number}}" printed on
   * every page with strict on and data supplied. With no data at all the bytes
   * are left exactly as they were, and the markers are only reported.
   */
  const fillPart = (text, escape = true) => {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    const r = collect(fillTemplate(text, data || {}, { escape }));
    if (scan === 'none') scan = dataApplied ? 'filled' : 'scanned';
    return data ? r.html : text;
  };

  if (source === 'html') {
    html = requireSourceString(body, source);
    if (data) {
      html = collect(fillTemplate(html, data)).html;
      dataApplied = true;
      scan = 'filled';
    } else if (html.includes('{{')) {
      collect(fillTemplate(html, {}));
      scan = 'scanned';
    }
  } else if (source === 'markdown') {
    let md = requireSourceString(body, source);
    if (data) {
      md = collect(fillTemplate(md, data)).html;
      dataApplied = true;
      scan = 'filled';
    } else if (md.includes('{{')) {
      collect(fillTemplate(md, {}));
      scan = 'scanned';
    }
    html = markdownToHtml(md, {
      title: body.metadata?.title || body.title,
      css: body.css,
      googleFonts: body.googleFonts,
    });
  } else if (source === 'url') {
    url = (await assertPublicUrl(requireSourceString(body, source), 'url')).toString();
  } else if (source === 'template') {
    const templateName = requireSourceString(body, source);
    const { rows } = await query(`SELECT * FROM templates WHERE account_id = $1 AND name = $2`, [account.id, templateName]);
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
    // A saved template is always filled, even from an empty object: asking for a
    // template is asking for substitution, whether or not values came with it.
    html = collect(fillTemplate(tpl.html, parseData(body.data))).html;
    dataApplied = true;
    scan = 'filled';
    // The template's stored options are defaults. The request wins over them —
    // it is the more specific statement of intent, and it arrived later.
    Object.assign(options, normalisePdfOptions({ ...(tpl.options || {}), ...body }));
  }

  // A header, a footer and a watermark are content too, and are filled from the
  // same data as the body. Done after the template branch, because a template
  // can carry its own headerHtml and it must be filled as well.
  if (options.displayHeaderFooter) {
    options.headerTemplate = fillPart(options.headerTemplate);
    options.footerTemplate = fillPart(options.footerTemplate);
  }
  let watermark = null;
  if (body.watermark) {
    const spec = typeof body.watermark === 'string' ? { text: body.watermark } : { ...body.watermark };
    // Drawn as text by pdf-lib, not as markup, so escaping it would print a
    // literal "&amp;" across the page.
    if (typeof spec.text === 'string') spec.text = fillPart(spec.text, false);
    watermark = spec;
  }

  // Every other vendor renders a silently blank document when the data keys do
  // not match the placeholder names. We refuse to do that quietly.
  if (unresolved.length || unprintable.length) {
    const problem = gatePlaceholders({
      ctx, strict, unresolved, unprintable, filled: dataApplied, scan,
      warnings: options.warnings, durationMs: Date.now() - startedAt,
    });
    if (problem) throw problem;
  }

  if (html && Buffer.byteLength(html, 'utf8') > config.maxHtmlBytes) {
    throw bad('html_too_large', `The HTML is ${(Buffer.byteLength(html, 'utf8') / 1048576).toFixed(1)} MB, over the ${(config.maxHtmlBytes / 1048576).toFixed(0)} MB limit.`, {
      hint: 'Large base64 images inline are the usual cause. Host the images and reference them by URL instead.',
      docs: '/docs#limits',
    });
  }

  const clamped = timeoutWarning(body);
  if (clamped) options.warnings.push(clamped);

  return { html, url, options, timeoutMs, outputMode, strict, scan, watermark, unresolved: unresolved.length };
}

/** Runs a prepared job and returns the finished buffer plus its facts. */
async function producePdf(account, body, prepared, ctx = {}) {
  const { html, url, options, timeoutMs, strict, unresolved, scan } = prepared;
  const result = await render.render({
    html, url, options, timeoutMs, kind: 'pdf',
    waitFor: body.waitFor,
    debug: asBool(body.debug, 'debug', false),
    javascript: body.javascript,
    emulateDarkMode: asBool(body.emulateDarkMode, 'emulateDarkMode', false),
    headers: body.headers && typeof body.headers === 'object' ? body.headers : undefined,
  });

  // Before anything is stamped onto it: if there is nothing on the page, saying
  // so is worth more than a metadata-perfect blank PDF.
  const problem = gateContent({
    ctx, strict, content: result.content, kind: 'pdf', unresolved, scan,
    warnings: options.warnings, durationMs: result.durationMs,
    extra: options.displayHeaderFooter ? { header_or_footer: true } : undefined,
  });
  if (problem) throw problem;

  let buffer = await render.applyMetadata(result.buffer, body.metadata);
  // prepared.watermark, not body.watermark: the text has had its placeholders
  // filled from the same data as the rest of the document.
  if (prepared.watermark) buffer = await render.addWatermark(buffer, prepared.watermark);
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

/**
 * The demo render: no key, no account, no credits.
 *
 * A blind critic comparing this landing page against a competitor's named the
 * same gap that kills the page: every number on it is asserted by a vendor with
 * no track record, and the hero `curl` needs `pm_live_YOUR_KEY`, so a reader
 * cannot check a single claim inside the ninety seconds they are giving us.
 * Someone who gets a real PDF on disk before creating an account has already
 * decided.
 *
 * It is deliberately the narrowest possible endpoint, because an unauthenticated
 * renderer is an abuse surface:
 *   - `html` and nothing else. No `url`, so there is no SSRF reachable here at
 *     all; no `template`, so it never touches anyone's data; no options, so no
 *     option can be turned into a resource attack.
 *   - a hard size cap well under anything that could exhaust the one render slot
 *   - a per-IP hourly budget, in memory, which is the honest implementation for
 *     a single instance
 *   - synchronous only: no jobs, no webhooks, nothing that outlives the request
 */
const DEMO_MAX_HTML_BYTES = 16 * 1024;
const DEMO_PER_IP_PER_HOUR = 5;

/**
 * The demo budget lives in Postgres, not in memory.
 *
 * It was an in-memory Map first, and that was wrong in a way only production
 * showed: the service runs more than one process, each got its own Map, and the
 * remaining-counter came back 1, 3, 0, 3 across four consecutive calls. The
 * published limit of five an hour was really five times however many instances
 * were up. A documented number that is not true is the same defect as a
 * benchmark nobody can reproduce.
 *
 * One upsert per request, keyed by address and hour, and the returning value is
 * the authoritative count. The row is tiny and old hours are swept below.
 */
/**
 * The client address for the demo budget.
 *
 * `req.ip` was wrong here and production proved it: the counter came back
 * 4, 4, 4, 3, 3, 2 for six calls from one machine, meaning several distinct keys.
 * `trust proxy` is 1, so Express walks back exactly one hop, and Render has more
 * than one — leaving an intermediate address that varies. The leftmost
 * X-Forwarded-For entry is the original client, which is the thing the published
 * "five an hour per address" is actually about.
 *
 * Falls back to req.ip when the header is absent, e.g. running locally.
 */
function demoClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return String(req.ip || req.connection?.remoteAddress || 'unknown');
}

async function demoTake(ip) {
  const { rows } = await query(
    `INSERT INTO demo_usage (ip, hour_start, used)
     VALUES ($1, date_trunc('hour', now()), 1)
     ON CONFLICT (ip, hour_start) DO UPDATE SET used = demo_usage.used + 1
     RETURNING used, hour_start`,
    [ip],
  );
  const used = rows[0].used;
  const resetAt = new Date(rows[0].hour_start).getTime() + 3600_000;
  if (used > DEMO_PER_IP_PER_HOUR) {
    return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
  }
  return { ok: true, remaining: DEMO_PER_IP_PER_HOUR - used };
}

// Old hours are dead weight; drop them occasionally rather than never.
setInterval(() => {
  query(`DELETE FROM demo_usage WHERE hour_start < now() - interval '3 hours'`).catch(() => {});
}, 1800_000).unref();

router.post('/demo/pdf', asyncRoute(async (req, res) => {
  const ip = demoClientIp(req);
  const budget = await demoTake(ip);
  res.set('X-PDFMint-Demo-Remaining', String(budget.remaining));
  if (!budget.ok) {
    res.set('Retry-After', String(budget.retryAfterSeconds));
    // bad() is hardcoded to 400, so the status is set explicitly here.
    throw new ApiError(429, 'demo_limit_reached',
      `The keyless demo allows ${DEMO_PER_IP_PER_HOUR} renders an hour from one address.`, {
        hint: 'Create a free account for 10 documents a month, no card: https://pdf.mintapis.com/signup',
        docs: '/docs',
      });
  }

  const html = (req.body || {}).html;
  if (typeof html !== 'string' || !html.trim()) {
    throw bad('missing_content', 'Send the markup you want rendered in "html".', {
      hint: `curl -X POST ${'https://pdf.mintapis.com'}/v1/demo/pdf -H "Content-Type: application/json" -d '{"html":"<h1>Hello</h1>"}' -o hello.pdf`,
      docs: '/docs',
    });
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > DEMO_MAX_HTML_BYTES) {
    throw new ApiError(413, 'demo_payload_too_large',
      `The demo accepts ${DEMO_MAX_HTML_BYTES} bytes of HTML; this was ${bytes}.`, {
        hint: 'The full API has no such limit. A free account takes about twenty seconds: https://pdf.mintapis.com/signup',
        docs: '/docs',
      });
  }

  // Only `html` is honoured. Anything else the caller sent is ignored on purpose.
  const body = { html };
  const ctx = { id: req.id, endpoint: '/v1/demo/pdf' };
  const demoAccount = { id: null, plan: 'demo' };
  const prepared = await preparePdf(demoAccount, body, ctx);
  const out = await producePdf(demoAccount, body, prepared, ctx);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': String(out.buffer.length),
    'Content-Disposition': 'attachment; filename="hello.pdf"',
    'X-PDFMint-Duration-Ms': String(out.durationMs),
  });
  if (out.pages) res.set('X-PDFMint-Pages', String(out.pages));
  return res.end(out.buffer);
}));

router.post('/pdf', withAuth, asyncRoute(async (req, res) => {
  const body = foldOptionsWrapper(req.body || {});
  const webhookUrl = body.webhookUrl || body.webhook_url;
  const wantsAsync = Boolean(webhookUrl) || asBool(body.async, 'async', false);

  const ctx = { id: req.id, endpoint: '/v1/pdf' };
  const prepared = await preparePdf(req.account, body, ctx);

  if (wantsAsync) {
    if (webhookUrl) await assertPublicUrl(String(webhookUrl), 'webhookUrl');
    const credits = await consumeCredits(req.account.id, 1);
    const jobId = await jobs.enqueue(req.account.id, 'pdf', body, webhookUrl ? String(webhookUrl) : null,
      clientOf(req));
    return res.status(202).json({
      job_id: jobId,
      status: 'queued',
      status_url: absoluteUrl(req, `/v1/jobs/${jobId}`),
      webhook_url: webhookUrl ? String(webhookUrl) : undefined,
      credits_remaining: credits.remaining,
    });
  }

  const { options, outputMode } = prepared;
  const credits = await consumeCredits(req.account.id, 1);
  let out;
  try {
    out = await producePdf(req.account, body, prepared, ctx);
  } catch (e) {
    await refundCredits(req.account.id, 1);
    logUsage(req.account.id, 'pdf', false, { errorCode: e.code, client: clientOf(req) });
    throw e;
  }
  // Storing or encrypting can still fail after the render succeeded. The caller
  // got no document either way, so the credit goes back.
  const refundOnFailure = async (fn) => {
    try { return await fn(); } catch (e) {
      await refundCredits(req.account.id, 1);
      logUsage(req.account.id, 'pdf', false, { errorCode: e.code, client: clientOf(req) });
      throw e;
    }
  };
  const { buffer, pages, filename, durationMs, debug } = out;
  logUsage(req.account.id, 'pdf', true, { pages, durationMs, client: clientOf(req) });

  res.set({
    'X-PDFMint-Duration-Ms': String(durationMs),
    'X-PDFMint-Credits-Remaining': String(credits.remaining),
    'X-PDFMint-Credits-Limit': String(credits.limit),
  });
  if (pages) res.set('X-PDFMint-Pages', String(pages));
  if (options.warnings.length) res.set('X-PDFMint-Warning', warningHeader(options.warnings));
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
    url: absoluteUrl(req, stored.path),
    expires_in_minutes: stored.expiresInMinutes,
    duration_ms: durationMs,
    credits_remaining: credits.remaining,
    warnings: options.warnings.length ? options.warnings : undefined,
    debug: debug || undefined,
  });
}));

router.delete('/jobs/:id', withAuth, asyncRoute(async (req, res) => {
  res.json(await jobs.cancel(req.account.id, String(req.params.id)));
}));

router.get('/jobs/:id', withAuth, asyncRoute(async (req, res) => {
  const job = await jobs.get(req.account.id, String(req.params.id));
  if (job.file_path) {
    job.url = absoluteUrl(req, job.file_path);
    delete job.file_path;
  }
  res.json(job);
}));

/* --------------------------------------------------------------- /v1/image */

router.post('/image', withAuth, asyncRoute(async (req, res) => {
  const body = foldOptionsWrapper(req.body || {});
  const source = pickSource(body);
  if (source === 'template') throw bad('unsupported_source', 'Images can be rendered from "html", "markdown" or "url", not from a saved template.', { docs: '/docs#image' });
  const timeoutMs = timeoutFor(body);
  rejectUnknownFields(body, IMAGE_FIELDS, 'POST /v1/image');
  const strict = asBool(body.strict, 'strict', false);
  const warnings = [];
  const ctx = { id: req.id, endpoint: '/v1/image' };
  const imageOutputMode = outputModeFor(body);
  const type = String(body.type || 'png').toLowerCase();
  if (!['png', 'jpeg'].includes(type)) {
    throw bad('invalid_option', `"type" must be "png" or "jpeg" — got ${JSON.stringify(body.type)}.`, { docs: '/docs#image' });
  }

  // Placeholders work here exactly as they do on /v1/pdf. They did not before,
  // so "Hello {{first_name}}" was screenshotted as written — one vendor, two
  // contracts on adjacent endpoints.
  const data = body.data ? parseData(body.data) : null;
  let html = null; let url = null; let sourceText = null;
  if (source === 'html') sourceText = requireSourceString(body, source);
  else if (source === 'markdown') sourceText = requireSourceString(body, source);
  else url = (await assertPublicUrl(requireSourceString(body, source), 'url')).toString();

  let dataApplied = false;
  let scan = 'none';
  let filledUnresolved = [];
  let filledUnprintable = [];
  if (sourceText !== null && (data || sourceText.includes('{{'))) {
    const r = fillTemplate(sourceText, data || {});
    filledUnresolved = r.unresolved;
    filledUnprintable = r.unprintable;
    if (data) { sourceText = r.html; dataApplied = true; scan = 'filled'; } else scan = 'scanned';
  }
  if (sourceText !== null) {
    html = source === 'markdown'
      ? markdownToHtml(sourceText, { css: body.css, googleFonts: body.googleFonts })
      : sourceText;
  }

  // Checked before the credit is spent, so there is nothing to refund.
  if (filledUnresolved.length || filledUnprintable.length) {
    const problem = gatePlaceholders({
      ctx, strict, unresolved: filledUnresolved, unprintable: filledUnprintable,
      filled: dataApplied, scan, warnings, durationMs: 0,
    });
    if (problem) throw problem;
  }

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
    // Inside the try so a refusal refunds by the same path a crash does.
    const problem = gateContent({
      ctx, strict, content: result.content, kind: 'image', warnings, durationMs: result.durationMs,
      scan,
    });
    if (problem) throw problem;
  } catch (e) {
    await refundCredits(req.account.id, 1);
    logUsage(req.account.id, 'image', false, { errorCode: e.code, client: clientOf(req) });
    throw e;
  }
  logUsage(req.account.id, 'image', true, { durationMs: result.durationMs, client: clientOf(req) });
  const filename = imageFilename(body.filename, type, warnings);
  const outputMode = imageOutputMode;
  res.set({ 'X-PDFMint-Duration-Ms': String(result.durationMs), 'X-PDFMint-Credits-Remaining': String(credits.remaining) });
  if (warnings.length) res.set('X-PDFMint-Warning', warningHeader(warnings));
  if (outputMode === 'url') {
    const stored = await storeFile(req.account.id, result.buffer, filename, `image/${type}`, body.expiresInMinutes);
    return res.json({ filename, size: result.buffer.length, url: absoluteUrl(req, stored.path), expires_in_minutes: stored.expiresInMinutes, credits_remaining: credits.remaining, warnings: warnings.length ? warnings : undefined });
  }
  if (outputMode === 'base64') {
    return res.json({ filename, size: result.buffer.length, base64: result.buffer.toString('base64'), credits_remaining: credits.remaining, warnings: warnings.length ? warnings : undefined });
  }
  res.set({ 'Content-Type': `image/${type}`, 'Content-Length': String(result.buffer.length), 'Content-Disposition': `attachment; filename="${filename}"` });
  return res.end(result.buffer);
}));

/* --------------------------------------------------------------- /v1/merge */

router.post('/merge', withAuth, asyncRoute(async (req, res) => {
  const body = foldOptionsWrapper(req.body || {});
  rejectUnknownFields(body, MERGE_FIELDS, 'POST /v1/merge');
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
  const strict = asBool(body.strict, 'strict', false);
  const warnings = [];
  const ctx = { id: req.id, endpoint: '/v1/merge' };
  const credits = await consumeCredits(req.account.id, 1);
  const startedAt = Date.now();
  let merged;
  try {
    const out = await render.mergePdfs(buffers);
    const problem = gateMerge({
      ctx, strict, pageCounts: out.pageCounts, warnings, durationMs: Date.now() - startedAt,
    });
    if (problem) throw problem;
    merged = out.buffer;
  } catch (e) {
    await refundCredits(req.account.id, 1);
    logUsage(req.account.id, 'merge', false, { errorCode: e.code, client: clientOf(req) });
    throw e;
  }
  if (body.metadata) merged = await render.applyMetadata(merged, body.metadata);
  const pages = await render.countPages(merged);
  const filename = sanitiseFilename(body.filename, 'merged.pdf').replace(/(\.pdf)?$/i, '.pdf');
  logUsage(req.account.id, 'merge', true, { pages, client: clientOf(req) });
  res.set({ 'X-PDFMint-Pages': String(pages), 'X-PDFMint-Credits-Remaining': String(credits.remaining) });
  if (warnings.length) res.set('X-PDFMint-Warning', warningHeader(warnings));
  if (mergeOutputMode === 'url') {
    const stored = await storeFile(req.account.id, merged, filename, 'application/pdf', body.expiresInMinutes);
    return res.json({ filename, pages, size: merged.length, url: absoluteUrl(req, stored.path), expires_in_minutes: stored.expiresInMinutes, credits_remaining: credits.remaining, warnings: warnings.length ? warnings : undefined });
  }
  if (mergeOutputMode === 'base64') {
    return res.json({ filename, pages, size: merged.length, base64: merged.toString('base64'), credits_remaining: credits.remaining, warnings: warnings.length ? warnings : undefined });
  }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(merged.length), 'Content-Disposition': `attachment; filename="${filename}"` });
  return res.end(merged);
}));

/**
 * Every placeholder a stored template uses, so a client — the n8n node, the
 * Zapier app, the Make module — can put one input field on screen per marker
 * instead of asking the user to retype names from memory. Retyping is what
 * causes the misspelling that strict mode then catches at run time, and making
 * the mistake impossible beats reporting it.
 *
 * Derived by running the template through fillTemplate with no data, so this
 * list and what a render reports as unresolved come from the same traversal and
 * cannot drift apart. A header or footer stored with the template is scanned too,
 * because those are filled at render time as well.
 */
function templatePlaceholders(html, options) {
  const seen = new Map();
  const scan = (text) => {
    if (typeof text !== 'string' || !text.includes('{{')) return;
    for (const ph of fillTemplate(text, {}, { scanSections: true }).placeholders) {
      const key = `${ph.scope || ''}\u0000${ph.name}`;
      if (!seen.has(key)) seen.set(key, ph);
    }
  };
  scan(html);
  const o = options && typeof options === 'object' ? options : {};
  scan(o.headerHtml || o.headerTemplate);
  scan(o.footerHtml || o.footerTemplate);
  scan(typeof o.watermark === 'string' ? o.watermark : (o.watermark && o.watermark.text));
  return Array.from(seen.values());
}

/**
 * A copy-paste "data" object of the right SHAPE, not just the right names.
 *
 * The old version mapped every marker to the string "value", so a template with
 * a line-item table suggested {"items": "value"} — and a string is exactly what
 * a repeat block cannot take. Whoever pasted it got an invoice with no rows and
 * no error, because a present-but-not-an-array section renders once and empty.
 * A section now comes back as a one-row array carrying that block's own fields.
 */
function templateUsageData(placeholders) {
  const top = {};
  const rows = new Map();
  for (const ph of placeholders) {
    if (ph.scope) {
      if (!rows.has(ph.scope)) rows.set(ph.scope, {});
      if (ph.kind !== 'section' && ph.kind !== 'inverted') rows.get(ph.scope)[ph.name] = 'value';
    } else if (ph.kind === 'section') {
      top[ph.name] = null; // filled in below, once its own fields are known
    } else if (ph.kind === 'inverted') {
      // An inverted block prints when the key is missing or empty; suggesting a
      // value for it would tell the reader to switch it off.
    } else {
      top[ph.name] = 'value';
    }
  }
  for (const name of Object.keys(top)) {
    if (top[name] === null) {
      const row = rows.get(name);
      top[name] = row && Object.keys(row).length ? [row] : [];
    }
  }
  return top;
}

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
  rejectUnknownFields(options, TEMPLATE_OPTION_FIELDS, 'a template\'s "options"');
  normalisePdfOptions(options); // validate now rather than at render time
  const { rows } = await query(
    `INSERT INTO templates (account_id, name, html, options) VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id, name) DO UPDATE SET html = EXCLUDED.html, options = EXCLUDED.options, updated_at = now()
     RETURNING name, updated_at`,
    [req.account.id, name, html, JSON.stringify(options)],
  );
  const placeholders = templatePlaceholders(html, options);
  res.json({
    template: rows[0],
    placeholders,
    usage: { template: name, data: templateUsageData(placeholders) },
  });
}));

router.get('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(`SELECT name, html, options, updated_at FROM templates WHERE account_id = $1 AND name = $2`, [req.account.id, String(req.params.name)]);
  if (!rows.length) throw bad('template_not_found', `You have no template called "${req.params.name}".`, { docs: '/docs#templates' });
  const placeholders = templatePlaceholders(rows[0].html, rows[0].options);
  // GET is the call a client makes to draw a form, so it needs the same
  // ready-to-paste data shape that PUT hands back.
  res.json({ ...rows[0], placeholders, usage: { template: rows[0].name, data: templateUsageData(placeholders) } });
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

router.get('/keys', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT key_prefix, label, created_at, last_used_at FROM api_keys
     WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [req.account.id],
  );
  res.json({ keys: rows.map((k) => ({
    key_prefix: k.key_prefix, label: k.label,
    created_at: k.created_at, last_used_at: k.last_used_at,
  })) });
}));

// Revoking takes effect on the next request: authenticate() already filters on
// revoked_at IS NULL, so there is no cache to invalidate.
router.delete('/keys/:prefix', withAuth, asyncRoute(async (req, res) => {
  const prefix = String(req.params.prefix || '');
  const revoked = await revokeApiKey(req.account.id, prefix);
  if (!revoked) {
    throw new ApiError(404, 'key_not_found', `No active key on this account starts with "${prefix}".`, {
      hint: 'List your keys with GET /v1/keys and use the key_prefix exactly as shown.',
      docs: '/docs#auth-more-keys',
    });
  }
  res.json({ revoked: prefix });
}));

async function runJob(job) {
  const { rows } = await query(`SELECT * FROM accounts WHERE id = $1`, [job.account_id]);
  const account = rows[0];
  if (!account) throw new ApiError(404, 'account_gone', 'The account that queued this job no longer exists.');
  const body = foldOptionsWrapper(job.request);
  const ctx = { id: job.id, endpoint: '/v1/pdf(job)' };
  const prepared = await preparePdf(account, body, ctx);
  let out;
  try {
    out = await producePdf(account, body, prepared, ctx);
  } catch (e) {
    await refundCredits(account.id, 1);
    logUsage(account.id, 'pdf', false, { errorCode: e.code, client: job.client ?? null });
    throw e;
  }
  const { buffer, pages, filename, durationMs } = out;
  logUsage(account.id, 'pdf', true, { pages, durationMs, client: job.client ?? null });
  const stored = await storeFile(account.id, buffer, filename, 'application/pdf', body.expiresInMinutes ?? body.expiration);
  return {
    filename, pages, size: buffer.length,
    file_path: stored.path,
    expires_in_minutes: stored.expiresInMinutes,
    duration_ms: durationMs,
  };
}

module.exports = { router, fillTemplate, templatePlaceholders, templateUsageData, storeFile, runJob, absoluteUrl, STRICT };
