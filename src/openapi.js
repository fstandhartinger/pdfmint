'use strict';

/**
 * Machine-readable OpenAPI 3.1 reference for the public /v1 surface.
 *
 * Every field here was read out of the source, not invented: option names,
 * aliases, defaults and ranges come from src/options.js and src/api.js, the
 * error wire shape from src/errors.js, the auth headers from src/auth.js and
 * the rate-limit numbers from src/ratelimit.js. The pinned validator in
 * test/openapi.test.js keeps this file honest in both directions.
 */

const { version } = require('../package.json');

/* ------------------------------------------------------------ error codes */

const E = (code, meaning) => ({ code, meaning });

const ERR = {
  missing_api_key: 'No API key was sent (Authorization: Bearer or x-api-key).',
  invalid_api_key: 'The API key is not valid or has been revoked.',
  plan_required: 'The account has no plan, so it cannot render anything yet.',
  quota_exceeded: 'All documents included in the monthly plan have been used.',
  rate_limited: 'Too many requests: 120 per minute per account with a burst of 30. Retry-After says how long to wait.',
  missing_content: 'Nothing to render: send exactly one of "html", "markdown", "url" or "template".',
  ambiguous_content: 'More than one of "html", "markdown", "url" or "template" was sent.',
  unknown_field: 'The request contains a field the endpoint does not accept.',
  invalid_option: 'An option value is malformed or out of range.',
  invalid_data: 'The "data" field is a string but is not valid JSON.',
  invalid_url: 'The URL field is not a valid URL.',
  unsupported_url_scheme: 'The URL field must use http:// or https://.',
  private_address_blocked: 'The URL points at (or resolves to) a private, loopback or link-local address; SSRF is blocked.',
  dns_failed: 'The host in the URL could not be resolved.',
  html_too_large: 'The HTML exceeds the maximum document size.',
  unresolved_placeholders: 'The template uses placeholders that "data" does not provide (strict mode).',
  invalid_placeholder_value: 'A placeholder value would print as "[object Object]" (strict mode).',
  blank_document: 'The document has no visible content (strict mode).',
  unrendered_markup: 'The markup was printed as text instead of being applied (strict mode).',
  file_too_large: 'The generated file is over the hosted-file size limit; use output "binary".',
  invalid_input: '"files" must be an array of at least two PDF URLs or {"base64": ...} entries.',
  too_many_files: 'More than 50 inputs were sent to one merge.',
  download_failed: 'An input URL could not be downloaded for the merge.',
  unsupported_source: 'Saved templates cannot be rendered as images.',
  template_not_found: 'No stored template with that name exists on this account.',
  template_too_large: 'The template body is over the 2 MB limit.',
  invalid_template_name: 'The template name is not 1-64 characters of letters, digits, spaces, dot, dash or underscore.',
  job_not_found: 'No job with that ID exists on this account.',
  job_already_finished: 'The job is already in a final state and cannot be cancelled.',
  account_gone: 'The account that queued this job no longer exists.',
  job_cancelled: 'The job was cancelled before it finished.',
  render_failed: 'The render inside the job failed.',
  renderer_crashed: 'The renderer stopped before the job finished, twice; the document is most likely too large.',
  key_not_found: 'No active key on this account starts with the given prefix.',
  last_key: 'That is the only key on the account, so revoking it would lock the account out.',
  demo_limit_reached: 'The keyless demo allows 5 renders an hour from one address.',
  demo_payload_too_large: 'The demo accepts 16 KB of HTML; the request was larger.',
  invalid_email: 'The email address is not valid.',
  invalid_password: 'The new password is too short or over 72 UTF-8 bytes.',
  invalid_reset_token: 'The reset link is invalid or has expired.',
  recovery_unavailable: 'Email delivery is temporarily unavailable.',
};

/**
 * Per-operation error inventory. Each entry lists the response status and the
 * error codes it can carry; test/openapi.test.js checks this against the codes
 * actually thrown in the source.
 */
const ERRORS = {
  AUTH: {
    401: [E('missing_api_key', ERR.missing_api_key), E('invalid_api_key', ERR.invalid_api_key)],
  },
  QUOTA: {
    402: [E('plan_required', ERR.plan_required), E('quota_exceeded', ERR.quota_exceeded)],
  },
  RATE: {
    429: [E('rate_limited', ERR.rate_limited)],
  },
  RECOVERY_RATE: {
    429: [E('rate_limited', ERR.rate_limited)],
  },
};

