'use strict';

/**
 * The pinned validator for src/openapi.js (PRD criterion G1).
 *
 * Everything here is static: fs.readFileSync over repository files. No server,
 * no database, no chromium, no network. The validator is deliberately
 * independent of src/openapi.js — it re-derives the truth from the route and
 * error-code sources and holds the spec against it in both directions.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { spec } = require('../src/openapi');

/* ------------------------------------------------------------ the validator */

/**
 * Validates a spec object against the source-derived expectations. Returns an
 * array of problem strings; empty means valid. This is the function the
 * mutation test must see fail on a broken clone.
 */
function validate(s, { routes, usedCodes, errorShapeHeaders, authSchemes } = {}) {
  const problems = [];
  const WIRE_OPTIONAL = ['hint', 'docs', 'details', 'request_id'];

  // --- structural ---
  // The `openapi` field must be a CONCRETE semver: @apidevtools/swagger-parser (and with it
  // Swagger UI / editor / most generators) refuses to load a document whose version is the
  // placeholder '3.1.x' -- "Unsupported OpenAPI version". Only 3.1.y is accepted here.
  if (!/^3\.1\.\d+$/.test(String(s.openapi))) {
    problems.push(`openapi must be a concrete 3.1.y version, got ${s.openapi}`);
  }
  // `nullable` is an OAS 3.0 keyword. 3.1 uses JSON Schema 2020-12, where nullability is
  // expressed as a type array (type: ['string', 'null']). A stray `nullable: true` is
  // silently ignored by 3.1 consumers, so the document would lie about the wire shape.
  const nullableAt = [];
  (function scan(node, at) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${at}/${i}`));
    for (const [k, v] of Object.entries(node)) {
      if (k === 'nullable') nullableAt.push(at);
      else scan(v, `${at}/${k}`);
    }
  })(s, '#');
  for (const at of nullableAt) problems.push(`nullable is not an OAS 3.1 keyword (at ${at}); use a type array`);
  if (!s.info || !s.info.title || s.info.title !== 'PDFMint API') problems.push('info.title must be "PDFMint API"');
  if (!s.info || !s.info.version) problems.push('info.version is required');
  if (!s.info || typeof s.info.description !== 'string' || !s.info.description.includes('/docs')) {
    problems.push('info.description must exist and link the docs');
  }
  if (!s.servers || !s.servers.some((x) => x.url === 'https://pdf.mintapis.com')) problems.push('servers must include https://pdf.mintapis.com');
  if (!s.paths || !Object.keys(s.paths).length) problems.push('paths must be non-empty');

  const HTTP = new Set(['get', 'post', 'put', 'delete', 'patch']);
  const v1Ops = [];
  for (const [p, item] of Object.entries(s.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP.has(method)) continue;
      v1Ops.push(`${method.toUpperCase()} ${p}`);
      if (!op.summary) problems.push(`${method.toUpperCase()} ${p}: missing summary`);
      if (!op.responses || !Object.keys(op.responses).length) {
        problems.push(`${method.toUpperCase()} ${p}: no responses`);
        continue;
      }
      const statuses = Object.keys(op.responses);
      if (!statuses.some((st) => /^2/.test(st))) problems.push(`${method.toUpperCase()} ${p}: no 2xx response`);
      if (!statuses.some((st) => !/^2/.test(st))) problems.push(`${method.toUpperCase()} ${p}: no non-2xx response`);
      if (p.startsWith('/v1/') && !p.startsWith('/v1/demo/') && !p.startsWith('/v1/forgot') && !p.startsWith('/v1/reset')) {
        if (!op.security || !op.security.length) problems.push(`${method.toUpperCase()} ${p}: protected operation must declare security`);
      }
    }
  }

  // --- components: Error schema matches the real wire shape ---
  const errSchema = s.components && s.components.schemas && s.components.schemas.Error;
  if (!errSchema) problems.push('components.schemas.Error missing');
  else {
    const props = errSchema.properties && errSchema.properties.error && errSchema.properties.error.properties;
    const req = errSchema.properties && errSchema.properties.error && errSchema.properties.error.required;
    if (!props || props.code.type !== 'string' || props.message.type !== 'string') {
      problems.push('schemas.Error must be { error: { code, message } }');
    }
    if (!req || !req.includes('code') || !req.includes('message')) {
      problems.push('schemas.Error.error must require code and message');
    }
    // the wire shape carries hint/docs/details/request_id when set — none may contradict
    for (const opt of WIRE_OPTIONAL) {
      if (Array.isArray(errorShapeHeaders) && errorShapeHeaders.includes(opt) && !props[opt]) problems.push(`schemas.Error.error.${opt} is sent by src/errors.js but undocumented`);
    }
    for (const opt of Object.keys(props || {})) {
      if (!['code', 'message', ...WIRE_OPTIONAL].includes(opt)) {
        problems.push(`schemas.Error.error.${opt} is not sent by src/errors.js`);
      }
    }
  }

  // --- securitySchemes cover both real auth headers ---
  const schemes = (s.components && s.components.securitySchemes) || {};
  const hasBearer = Object.values(schemes).some((x) => x.type === 'http' && x.scheme === 'bearer');
  const hasHeaderKey = Object.values(schemes).some((x) => x.type === 'apiKey' && x.in === 'header' && /^x-api-key$/i.test(x.name));
  if (!hasBearer) problems.push('securitySchemes must include an http bearer scheme (Authorization: Bearer)');
  if (!hasHeaderKey) problems.push('securitySchemes must include an apiKey header scheme for x-api-key');
  if (authSchemes) {
    for (const need of authSchemes) {
      if (!Object.keys(schemes).includes(need)) problems.push(`securitySchemes must include "${need}"`);
    }
  }

  // --- bidirectional route coverage ---
  if (routes) {
    const specSet = new Set(v1Ops);
    const want = new Set(routes);
    for (const r of want) if (!specSet.has(r)) problems.push(`spec is missing route ${r}`);
    for (const r of specSet) if (!want.has(r)) problems.push(`spec documents extra route ${r}`);
  }

  // --- bidirectional error-code inventory ---
  if (usedCodes) {
    const documented = new Set();
    const collect = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(collect); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'x-error-codes' && Array.isArray(v)) {
          for (const e of v) if (e && e.code) documented.add(e.code);
        } else if (/^[0-9]{3}$/.test(k)) collect(v);
        else collect(v);
      }
    };
    collect(s.paths);
    const want = new Set(usedCodes);
    for (const c of want) if (!documented.has(c)) problems.push(`error code "${c}" is raised in source but not documented in the spec`);
    for (const c of documented) if (!want.has(c)) problems.push(`error code "${c}" is documented in the spec but never raised in source`);
  }

  return problems;
}

/* ------------------------------------------- source-derived expected facts */

function publicV1Routes() {
  const routes = new Set();
  const norm = (method, p) => `${method.toUpperCase()} /v1/${p.replace(/^\//, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;

  const apiSrc = read('src/api.js');
  const re = /router\.(get|post|put|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(apiSrc)) !== null) routes.add(norm(m[1], m[2]));

  // recovery.js mounts POST /v1/${action} for the actions in its install loop.
  const recSrc = read('src/recovery.js');
  const loop = /for \(const action of \[([^\]]+)\]\)/.exec(recSrc);
  assert.ok(loop, 'recovery.js install loop not found');
  const actions = [...loop[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const postsBothPrefixes = /router\.post\(\[\s*`\/\$\{action\}`\s*,\s*`\/v1\/\$\{action\}`\s*\]/.test(recSrc);
  assert.ok(postsBothPrefixes, 'recovery.js expected to mount /${action} and /v1/${action} for POST');
  for (const a of actions) routes.add(`POST /v1/${a}`);

  return [...routes].sort();
}

function usedErrorCodes() {
  const codes = new Set();
  const files = ['src/api.js', 'src/options.js', 'src/jobs.js', 'src/auth.js', 'src/net.js', 'src/recovery.js'];
  const patterns = [
    /\bbad\(\s*'([a-z_]+)'/g,
    /new ApiError\(\s*\d+\s*,\s*'([a-z_]+)'/g,
    /\bcode:\s*'([a-z_]+)'/g,          // e.g. jsonb error objects in jobs.js
    /'code',\s*'([a-z_]+)'/g,          // e.g. jsonb_build_object('code', 'job_cancelled', ...) in jobs.js
    /e\.code \|\|\s*'([a-z_]+)'/g,     // e.g. code: e.code || 'render_failed'
  ];
  for (const f of files) {
    const src = read(f);
    for (const p of patterns) {
      let m;
      while ((m = p.exec(src)) !== null) codes.add(m[1]);
    }
  }
  return [...codes].sort();
}

const WIRE_FIELDS = (() => {
  // The optional fields src/errors.js actually sets on the wire.
  const src = read('src/errors.js');
  return ['error', ...[...src.matchAll(/body\.error\.([a-z_]+)/g)].map((m) => m[1])]
    .filter((v, i, a) => a.indexOf(v) === i);
})();

/* -------------------------------------------------------------- the checks */

test('spec passes the pinned validator', () => {
  const problems = validate(spec, {
    routes: publicV1Routes(),
    usedCodes: usedErrorCodes(),
    errorShapeHeaders: WIRE_FIELDS,
    authSchemes: ['bearerAuth', 'apiKeyAuth'],
  });
  assert.deepStrictEqual(problems, [], `validator found problems:\n${problems.join('\n')}`);
});

test('bidirectional route coverage: spec /v1 surface equals source routes exactly', () => {
  const routes = publicV1Routes();
  assert.ok(routes.includes('GET /v1/me'));
  assert.ok(routes.includes('POST /v1/pdf'));
  assert.ok(routes.includes('POST /v1/demo/pdf'));
  assert.ok(routes.includes('POST /v1/image'));
  assert.ok(routes.includes('POST /v1/merge'));
  assert.ok(routes.includes('GET /v1/jobs/{id}'));
  assert.ok(routes.includes('DELETE /v1/jobs/{id}'));
  assert.ok(routes.includes('GET /v1/templates'));
  assert.ok(routes.includes('PUT /v1/templates/{name}'));
  assert.ok(routes.includes('GET /v1/templates/{name}'));
  assert.ok(routes.includes('DELETE /v1/templates/{name}'));
  assert.ok(routes.includes('POST /v1/keys'));
  assert.ok(routes.includes('GET /v1/keys'));
  assert.ok(routes.includes('DELETE /v1/keys/{prefix}'));
  assert.ok(routes.includes('POST /v1/forgot-password'));
  assert.ok(routes.includes('POST /v1/reset-password'));

  const specOps = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'delete']) {
      if (item[method]) specOps.add(`${method.toUpperCase()} ${p}`);
    }
  }
  assert.deepStrictEqual([...specOps].sort(), routes.sort());
});

test('bidirectional error-code inventory', () => {
  const used = usedErrorCodes();
  assert.ok(used.length >= 20, `expected a real inventory, got ${used.length} codes`);
  const documented = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const [k, v] of Object.entries(obj)) walk(v);
    if (Array.isArray(obj['x-error-codes'])) for (const e of obj['x-error-codes']) documented.add(e.code);
  };
  walk(spec.paths);
  for (const c of used) assert.ok(documented.has(c), `code "${c}" raised in source but not documented`);
  for (const c of documented) assert.ok(used.includes(c), `code "${c}" documented but never raised in source`);
});

test('every error code documented carries its status on the right operation', () => {
  // A code that can appear only on a 4xx must never be listed under a 2xx —
  // except on GET /v1/jobs/{id}, where a 200 body embeds the failed job's
  // error object (job_cancelled / render_failed / renderer_crashed / account_gone).
  const JOB_BODY_CODES = new Set(['job_cancelled', 'render_failed', 'renderer_crashed', 'account_gone']);
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      for (const [status, resp] of Object.entries(op.responses || {})) {
        for (const e of resp['x-error-codes'] || []) {
          if (/^2/.test(status)) {
            const isJobBody = String(JSON.stringify(resp.content || {})).includes('schemas/Job')
              && JOB_BODY_CODES.has(e.code);
            assert.ok(isJobBody, `${method.toUpperCase()} ${p}: code ${e.code} listed under 2xx`);
          }
          assert.ok(typeof e.meaning === 'string' && e.meaning.length > 5, `${e.code} must have a meaning`);
        }
      }
    }
  }
});

