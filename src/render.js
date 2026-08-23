'use strict';

const { chromium } = require('playwright');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { config } = require('./config');
const { ApiError, bad } = require('./errors');
const { assertPublicUrl, isPrivateAddress } = require('./net');

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ browser */

let browserPromise = null;

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--hide-scrollbars',
  '--mute-audio',
];

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: LAUNCH_ARGS }).then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

async function warmup() {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body>warmup</body></html>');
  await page.pdf({ format: 'A4' });
  await ctx.close();
  return true;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

/* ---------------------------------------------------------------- semaphore */

let active = 0;
const waiters = [];

function acquire() {
  if (active < config.maxConcurrentRenders) { active += 1; return Promise.resolve(); }
  if (waiters.length >= config.renderQueueLimit) {
    return Promise.reject(new ApiError(503, 'renderer_busy', 'PDFMint is at capacity right now.', {
      hint: 'Retry in a few seconds.',
      docs: '/docs#limits',
    }));
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next(); else active = Math.max(0, active - 1);
}

const stats = () => ({ active, queued: waiters.length });

/* -------------------------------------------------------------- page set-up */

const READY_SCRIPT = `(async () => {
  // Chrome downloads a @font-face only once a glyph needs it, and page.pdf()
  // relayouts for print — which can pull in a weight that was never requested
  // on screen. Force every declared face to load first so nothing falls back
  // to a system font halfway through the document.
  if (document.fonts) {
    try {
      const faces = Array.from(document.fonts).slice(0, 60);
      await Promise.race([
        Promise.all(faces.map((f) => (f.status === 'unloaded' ? f.load().catch(() => {}) : null))),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } catch (e) {}
  }
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  const imgs = Array.from(document.images || []);
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return null;
    if (img.complete) return null;
    return new Promise((res) => {
      const done = () => res();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 5000);
    });
  }));
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
})()`;

async function guardRoutes(page) {
  if (config.allowPrivateNetwork) return;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    try {
      const u = new URL(url);
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue();
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort('blockedbyclient');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (/^(localhost|localhost\.localdomain|metadata\.google\.internal)$/i.test(host)) return route.abort('blockedbyclient');
      if (/^[\d.]+$/.test(host) || host.includes(':')) {
        if (isPrivateAddress(host)) return route.abort('blockedbyclient');
      }
      return route.continue();
    } catch {
      return route.abort('blockedbyclient');
    }
  });
}

async function applyWait(page, waitFor, deadlineMs) {
  if (waitFor === undefined || waitFor === null || waitFor === '') return;
  if (typeof waitFor === 'number' || /^\d+$/.test(String(waitFor))) {
    const ms = Math.min(Number(waitFor), deadlineMs);
    if (ms > 0) await page.waitForTimeout(ms);
    return;
  }
  const s = String(waitFor).trim();
  if (s === 'networkidle') { await page.waitForLoadState('networkidle', { timeout: deadlineMs }); return; }
  if (s === 'load' || s === 'domcontentloaded') { await page.waitForLoadState(s, { timeout: deadlineMs }); return; }
  try {
    await page.waitForSelector(s, { timeout: deadlineMs, state: 'attached' });
  } catch {
    throw new ApiError(504, 'wait_for_timeout', `Timed out waiting for "${s}" to appear on the page.`, {
      hint: 'Check the selector, or pass a number of milliseconds instead, for example waitFor: 1000.',
      docs: '/docs#waitfor',
    });
  }
}

/* ------------------------------------------------------------------- render */