const PDF_400 = [
  E('missing_content', ERR.missing_content),
  E('ambiguous_content', ERR.ambiguous_content),
  E('unknown_field', ERR.unknown_field),
  E('invalid_option', ERR.invalid_option),
  E('invalid_data', ERR.invalid_data),
  E('invalid_url', ERR.invalid_url),
  E('unsupported_url_scheme', ERR.unsupported_url_scheme),
  E('private_address_blocked', ERR.private_address_blocked),
  E('dns_failed', ERR.dns_failed),
  E('html_too_large', ERR.html_too_large),
  E('template_not_found', ERR.template_not_found),
  E('unresolved_placeholders', ERR.unresolved_placeholders),
  E('invalid_placeholder_value', ERR.invalid_placeholder_value),
  E('blank_document', ERR.blank_document),
  E('unrendered_markup', ERR.unrendered_markup),
  E('file_too_large', ERR.file_too_large),
];

const IMAGE_400 = [
  E('missing_content', ERR.missing_content),
  E('ambiguous_content', ERR.ambiguous_content),
  E('unknown_field', ERR.unknown_field),
  E('invalid_option', ERR.invalid_option),
  E('invalid_data', ERR.invalid_data),
  E('unsupported_source', ERR.unsupported_source),
  E('invalid_url', ERR.invalid_url),
  E('unsupported_url_scheme', ERR.unsupported_url_scheme),
  E('private_address_blocked', ERR.private_address_blocked),
  E('dns_failed', ERR.dns_failed),
  E('unresolved_placeholders', ERR.unresolved_placeholders),
  E('invalid_placeholder_value', ERR.invalid_placeholder_value),
  E('blank_document', ERR.blank_document),
  E('unrendered_markup', ERR.unrendered_markup),
  E('file_too_large', ERR.file_too_large),
];

const MERGE_400 = [
  E('invalid_input', ERR.invalid_input),
  E('too_many_files', ERR.too_many_files),
  E('unknown_field', ERR.unknown_field),
  E('invalid_option', ERR.invalid_option),
  E('download_failed', ERR.download_failed),
  E('blank_document', ERR.blank_document),
  E('file_too_large', ERR.file_too_large),
];

const errResponse = (status, codes, description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  'x-error-codes': codes.map((c) => ({ code: c.code, meaning: c.meaning })),
});

function errors(...groups) {
  const out = {};
  for (const g of groups) {
    for (const [status, codes] of Object.entries(g)) {
      out[status] = errResponse(Number(status), codes,
        codes.map((c) => `\`${c.code}\` — ${c.meaning}`).join('\n\n'));
    }
  }
  return out;
}

const AUTH_SECURED = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

/* ----------------------------------------------------------- option schema */

const PdfOptions = {
  type: 'object',
  description: 'PDF page options. On /v1/pdf they are accepted flat in the body or nested under "options" (flat wins on conflict); /v1/image and /v1/merge accept the same flat keys. Values are validated against src/options.js: unknown keys are refused, not ignored.',
  properties: {
    format: { type: 'string', enum: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Ledger'], default: 'A4' },
    width: { description: 'Custom page width; a number is treated as px. Requires "height".', anyOf: [{ type: 'string' }, { type: 'number' }] },
    height: { description: 'Custom page height; a number is treated as px. Requires "width".', anyOf: [{ type: 'string' }, { type: 'number' }] },
    landscape: { type: 'boolean', default: false },
    margin: {
      description: 'A CSS length (default 12mm per side) or an object of per-side lengths. "" means 0 on every side.',
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        {
          type: 'object',
          properties: {
            top: { type: 'string' }, right: { type: 'string' },
            bottom: { type: 'string' }, left: { type: 'string' },
          },
        },
      ],
    },
    scale: { type: 'number', minimum: 0.1, maximum: 2, default: 1 },
    printBackground: { type: 'boolean', default: true },
    headerHtml: { type: 'string', description: 'Alias: "headerTemplate". Rendered on every page; enables header/footer mode.' },
    footerHtml: { type: 'string', description: 'Alias: "footerTemplate". Rendered on every page; enables header/footer mode.' },
    pageNumbers: { description: 'true builds a default "Page {page} of {total}" footer; a string is a template with {page}, {total}, {date}, {title}, {url}.', anyOf: [{ type: 'boolean' }, { type: 'string' }] },
    pageRanges: { type: 'string', description: 'Comma-separated pages and ranges, 1-based, e.g. "1-5, 8, 11-13".' },
    mediaType: { type: 'string', enum: ['print', 'screen'], default: 'print' },
    preferCssPageSize: { type: 'boolean', default: false, description: 'Alias: "preferCSSPageSize".' },
    tagged: { type: 'boolean', default: true },
    outline: { type: 'boolean', default: false },
  },
};

