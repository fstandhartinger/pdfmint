#!/usr/bin/env node
'use strict';

/**
 * Writes the shared header, footer and "related pages" block into every static
 * page in public/. The pages are plain HTML served by express.static, so the
 * chrome is stamped in between marker comments instead of being rendered:
 *
 *   <!-- l-header --> … <!-- /l-header -->
 *   <!-- l-footer --> … <!-- /l-footer -->
 *   <!-- l-related --> … <!-- /l-related -->   (guide pages only)
 *
 *   node scripts/site-chrome.js          rewrite the pages
 *   node scripts/site-chrome.js --check  exit 1 if any page is stale
 *
 * The same header/footer markup (and the same landing.css class names) is used
 * by DocMint and MailMint, so the three sites read as one family.
 */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

const NAV = [
  ['/#how', 'How it works'],
  ['/#n8n', 'n8n'],
  ['/zapier', 'Zapier beta'],
  ['/#pricing', 'Pricing'],
  ['/docs', 'Docs'],
];

/** Every guide page, with the one-line summary used in related-page blocks. */
const GUIDES = {
  '/html-to-pdf-api': ['HTML to PDF API', 'What the job involves, when to self-host, and what six products charge.'],
  '/invoice-pdf-api': ['Invoice PDF API', 'A stored template with line items, VAT totals and a per-page footer.'],
  '/markdown-to-pdf-api': ['Markdown to PDF API', 'GFM tables, fenced code and page numbers without pandoc or LaTeX.'],
  '/url-to-pdf-api': ['URL to PDF API', 'Capturing a live page, waiting for it to finish, and what a login wall does.'],
  '/merge-pdf-api': ['Merge PDF API', 'Up to 50 PDFs from URLs and base64 in one request, one credit.'],
  '/password-protect-pdf-api': ['Password-protect PDF API', 'AES-256 encryption, owner password and print/copy permissions on every plan.'],
  '/html-to-image-api': ['HTML to image API', 'PNG or JPEG from HTML, Markdown or a URL with the same request shape.'],
  '/n8n-html-to-pdf': ['HTML to PDF in n8n', 'The three ways to do it in a workflow, including two without us.'],
  '/n8n-templates': ['n8n workflow templates', 'Reviewed n8n gallery workflows that generate PDFs.'],
  '/zapier': ['Zapier (private beta)', 'Generate, render, and merge PDFs inside a Zap.'],
  '/pdfshift-alternative': ['PDFMint vs PDFShift', 'The current FAQ lists $24 for 2,500 credits; billing is by 5 MB of output.'],
  '/craftmypdf-alternative': ['PDFMint vs CraftMyPDF', 'Their designer against our HTML-first API, with prices.'],
  '/pdfmonkey-alternative': ['PDFMint vs PDFMonkey', 'Starter is €5 for 300 docs with one-day retention; Pro+ is €60 for 5,000 with unlimited retention.'],
};

/** Which guides each guide page links to. */
const RELATED = {
  '/html-to-pdf-api': ['/invoice-pdf-api', '/url-to-pdf-api', '/pdfshift-alternative', '/n8n-html-to-pdf'],
  '/invoice-pdf-api': ['/html-to-pdf-api', '/password-protect-pdf-api', '/merge-pdf-api', '/n8n-templates'],
  '/markdown-to-pdf-api': ['/html-to-pdf-api', '/invoice-pdf-api', '/n8n-html-to-pdf', '/html-to-image-api'],
  '/url-to-pdf-api': ['/html-to-image-api', '/html-to-pdf-api', '/merge-pdf-api', '/markdown-to-pdf-api'],
  '/merge-pdf-api': ['/password-protect-pdf-api', '/invoice-pdf-api', '/url-to-pdf-api', '/html-to-pdf-api'],
  '/password-protect-pdf-api': ['/invoice-pdf-api', '/merge-pdf-api', '/craftmypdf-alternative', '/html-to-pdf-api'],
  '/html-to-image-api': ['/url-to-pdf-api', '/html-to-pdf-api', '/markdown-to-pdf-api', '/n8n-html-to-pdf'],
  '/n8n-html-to-pdf': ['/n8n-templates', '/zapier', '/invoice-pdf-api', '/html-to-pdf-api'],
  '/n8n-templates': ['/n8n-html-to-pdf', '/invoice-pdf-api', '/markdown-to-pdf-api', '/zapier'],
  '/zapier': ['/n8n-html-to-pdf', '/n8n-templates', '/html-to-pdf-api', '/merge-pdf-api'],
  '/pdfshift-alternative': ['/craftmypdf-alternative', '/pdfmonkey-alternative', '/html-to-pdf-api', '/url-to-pdf-api'],
  '/craftmypdf-alternative': ['/pdfshift-alternative', '/pdfmonkey-alternative', '/invoice-pdf-api', '/password-protect-pdf-api'],
  '/pdfmonkey-alternative': ['/pdfshift-alternative', '/craftmypdf-alternative', '/html-to-pdf-api', '/invoice-pdf-api'],
};

const PAGES = {
  'index.html': '/',
  'docs.html': '/docs',
  'legal.html': '/legal',
  'privacy.html': '/privacy',
  'terms.html': '/terms',
};
for (const route of Object.keys(GUIDES)) PAGES[`${route.slice(1)}.html`] = route;