function normaliseChromeError(e, source) {
  const msg = String(e && e.message ? e.message : e);
  // These are upstream failures, not malformed requests. 502 says so, and says
  // it is worth retrying, which a 400 would not.
  if (/net::ERR_NAME_NOT_RESOLVED/.test(msg)) {
    return new ApiError(502, 'url_unreachable', 'The URL could not be resolved.', {
      hint: 'Check the hostname. PDFMint fetches the page from its own servers, so the host must be publicly resolvable.',
      docs: '/docs#url',
    });
  }
  if (/net::ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_TIMED_OUT|net::ERR_ADDRESS_UNREACHABLE/.test(msg)) {
    return new ApiError(502, 'url_unreachable', 'The URL refused the connection or did not respond.', {
      hint: 'PDFMint fetches the page from its own servers. If the page needs a login or sits behind a firewall, fetch it yourself and send the result as "html".',
      docs: '/docs#url',
    });
  }
  if (/net::ERR_CERT|SSL/.test(msg)) {
    return new ApiError(502, 'url_unreachable', 'The URL has an invalid TLS certificate.', { docs: '/docs#url' });
  }
  if (/Timeout .* exceeded|page\.goto: Timeout|exceeded while waiting/i.test(msg)) {
    return new ApiError(504, 'render_timeout', `Rendering timed out${source ? ` while loading the ${source}` : ''}.`, {
      hint: 'Raise "timeout", or set waitFor to a fixed number of milliseconds instead of "networkidle" if the page keeps polling in the background.',
      docs: '/docs#timeout',
    });
  }
  if (/Target (page|closed)|Protocol error|browser has been closed|crashed/i.test(msg)) {
    return new ApiError(500, 'renderer_crashed', 'The renderer crashed while producing this document.', {
      hint: 'This is usually a very large or very complex page. Try splitting it, or reducing image sizes.',
      docs: '/docs#limits',
    });
  }
  return null;
}

/**
 * @param {object} job
 *   { html?, url?, source: 'html'|'url'|'markdown', options, timeoutMs, kind: 'pdf'|'image', image? }
 */
async function render(job) {
  await acquire();
  const started = Date.now();
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: job.kind === 'image'
        ? { width: job.image.width || 1280, height: job.image.height || 800 }
        : { width: 1280, height: 1024 },
      deviceScaleFactor: job.kind === 'image' ? (job.image.deviceScaleFactor || 2) : 1,
      javaScriptEnabled: job.javascript !== false,
      bypassCSP: true,
      colorScheme: job.emulateDarkMode ? 'dark' : 'light',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 PDFMint/1.0',
      extraHTTPHeaders: job.headers || undefined,
    });
    context.setDefaultTimeout(job.timeoutMs);
    context.setDefaultNavigationTimeout(job.timeoutMs);
    await guardRoutes(context);

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => { if (consoleErrors.length < 5) consoleErrors.push(String(e.message).slice(0, 200)); });

    if (job.url) {
      const resp = await page.goto(job.url, { waitUntil: 'load', timeout: job.timeoutMs });
      if (resp && resp.status() >= 400) {
        // The request was fine; the page we were pointed at was not.
        throw new ApiError(502, 'url_http_error', `The URL returned HTTP ${resp.status()}.`, {
          hint: 'PDFMint renders whatever the URL returns. A 401 or 403 usually means the page needs a login — fetch it yourself and send the result as "html".',
          docs: '/docs#url',
          details: { upstream_status: resp.status() },
        });
      }
    } else {
      await page.setContent(job.html, { waitUntil: 'load', timeout: job.timeoutMs });
    }

    const remaining = () => Math.max(1000, job.timeoutMs - (Date.now() - started));
    try { await page.evaluate(READY_SCRIPT); } catch { /* fonts/images best-effort */ }
    await applyWait(page, job.waitFor, remaining());

    if (job.kind === 'image') {
      const buf = await page.screenshot({
        type: job.image.type,
        quality: job.image.type === 'jpeg' ? job.image.quality : undefined,
        fullPage: job.image.fullPage !== false,
        omitBackground: job.image.omitBackground === true,
      });
      return { buffer: buf, durationMs: Date.now() - started, consoleErrors };
    }

    const debug = job.debug
      ? {
          renderedHtml: await page.content().catch(() => null),
          finalUrl: page.url(),
          pageErrors: consoleErrors,
        }
      : null;

    const o = job.options;
    if (o.displayHeaderFooter) {
      // Costs nothing when the header has no image, and this is the last point
      // at which the header markup is still ours to change.
      const notes = await inlineHeaderFooterImages(o);
      if (notes.length && Array.isArray(o.warnings)) o.warnings.push(...notes);
    }
    if (o.mediaType === 'screen') await page.emulateMedia({ media: 'screen' });
    else await page.emulateMedia({ media: 'print' });

    const buf = await page.pdf({
      format: o.format,
      width: o.width,
      height: o.height,
      landscape: o.landscape,
      margin: o.margin,
      scale: o.scale,
      printBackground: o.printBackground,
      displayHeaderFooter: o.displayHeaderFooter,
      headerTemplate: o.headerTemplate,
      footerTemplate: o.footerTemplate,
      preferCSSPageSize: o.preferCSSPageSize,
      pageRanges: o.pageRanges,
      tagged: o.tagged,
      outline: o.outline,
      timeout: remaining(),
    });
    return { buffer: buf, durationMs: Date.now() - started, consoleErrors, debug };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const mapped = normaliseChromeError(e, job.url ? 'URL' : 'HTML');
    if (mapped) throw mapped;
    throw new ApiError(500, 'render_failed', `Rendering failed: ${String(e.message || e).slice(0, 300)}`, {
      docs: '/docs#errors',
    });
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