const PdfBody = {
  type: 'object',
  description: 'Exactly one content field must be set. Every PDF option below is accepted flat OR nested inside "options" (a flat key wins over the same key in "options").',
  properties: {
    html: { type: 'string', description: 'HTML markup to render. May contain {{placeholders}} filled from "data".' },
    markdown: { type: 'string', description: 'Markdown to convert and render. May contain {{placeholders}}.' },
    url: { type: 'string', format: 'uri', description: 'Public http(s) URL to render; private and link-local addresses are blocked.' },
    template: { type: 'string', description: 'Name of a stored template (see /v1/templates). Filled from "data"; its stored options are defaults overridden by the request.' },
    data: { description: 'Values for {{placeholders}}; an object, or a string containing JSON.', anyOf: [{ type: 'object' }, { type: 'string' }] },
    strict: { type: 'boolean', default: false, description: 'Refuse (400) instead of returning a blank, placeholder-laden or escaped-markup document.' },
    output: { type: 'string', enum: ['binary', 'url', 'base64'], default: 'binary', description: '"binary" (default) returns the PDF bytes; "url" hosts the file and returns a temporary link; "base64" returns the bytes inside the JSON.' },
    filename: { type: 'string', description: 'Download name for binary output; ".pdf" is appended if missing.' },
    options: PdfOptions,
    timeout: { description: 'Render timeout in ms; minimum 1000, capped at the server maximum (excess is clamped with a warning). Alias: "timeoutMs".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    timeoutMs: { description: 'Alias of "timeout".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    waitFor: { description: 'Wait for a selector, a fixed delay, or network idle before printing. Aliases: "waitUntil", "wait", "delay".', anyOf: [{ type: 'string' }, { type: 'number' }] },
    javascript: { type: 'boolean', description: 'Allow page JavaScript. Alias accepted on /v1/pdf only as a flat key.' },
    emulateDarkMode: { type: 'boolean' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra HTTP headers when rendering a "url".' },
    css: { type: 'string', description: 'Extra CSS (applied with "markdown"; honoured for html by the renderer).' },
    googleFonts: { type: 'string', description: 'Google Fonts to load before rendering.' },
    metadata: { type: 'object', description: 'PDF metadata, e.g. {"title": "...", "author": "..."}.' },
    password: { type: 'string', description: 'Encrypt the PDF with this user password. Alias of "encrypt".' },
    ownerPassword: { type: 'string' },
    allowPrinting: { type: 'boolean', default: true },
    allowCopying: { type: 'boolean', default: false },
    watermark: { description: 'A watermark string, or {"text", ...}. Placeholders in "text" are filled from "data".', anyOf: [{ type: 'string' }, { type: 'object' }] },
    debug: { type: 'boolean', default: false, description: 'Return page errors in the X-PDFMint-Page-Errors header and the JSON response.' },
    expiresInMinutes: { description: 'Hosted-file TTL in minutes for output "url" (clamped to the server minimum of 1 and maximum). Alias: "expiration".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    expiration: { description: 'Alias of "expiresInMinutes".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    async: { type: 'boolean', default: false, description: 'Queue the render and return 202 with a job; poll GET /v1/jobs/{id}.' },
    webhookUrl: { type: 'string', description: 'Public URL notified when an async job finishes (implies async). Aliases: "webhook_url", "callback", "callbackUrl", "webhook".' },
    webhook_url: { type: 'string', description: 'Alias of "webhookUrl".' },
    title: { type: 'string', description: 'Document title (used for the markdown conversion when no metadata title is set).' },
    // page options, also accepted flat:
    format: PdfOptions.properties.format,
    width: PdfOptions.properties.width,
    height: PdfOptions.properties.height,
    landscape: PdfOptions.properties.landscape,
    margin: PdfOptions.properties.margin,
    scale: PdfOptions.properties.scale,
    printBackground: PdfOptions.properties.printBackground,
    headerHtml: PdfOptions.properties.headerHtml,
    footerHtml: PdfOptions.properties.footerHtml,
    headerTemplate: { type: 'string', description: 'Alias of "headerHtml".' },
    footerTemplate: { type: 'string', description: 'Alias of "footerHtml".' },
    pageNumbers: PdfOptions.properties.pageNumbers,
    pageRanges: PdfOptions.properties.pageRanges,
    mediaType: PdfOptions.properties.mediaType,
    preferCssPageSize: PdfOptions.properties.preferCssPageSize,
    preferCSSPageSize: { type: 'boolean', description: 'Alias of "preferCssPageSize".' },
    tagged: PdfOptions.properties.tagged,
    outline: PdfOptions.properties.outline,
  },
};

const ImageBody = {
  type: 'object',
  description: 'Exactly one content field must be set ("template" is not supported for images). All fields are accepted flat or nested inside "options" (flat wins).',
  properties: {
    html: { type: 'string', description: 'HTML markup to screenshot. May contain {{placeholders}} filled from "data".' },
    markdown: { type: 'string', description: 'Markdown to convert and screenshot.' },
    url: { type: 'string', format: 'uri', description: 'Public http(s) URL to screenshot; private addresses are blocked.' },
    data: { description: 'Values for {{placeholders}}.', anyOf: [{ type: 'object' }, { type: 'string' }] },
    type: { type: 'string', enum: ['png', 'jpeg'], default: 'png', description: 'Image format (aliases "format" and "imageType" are mapped to this field).' },
    quality: { type: 'number', default: 85, description: 'JPEG quality.' },
    width: { type: 'number', default: 1280, description: 'Viewport width in px.' },
    height: { type: 'number', default: 800, description: 'Viewport height in px.' },
    deviceScaleFactor: { type: 'number', default: 2 },
    fullPage: { type: 'boolean', default: true },
    omitBackground: { type: 'boolean', default: false },
    waitFor: { description: 'Wait for a selector or a fixed delay. Aliases: "waitUntil", "wait", "delay".', anyOf: [{ type: 'string' }, { type: 'number' }] },
    timeout: { description: 'Render timeout in ms; minimum 1000. Alias: "timeoutMs".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    timeoutMs: { description: 'Alias of "timeout".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    javascript: { type: 'boolean' },
    css: { type: 'string' },
    googleFonts: { type: 'string' },
    strict: { type: 'boolean', default: false, description: 'Refuse blank or placeholder-laden screenshots with 400.' },
    output: { type: 'string', enum: ['binary', 'url', 'base64'], default: 'binary' },
    filename: { type: 'string', description: 'Download name; the extension is corrected to match the type, with a warning when it lied.' },
    expiresInMinutes: { description: 'Hosted-file TTL for output "url".', anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
};

const MergeBody = {
  type: 'object',
  description: 'Merges 2-50 PDFs. Inputs are accepted under "files" (also aliased as "urls" or "pdfs"); each entry is a public http(s) URL string, a base64 string, or {"base64": "..."}.',
  properties: {
    files: { type: 'array', minItems: 2, maxItems: 50, items: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'string', description: 'base64-encoded PDF' }, { type: 'object', properties: { base64: { type: 'string' } }, required: ['base64'] }] } },
    urls: { type: 'array', minItems: 2, maxItems: 50, items: {}, description: 'Alias of "files".' },
    pdfs: { type: 'array', minItems: 2, maxItems: 50, items: {}, description: 'Alias of "files".' },
    output: { type: 'string', enum: ['binary', 'url', 'base64'], default: 'binary' },
    filename: { type: 'string', default: 'merged.pdf', description: '".pdf" is appended if missing.' },
    metadata: { type: 'object', description: 'PDF metadata for the merged document.' },
    expiresInMinutes: { description: 'Hosted-file TTL for output "url".', anyOf: [{ type: 'number' }, { type: 'string' }] },
    strict: { type: 'boolean', default: false, description: 'Refuse a merge whose pages would be empty with 400.' },
    options: { type: 'object', description: 'Accepted wrapper; its keys are folded into the body (flat keys win).' },
  },
};

const FileJson = {
  type: 'object',
  properties: {
    filename: { type: 'string' },
    pages: { type: 'integer', nullable: true, description: 'Page count (absent/null when the PDF is encrypted).' },
    size: { type: 'integer', description: 'File size in bytes.' },
    url: { type: 'string', format: 'uri', description: 'Temporary hosted-file link (output "url", or the finished async job).' },
    expires_in_minutes: { type: 'integer', description: 'How long the hosted link stays valid.' },
    base64: { type: 'string', description: 'The file bytes, base64 (output "base64" only).' },
    duration_ms: { type: 'integer' },
    credits_remaining: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const Job = {
  type: 'object',
  properties: {
    job_id: { type: 'string', description: 'Job ID, "job_" followed by base64url characters.' },
    kind: { type: 'string', enum: ['pdf'] },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    created_at: { type: 'string', format: 'date-time' },
    started_at: { type: 'string', format: 'date-time', nullable: true },
    finished_at: { type: 'string', format: 'date-time', nullable: true },
    attempts: { type: 'integer' },
    filename: { type: 'string' },
    pages: { type: 'integer' },
    size: { type: 'integer' },
    url: { type: 'string', format: 'uri', description: 'Present once succeeded: the hosted result file.' },
    expires_in_minutes: { type: 'integer' },
    duration_ms: { type: 'integer' },
    error: {
      type: 'object',
      description: 'Present when the job failed or was cancelled.',
      properties: {
        code: { type: 'string', enum: ['render_failed', 'renderer_crashed', 'job_cancelled'], description: 'Any render-time code (e.g. html_too_large) can also appear here.' },
        message: { type: 'string' },
        hint: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['job_id', 'kind', 'status', 'created_at', 'attempts'],
};

const json = (schema) => ({ description: '', content: { 'application/json': { schema } } });

/* ------------------------------------------------------------------ spec */

const spec = {
  openapi: '3.1.x',
  info: {
    title: 'PDFMint API',
    version,
    description: 'HTML, Markdown, URL and template rendering to PDF and images over a simple JSON API. '
      + 'The human-readable reference lives at https://pdf.mintapis.com/docs; this document is the '
      + 'machine-readable OpenAPI 3.1 description of the same endpoints. '
      + 'Authentication uses either `Authorization: Bearer <key>` or `x-api-key: <key>`; keys start with `pm_live_`. '
      + 'Every authenticated endpoint is rate-limited to 120 requests per minute per account with a burst of 30 '
      + '(headers X-RateLimit-Limit, X-RateLimit-Burst, X-RateLimit-Remaining; a 429 carries Retry-After).',
  },
  servers: [
    { url: 'https://pdf.mintapis.com' },
    { url: 'https://pdfmint-b9tt.onrender.com' },
  ],
  tags: [
    { name: 'render' }, { name: 'files' }, { name: 'account' },
    { name: 'templates' }, { name: 'keys' }, { name: 'jobs' }, { name: 'recovery' },
  ],
  paths: {
    '/v1/me': {
      get: {
        tags: ['account'],
        summary: 'Account balance and plan',
        description: 'Returns the authenticated account’s plan, monthly credit usage and when the period resets (on the 1st of the month, UTC).',
        security: AUTH_SECURED,
        responses: {
          200: json({
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              plan: { type: 'string' },
              plan_name: { type: 'string' },
              credits_limit: { type: 'integer' },
              credits_used: { type: 'integer' },
              credits_remaining: { type: 'integer' },
              period_resets_at: { type: 'string', format: 'date-time' },
              dashboard_url: { type: 'string', format: 'uri' },
            },
            required: ['email', 'plan', 'plan_name', 'credits_limit', 'credits_used', 'credits_remaining', 'period_resets_at', 'dashboard_url'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE),
        },
      },
    },
    '/v1/demo/pdf': {
      post: {
        tags: ['render'],
        summary: 'Keyless demo render (HTML only)',
        description: 'Renders HTML to PDF without an API key. Only "html" is honoured; anything else in the body is ignored. Capped at 16 KB of HTML and 5 renders per hour per client address (X-PDFMint-Demo-Remaining header).',
        security: [],
        requestBody: json({
          type: 'object',
          required: ['html'],
          properties: { html: { type: 'string' } },
        }),
        responses: {
          200: {
            description: 'The rendered PDF (hello.pdf).',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
          },
          400: errResponse(400, [E('missing_content', ERR.missing_content)], '`missing_content` — send the markup in "html".'),
          413: errResponse(413, [E('demo_payload_too_large', ERR.demo_payload_too_large)], '`demo_payload_too_large` — the demo accepts 16 KB of HTML.'),
          429: errResponse(429, [E('demo_limit_reached', ERR.demo_limit_reached)], '`demo_limit_reached` — 5 renders an hour from one address; Retry-After says when to retry.'),
        },
      },
    },
    '/v1/pdf': {
      post: {
        tags: ['render'],
        summary: 'Render HTML, Markdown, a URL or a stored template to PDF',
        description: 'Costs 1 credit. Synchronous by default (binary/url/base64 output); with "async": true or a "webhookUrl" it queues a job instead and returns 202 with a status_url for GET /v1/jobs/{id}. Placeholders like {{name}} are filled from "data" and checked by strict mode.',
        security: AUTH_SECURED,
        requestBody: json(PdfBody),
        responses: {
          200: {
            description: 'The rendered document. Binary mode returns application/pdf bytes; url and base64 return JSON.',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/json': { schema: { $ref: '#/components/schemas/FileJson' } },
            },
          },
          202: json({
            type: 'object',
            properties: {
              job_id: { type: 'string' },
              status: { type: 'string', enum: ['queued'] },
              status_url: { type: 'string', format: 'uri', description: 'GET /v1/jobs/{id} for the same job.' },
              webhook_url: { type: 'string', nullable: true },
              credits_remaining: { type: 'integer' },
            },
            required: ['job_id', 'status', 'status_url', 'credits_remaining'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.QUOTA, ERRORS.RATE, { 400: PDF_400 }),
        },
      },
    },
    '/v1/image': {
      post: {
        tags: ['render'],
        summary: 'Render HTML, Markdown or a URL to a PNG or JPEG',
        description: 'Costs 1 credit. Screenshots the rendered page; saved templates are not supported here.',
        security: AUTH_SECURED,
        requestBody: json(ImageBody),
        responses: {
          200: {
            description: 'The rendered image (image/png or image/jpeg for binary output; JSON for url/base64).',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'application/json': { schema: { $ref: '#/components/schemas/FileJson' } },
            },
          },
          ...errors(ERRORS.AUTH, ERRORS.QUOTA, ERRORS.RATE, { 400: IMAGE_400 }),
        },
      },
    },
    '/v1/merge': {
      post: {
        tags: ['render'],
        summary: 'Merge 2-50 PDFs into one',
        description: 'Costs 1 credit. Each input is a public http(s) URL, a base64 string, or {"base64": "..."}.',
        security: AUTH_SECURED,
        requestBody: json(MergeBody),
        responses: {
          200: {
            description: 'The merged PDF (binary) or JSON metadata (url/base64).',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/json': { schema: { $ref: '#/components/schemas/FileJson' } },
            },
          },
          ...errors(ERRORS.AUTH, ERRORS.QUOTA, ERRORS.RATE, { 400: MERGE_400 }),
        },
      },
    },
    '/v1/jobs/{id}': {
      get: {
        tags: ['jobs'],
        summary: 'Poll an asynchronous render job',
        description: 'Returns the job’s status; when succeeded it carries the hosted result fields (url, filename, pages, size, expires_in_minutes, duration_ms). Finished jobs are deleted after a week.',
        security: AUTH_SECURED,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'The job_id returned by an async request.' }],
        responses: {
          200: {
            description: 'The job. Its "error" object, when present, carries job_cancelled, render_failed, renderer_crashed — or any render-time code such as html_too_large.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
            'x-error-codes': [
              { code: 'job_cancelled', meaning: ERR.job_cancelled },
              { code: 'render_failed', meaning: ERR.render_failed },
              { code: 'renderer_crashed', meaning: ERR.renderer_crashed },
              { code: 'account_gone', meaning: ERR.account_gone },
            ],
          },
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            404: [E('job_not_found', ERR.job_not_found)],
          }),
        },
      },
      delete: {
        tags: ['jobs'],
        summary: 'Cancel a queued or running job',
        description: 'Marks the job cancelled and refunds the credit it consumed. The result of an already-finished job cannot be cancelled.',
        security: AUTH_SECURED,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: json({
            type: 'object',
            properties: { job_id: { type: 'string' }, status: { type: 'string', enum: ['cancelled'] } },
            required: ['job_id', 'status'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            404: [E('job_not_found', ERR.job_not_found)],
            409: [E('job_already_finished', ERR.job_already_finished)],
          }),
        },
      },
    },
    '/v1/templates': {
      get: {
        tags: ['templates'],
        summary: 'List stored templates',
        security: AUTH_SECURED,
        responses: {
          200: json({
            type: 'object',
            properties: {
              templates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    options: { type: 'object' },
                    html_bytes: { type: 'integer' },
                    updated_at: { type: 'string', format: 'date-time' },
                  },
                  required: ['name', 'options', 'html_bytes', 'updated_at'],
                },
              },
            },
            required: ['templates'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE),
        },
      },
    },
    '/v1/templates/{name}': {
      put: {
        tags: ['templates'],
        summary: 'Create or replace a stored template',
        description: 'Names are 1-64 characters of letters, digits, spaces, dot, dash or underscore; the body is up to 2 MB of HTML with {{placeholders}}. Optional "options" are validated immediately. The response includes the placeholders the template uses and a ready-to-paste "data" shape.',
        security: AUTH_SECURED,
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: json({
          type: 'object',
          required: ['html'],
          properties: {
            html: { type: 'string', description: 'Template markup with {{placeholders}}, {{#sections}} and {{{raw}}} markers.' },
            options: { type: 'object', description: 'PDF page options (same names as PdfOptions, without the content fields); unknown keys are refused.' },
          },
        }),
        responses: {
          200: json({
            type: 'object',
            properties: {
              template: { type: 'object', properties: { name: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' } }, required: ['name', 'updated_at'] },
              placeholders: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['scalar', 'raw', 'section', 'inverted'] }, scope: { type: 'string' } },
                  required: ['name', 'kind'],
                },
              },
              usage: {
                type: 'object',
                properties: {
                  template: { type: 'string' },
                  data: { type: 'object', description: 'A minimal "data" object of the right shape for this template.' },
                },
                required: ['template', 'data'],
              },
            },
            required: ['template', 'placeholders', 'usage'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            400: [
              E('invalid_template_name', ERR.invalid_template_name),
              E('missing_content', ERR.missing_content),
              E('template_too_large', ERR.template_too_large),
              E('unknown_field', ERR.unknown_field),
              E('invalid_option', ERR.invalid_option),
            ],
          }),
        },
      },
      get: {
        tags: ['templates'],
        summary: 'Fetch a stored template',
        security: AUTH_SECURED,
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: json({
            type: 'object',
            properties: {
              name: { type: 'string' },
              html: { type: 'string' },
              options: { type: 'object' },
              updated_at: { type: 'string', format: 'date-time' },
              placeholders: { type: 'array', items: { type: 'object' } },
              usage: { type: 'object', properties: { template: { type: 'string' }, data: { type: 'object' } } },
            },
            required: ['name', 'html', 'options', 'updated_at', 'placeholders', 'usage'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            400: [E('template_not_found', ERR.template_not_found)],
          }),
        },
      },
      delete: {
        tags: ['templates'],
        summary: 'Delete a stored template',
        security: AUTH_SECURED,
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: json({ type: 'object', properties: { deleted: { type: 'string' } }, required: ['deleted'] }),
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            400: [E('template_not_found', ERR.template_not_found)],
          }),
        },
      },
    },
    '/v1/keys': {
      post: {
        tags: ['keys'],
        summary: 'Issue a new API key',
        description: 'Returns the full key once; it cannot be read back afterwards. Optional "label" is truncated to 40 characters.',
        security: AUTH_SECURED,
        requestBody: json({
          type: 'object',
          properties: { label: { type: 'string', default: 'default', maxLength: 40 } },
        }),
        responses: {
          200: json({ type: 'object', properties: { api_key: { type: 'string', description: 'Starts with pm_live_.' } }, required: ['api_key'] }),
          ...errors(ERRORS.AUTH, ERRORS.RATE),
        },
      },
      get: {
        tags: ['keys'],
        summary: 'List active API keys',
        security: AUTH_SECURED,
        responses: {
          200: json({
            type: 'object',
            properties: {
              keys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key_prefix: { type: 'string' },
                    label: { type: 'string' },
                    created_at: { type: 'string', format: 'date-time' },
                    last_used_at: { type: 'string', format: 'date-time', nullable: true },
                  },
                  required: ['key_prefix', 'label', 'created_at'],
                },
              },
            },
            required: ['keys'],
          }),
          ...errors(ERRORS.AUTH, ERRORS.RATE),
        },
      },
    },
    '/v1/keys/{prefix}': {
      delete: {
        tags: ['keys'],
        summary: 'Revoke an API key by its prefix',
        description: 'Takes effect on the next request. Refuses to revoke the account’s last remaining key.',
        security: AUTH_SECURED,
        parameters: [{ name: 'prefix', in: 'path', required: true, schema: { type: 'string' }, description: 'The key_prefix from GET /v1/keys.' }],
        responses: {
          200: json({ type: 'object', properties: { revoked: { type: 'string' } }, required: ['revoked'] }),
          ...errors(ERRORS.AUTH, ERRORS.RATE, {
            404: [E('key_not_found', ERR.key_not_found)],
            409: [E('last_key', ERR.last_key)],
          }),
        },
      },
    },
    '/v1/forgot-password': {
      post: {
        tags: ['recovery'],
        summary: 'Request a password-reset link',
        description: 'Always answers the same whether or not the account exists. Rate-limited to 20 attempts per hour per address.',
        security: [],
        requestBody: json({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }),
        responses: {
          202: json({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }),
          400: errResponse(400, [E('invalid_email', ERR.invalid_email)], '`invalid_email` — the address is not valid.'),
          429: errResponse(429, [E('rate_limited', ERR.rate_limited)], '`rate_limited` — more than 20 recovery attempts in one hour.'),
          503: errResponse(503, [E('recovery_unavailable', ERR.recovery_unavailable)], '`recovery_unavailable` — email delivery is temporarily down.'),
        },
      },
    },
    '/v1/reset-password': {
      post: {
        tags: ['recovery'],
        summary: 'Complete a password reset',
        description: 'Consumes the single-use token from the reset email (valid 30 minutes). Password: at least 8 characters, at most 72 UTF-8 bytes.',
        security: [],
        requestBody: json({ type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string', minLength: 8 } } }),
        responses: {
          200: json({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }),
          400: errResponse(400, [E('invalid_reset_token', ERR.invalid_reset_token), E('invalid_password', ERR.invalid_password)], '`invalid_reset_token` or `invalid_password`.'),
          429: errResponse(429, [E('rate_limited', ERR.rate_limited)], '`rate_limited` — more than 20 recovery attempts in one hour.'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Authorization: Bearer pm_live_...',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'x-api-key: pm_live_...',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        description: 'The error wire shape of src/errors.js: { error: { code, message } }, with optional hint, docs, details and request_id.',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'A stable machine-readable code, e.g. unknown_field.' },
              message: { type: 'string', description: 'A one-line human message.' },
              hint: { type: 'string', description: 'A concrete suggestion of what to change. Present when the error has one.' },
              docs: { type: 'string', description: 'Absolute URL of the relevant docs anchor. Present when the error has one.' },
              details: { type: 'object', description: 'Extra machine-readable facts, e.g. { unknown: [...] }. Present when the error has them.' },
              request_id: { type: 'string', description: 'The X-Request-Id of the request; quote it when reporting.' },
            },
            required: ['code', 'message'],
          },
        },
        required: ['error'],
      },
      FileJson,
      Job,
    },
  },
};

module.exports = { spec, ERR };