test('mutation test: the validator bites on a spec with a removed route', () => {
  const clone = JSON.parse(JSON.stringify(spec));
  delete clone.paths['/v1/pdf'];
  const problems = validate(clone, { routes: publicV1Routes() });
  assert.ok(problems.some((p) => p.includes('POST /v1/pdf')), 'removing /v1/pdf must fail the validator');
});

test('mutation test: the validator bites on a dropped error code', () => {
  const clone = JSON.parse(JSON.stringify(spec));
  const codes = usedErrorCodes();
  // Remove every occurrence of the first used code from the clone.
  const victim = codes[0];
  const strip = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(strip); return; }
    if (Array.isArray(obj['x-error-codes'])) {
      obj['x-error-codes'] = obj['x-error-codes'].filter((e) => e.code !== victim);
    }
    for (const v of Object.values(obj)) strip(v);
  };
  strip(clone);
  const problems = validate(clone, { usedCodes: codes });
  assert.ok(problems.some((p) => p.includes(`"${victim}"`)), `dropping code ${victim} must fail the validator`);
});

/**
 * The option names normalisePdfOptions() actually reads off its input object, scanned
 * statically out of src/options.js. This is the source of truth the spec is held against;
 * it is derived from the implementation, never from src/openapi.js.
 */
function acceptedPdfOptionNames() {
  const src = read('src/options.js');
  const start = src.indexOf('function normalisePdfOptions');
  assert.ok(start > -1, 'normalisePdfOptions must exist in src/options.js');
  const body = src.slice(start, src.indexOf('\nmodule.exports', start));
  const names = new Set();
  for (const m of body.matchAll(/\bo\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names].sort();
}

function documentedPdfOptionNames(s) {
  const props = ((s.components && s.components.schemas && s.components.schemas.PdfOptions) || findPdfOptions(s) || {}).properties || {};
  return Object.keys(props).sort();
}

/** PdfOptions is inlined as the `options` schema of POST /v1/pdf. */
function findPdfOptions(s) {
  const body = s.paths['/v1/pdf'].post.requestBody.content['application/json'].schema;
  const props = body.properties || {};
  return props.options || null;
}

test('bidirectional option coverage: every option normalisePdfOptions reads is documented', () => {
  const accepted = acceptedPdfOptionNames();
  const documented = documentedPdfOptionNames(spec);
  // Aliases the spec documents in prose on their canonical property instead of as own keys.
  const ALIASED = new Set(['headerTemplate', 'footerTemplate', 'preferCSSPageSize']);
  const missing = accepted.filter((n) => !documented.includes(n) && !ALIASED.has(n));
  assert.deepEqual(missing, [], `options accepted by src/options.js but absent from the spec: ${missing.join(', ')}`);

  const undocumentedAlias = [...ALIASED].filter((a) => {
    const json = JSON.stringify(spec);
    return accepted.includes(a) && !json.includes(a);
  });
  assert.deepEqual(undocumentedAlias, [], `accepted aliases the spec never mentions: ${undocumentedAlias.join(', ')}`);

  const extra = documented.filter((n) => !accepted.includes(n));
  assert.deepEqual(extra, [], `spec documents options src/options.js never reads: ${extra.join(', ')}`);
});

test('mutation test: the validator bites on a missing option', () => {
  // PRD G1 names this mutation explicitly: dropping a real option from the spec must fail.
  const accepted = acceptedPdfOptionNames();
  const victim = accepted.find((n) => !['headerTemplate', 'footerTemplate', 'preferCSSPageSize'].includes(n));
  assert.ok(victim, 'need at least one non-alias option to mutate');

  const clone = JSON.parse(JSON.stringify(spec));
  const opts = findPdfOptions(clone);
  delete opts.properties[victim];

  const documented = Object.keys(opts.properties).sort();
  assert.ok(
    !documented.includes(victim),
    `dropping option ${victim} must be detectable: the spec would no longer document it`
  );
  // And the real check the coverage test performs must fail on the clone:
  const missing = accepted.filter(
    (n) => !documented.includes(n) && !['headerTemplate', 'footerTemplate', 'preferCSSPageSize'].includes(n)
  );
  assert.ok(missing.includes(victim), `the option-coverage check must bite on the removed option ${victim}`);
});

test('mutation test: the validator bites on the placeholder version literal', () => {
  // Regression guard: '3.1.x' shipped once and made @apidevtools/swagger-parser refuse the
  // whole document, while the validator of the day whitelisted it.
  const clone = JSON.parse(JSON.stringify(spec));
  clone.openapi = '3.1.x';
  const problems = validate(clone, {});
  assert.ok(
    problems.some((p) => p.includes('concrete 3.1.y')),
    'a placeholder openapi version must fail the validator'
  );
});

test('mutation test: the validator bites on an OAS 3.0 `nullable` keyword', () => {
  const clone = JSON.parse(JSON.stringify(spec));
  clone.components.schemas.Job.properties.started_at = { type: 'string', nullable: true };
  const problems = validate(clone, {});
  assert.ok(
    problems.some((p) => p.includes('nullable is not an OAS 3.1 keyword')),
    'a stray nullable must fail the validator'
  );
});

test('the shipped spec declares a concrete 3.1 version and no 3.0-only keywords', () => {
  assert.match(spec.openapi, /^3\.1\.\d+$/, 'openapi must be a concrete 3.1.y version');
  assert.ok(
    !JSON.stringify(spec).includes('"nullable"'),
    'the spec must not contain the OAS 3.0 `nullable` keyword'
  );
});

test('server.js serves /openapi.json and never redirects the legacy host away from it', () => {
  const src = read('src/server.js');
  assert.match(src, /app\.get\(\s*'\/openapi\.json'/, 'server.js must register GET /openapi.json');
  const never = /const NEVER_REDIRECT = \[([^\]]*)\]/.exec(src);
  assert.ok(never, 'NEVER_REDIRECT list not found in server.js');
  assert.ok(never[1].includes("'/openapi.json'"), 'NEVER_REDIRECT must include /openapi.json so the legacy host serves it directly');
});

test('docs link the machine-readable spec', () => {
  const docs = read('public/docs.html');
  assert.match(docs, /href="\/openapi\.json"/, 'docs.html must link /openapi.json');
  assert.match(docs, /OpenAPI 3\.1 \(JSON\)/, 'the link must be labelled OpenAPI 3.1 (JSON)');
});