/* ------------------------------------------- header and footer image inlining */

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
const CSS_URL_RE = /(url\(\s*)(["']?)(https?:\/\/[^)"']+)\2(\s*\))/gi;

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

async function fetchAsDataUri(url) {
  await assertPublicUrl(url, 'header/footer image');
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = (new URL(url).pathname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const type = declared.startsWith('image/') ? declared : (MIME_BY_EXT[ext] || 'application/octet-stream');
  if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INLINE_IMAGE_BYTES) throw new Error(`${(buf.length / 1048576).toFixed(1)} MB is over the 2 MB limit for header images`);
  return `data:${type};base64,${buf.toString('base64')}`;
}

/**
 * Chrome renders header and footer templates in a separate document that cannot
 * load external resources, so <img src="https://…"> in a header silently draws
 * nothing. This is one of the most-hit traps in headless-Chrome PDF generation.
 * We fetch those images ourselves and inline them as data URIs, so a logo in a
 * header behaves the way everyone expects it to.
 */
async function inlineHeaderFooterImages(options) {
  const notes = [];
  const cache = new Map();

  const resolve = async (url) => {
    if (!cache.has(url)) {
      cache.set(url, fetchAsDataUri(url).catch((e) => {
        notes.push(`Could not inline the header/footer image ${url}: ${String(e.message).slice(0, 120)}`);
        return null;
      }));
    }
    return cache.get(url);
  };

  const rewrite = async (html) => {
    if (!html) return html;
    const urls = new Set();
    for (const m of html.matchAll(IMG_SRC_RE)) urls.add(m[3]);
    for (const m of html.matchAll(CSS_URL_RE)) urls.add(m[3]);
    if (!urls.size) return html;
    const resolved = new Map();
    await Promise.all([...urls].map(async (u) => resolved.set(u, await resolve(u))));
    return html
      .replace(IMG_SRC_RE, (full, head, q, url) => (resolved.get(url) ? `${head}${q}${resolved.get(url)}${q}` : full))
      .replace(CSS_URL_RE, (full, head, q, url, tail) => (resolved.get(url) ? `${head}${q}${resolved.get(url)}${q}${tail}` : full));
  };

  options.headerTemplate = await rewrite(options.headerTemplate);
  options.footerTemplate = await rewrite(options.footerTemplate);
  return notes;
}

/* ------------------------------------------------------------ post-process */

async function applyMetadata(buffer, meta) {
  if (!meta || !Object.keys(meta).length) return buffer;
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    if (meta.title) doc.setTitle(String(meta.title));
    if (meta.author) doc.setAuthor(String(meta.author));
    if (meta.subject) doc.setSubject(String(meta.subject));
    if (meta.keywords) {
      const kw = Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords).split(',').map((s) => s.trim());
      doc.setKeywords(kw.filter(Boolean));
    }
    if (meta.creator) doc.setCreator(String(meta.creator));
    doc.setProducer('PDFMint');
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch {
    return buffer; // never fail a render because metadata could not be written
  }
}

async function countPages(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false, throwOnInvalidObject: false });
    return doc.getPageCount();
  } catch {
    const m = String(buffer.subarray(0, buffer.length)).match(/\/Type\s*\/Page[^s]/g);
    return m ? m.length : null;
  }
}

let qpdfAvailable = null;
async function hasQpdf() {
  if (qpdfAvailable !== null) return qpdfAvailable;
  try { await execFileAsync('qpdf', ['--version']); qpdfAvailable = true; }
  catch { qpdfAvailable = false; }
  return qpdfAvailable;
}