const MARK = '<svg class="l-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="2.5" width="17" height="19" rx="3" stroke="currentColor" stroke-width="1.7"/><path class="a" d="M7.8 9.2h3.1a2.2 2.2 0 0 1 0 4.4H7.8V9.2zm0 4.4V17" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path class="a" d="M13.9 17V9.2l1.6 2.6 1.6-2.6V17" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const THEME_BUTTON = '<button class="l-theme" type="button" aria-label="Switch theme"><svg class="i-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><svg class="i-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>';

function header(route) {
  const links = NAV.map(([href, label]) =>
    `      <a href="${href}"${href === route ? ' aria-current="page"' : ''}>${label}</a>`).join('\n');
  return `<header class="l-top">
  <div class="wrap">
    <a class="logo" href="/" aria-label="PDFMint home">
      ${MARK}
      PDF<span>Mint</span>
    </a>
    <nav class="l-nav" aria-label="Main">
${links}
    </nav>
    <div class="l-actions">
      ${THEME_BUTTON}
      <a class="l-link hide-xs" href="/docs">Docs</a>
      <a class="l-link" href="/login">Sign in</a>
      <a class="l-btn l-btn-primary" href="/signup">Start free</a>
    </div>
  </div>
</header>`;
}

function footer() {
  const li = (href, label, rel) => `<li><a href="${href}"${rel ? ` rel="${rel}"` : ''}>${label}</a></li>`;
  return `<footer class="l-foot">
  <div class="wrap">
    <div class="l-foot-grid">
      <div class="l-foot-brand">
        <a class="logo" href="/" aria-label="PDFMint home">${MARK} PDF<span>Mint</span></a>
        <p>HTML, Markdown or a URL in, PDF bytes out. A PDF generation API and verified n8n node, built and run by Florian Standhartinger.</p>
      </div>
      <nav aria-labelledby="f-product"><h2 id="f-product">Product</h2><ul>
        ${li('/#pricing', 'Pricing')}
        ${li('/docs', 'API reference')}
        ${li('/openapi.json', 'OpenAPI 3.1 (JSON)')}
        ${li('/status', 'Status')}
        ${li('/login', 'Sign in')}
        ${li('/signup', 'Create account')}
      </ul></nav>
      <nav aria-labelledby="f-guides"><h2 id="f-guides">Guides</h2><ul>
        ${li('/html-to-pdf-api', 'HTML to PDF API')}
        ${li('/invoice-pdf-api', 'Invoice PDF API')}
        ${li('/markdown-to-pdf-api', 'Markdown to PDF')}
        ${li('/url-to-pdf-api', 'URL to PDF')}
        ${li('/merge-pdf-api', 'Merge PDFs')}
        ${li('/password-protect-pdf-api', 'Password-protect PDFs')}
        ${li('/html-to-image-api', 'HTML to image')}
      </ul></nav>
      <nav aria-labelledby="f-integ"><h2 id="f-integ">Integrations &amp; comparisons</h2><ul>
        ${li('/n8n-html-to-pdf', 'n8n node')}
        ${li('/n8n-templates', 'n8n templates')}
        ${li('/zapier', 'Zapier beta')}
        ${li('/pdfshift-alternative', 'vs PDFShift')}
        ${li('/craftmypdf-alternative', 'vs CraftMyPDF')}
        ${li('/pdfmonkey-alternative', 'vs PDFMonkey')}
      </ul></nav>
      <nav aria-labelledby="f-family"><h2 id="f-family">Mint APIs family</h2><ul>
        ${li('https://docmint.app.mintapis.com/', 'DocMint &mdash; Word, Excel &amp; PowerPoint')}
        ${li('https://mailmint.app.mintapis.com/', 'MailMint &mdash; inbound email to JSON')}
        ${li('https://www.npmjs.com/package/n8n-nodes-pdfmint', 'n8n-nodes-pdfmint on npm', 'noopener')}
        ${li('https://github.com/fstandhartinger/pdfmint', 'Source on GitHub', 'noopener')}
      </ul></nav>
    </div>
    <div class="l-foot-base">
      <span>&copy; 2026 productivity-boost.com Betriebs UG (haftungsbeschr&auml;nkt) &amp; Co. KG</span>
      <nav aria-label="Legal">
        <a href="/legal">Imprint</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/llms.txt">llms.txt</a>
      </nav>
    </div>
  </div>
</footer>`;
}

function related(route) {
  const list = RELATED[route];
  if (!list) return '';
  const tiles = list.map((r) => {
    const [title, text] = GUIDES[r];
    return `      <a class="tile" href="${r}"><h3>${title}</h3><p>${text}</p></a>`;
  }).join('\n');
  return `<aside class="l-related" aria-labelledby="related-title">
  <div class="wrap">
    <h2 id="related-title">Related guides</h2>
    <div class="grid grid-4">
${tiles}
    </div>
  </div>
</aside>`;
}

function stamp(html, name, content) {
  const re = new RegExp(`(<!-- ${name} -->)[\\s\\S]*?(<!-- /${name} -->)`);
  if (!re.test(html)) return html;
  return html.replace(re, (_match, open, close) => `${open}\n${content}\n${close}`);
}

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, route] of Object.entries(PAGES)) {
  const full = path.join(PUBLIC, file);
  if (!fs.existsSync(full)) continue;
  const before = fs.readFileSync(full, 'utf8');
  let after = stamp(before, 'l-header', header(route));
  after = stamp(after, 'l-footer', footer());
  after = stamp(after, 'l-related', related(route));
  if (after !== before) {
    stale++;
    if (check) console.log(`stale: ${file}`);
    else fs.writeFileSync(full, after);
  }
}
if (check && stale) process.exitCode = 1;
else console.log(check ? 'all pages current' : `updated ${stale} page(s)`);