async function encrypt(buffer, { password, ownerPassword, allowPrinting = true, allowCopying = false }) {
  if (!(await hasQpdf())) {
    throw new ApiError(501, 'encryption_unavailable', 'Password protection is not available on this deployment.', {
      docs: '/docs#password',
    });
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfmint-'));
  const inPath = path.join(dir, 'in.pdf');
  const outPath = path.join(dir, 'out.pdf');
  try {
    await fs.writeFile(inPath, buffer);
    const args = [
      inPath, '--encrypt', password, ownerPassword || crypto.randomBytes(18).toString('base64url'), '256',
      `--print=${allowPrinting ? 'full' : 'none'}`,
      `--extract=${allowCopying ? 'y' : 'n'}`,
      '--', outPath,
    ];
    await execFileAsync('qpdf', args);
    return await fs.readFile(outPath);
  } catch (e) {
    throw new ApiError(500, 'encryption_failed', `Could not password-protect the PDF: ${String(e.message || e).slice(0, 200)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const WATERMARK_FONTS = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  'times-roman': 'Times-Roman',
  courier: 'Courier',
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 0.6, g: 0.6, b: 0.6 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * Stamps diagonal text across every page. Done after rendering with pdf-lib so
 * it also works on a document the caller merged rather than rendered.
 */
async function addWatermark(buffer, spec) {
  const text = String(spec.text || '').trim();
  if (!text) {
    throw bad('invalid_option', '"watermark.text" is required when a watermark is requested.', {
      hint: 'For example: {"watermark": {"text": "DRAFT"}}.',
      docs: '/docs#watermark',
    });
  }
  const doc = await PDFDocument.load(buffer, { updateMetadata: false });
  const fontName = WATERMARK_FONTS[String(spec.font || 'helvetica-bold').toLowerCase()] || 'Helvetica-Bold';
  const font = await doc.embedFont(fontName);
  const { r, g, b } = hexToRgb(spec.color || '#9aa3b2');
  const opacity = Math.min(Math.max(spec.opacity === undefined ? 0.18 : Number(spec.opacity), 0.01), 1);
  const rotation = spec.rotation === undefined ? 45 : Number(spec.rotation);

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // Without an explicit size, size the text so its rotated bounding box fills
    // 85% of the page. widthOfTextAtSize is linear in size, so one measurement
    // is enough to solve for it.
    const unitWidth = font.widthOfTextAtSize(text, 100) / 100;
    const cos = Math.abs(Math.cos((rotation * Math.PI) / 180)) || 1e-6;
    const sin = Math.abs(Math.sin((rotation * Math.PI) / 180)) || 1e-6;
    const fitWidth = 0.85 * Math.min(width / cos, height / sin);
    const size = spec.fontSize
      ? Number(spec.fontSize)
      : Math.max(14, fitWidth / Math.max(unitWidth, 0.01));
    const textWidth = font.widthOfTextAtSize(text, size);
    const capHeight = font.heightAtSize(size) * 0.36;
    const rad = (rotation * Math.PI) / 180;
    // Centre the rotated baseline on the page.
    const x = width / 2 - (textWidth / 2) * Math.cos(rad) + capHeight * Math.sin(rad);
    const y = height / 2 - (textWidth / 2) * Math.sin(rad) - capHeight * Math.cos(rad);
    page.drawText(text, { x, y, size, font, color: rgb(r, g, b), opacity, rotate: degrees(rotation) });
  }
  return Buffer.from(await doc.save());
}

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (let i = 0; i < buffers.length; i += 1) {
    let src;
    try {
      src = await PDFDocument.load(buffers[i], { ignoreEncryption: true, throwOnInvalidObject: false });
    } catch (e) {
      throw bad('invalid_pdf', `Input ${i + 1} is not a readable PDF.`, {
        hint: 'Each input must be a PDF. Check that the URL returns a PDF and not an HTML error page.',
        docs: '/docs#merge',
      });
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer('PDFMint');
  return Buffer.from(await out.save());
}

module.exports = {
  render, warmup, closeBrowser, getBrowser,
  applyMetadata, countPages, encrypt, mergePdfs, addWatermark, hasQpdf, inlineHeaderFooterImages,
  stats, assertPublicUrl,
};
