'use strict';

const { marked } = require('marked');

/**
 * The print stylesheet used for Markdown input. It exists so that
 * `markdown` -> PDF looks like a finished document without the caller
 * writing any CSS: real typography, tables that do not split mid-row,
 * headings that do not sit alone at the bottom of a page, and code that wraps.
 */
const MARKDOWN_CSS = `
:root { --ink:#1a1a1a; --muted:#5b6270; --rule:#d8dce3; --accent:#0b5cff; --code-bg:#f5f6f8; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, "Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Liberation Sans", Helvetica, Arial, "Noto Sans", "Noto Color Emoji", sans-serif;
  font-size: 11pt; line-height: 1.6; color: var(--ink);
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.pdfmint-md { max-width: 100%; }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.4em 0 .5em; font-weight:650; break-after:avoid; page-break-after:avoid; }
h1 { font-size:22pt; margin-top:0; letter-spacing:-.01em; }
h2 { font-size:16pt; border-bottom:1px solid var(--rule); padding-bottom:.25em; }
h3 { font-size:13pt; }
h4,h5,h6 { font-size:11pt; color:var(--muted); text-transform:none; }
p, ul, ol, blockquote, table, pre { margin:0 0 .85em; }
ul, ol { padding-left:1.4em; }
li { margin:.2em 0; }
li > ul, li > ol { margin:.2em 0; }
a { color:var(--accent); text-decoration:none; word-break:break-word; }
blockquote { margin-left:0; padding:.1em 0 .1em 1em; border-left:3px solid var(--rule); color:var(--muted); }
hr { border:0; border-top:1px solid var(--rule); margin:1.6em 0; }
img { max-width:100%; height:auto; }
code { font-family:"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Liberation Mono", Consolas, monospace; font-size:.88em;
       background:var(--code-bg); padding:.15em .35em; border-radius:3px; }
pre { background:var(--code-bg); padding:.8em 1em; border-radius:6px; overflow:visible; white-space:pre-wrap; word-wrap:break-word; break-inside:avoid; }
pre code { background:none; padding:0; font-size:.85em; }
table { border-collapse:collapse; width:100%; font-size:.95em; break-inside:auto; }
thead { display:table-header-group; }
tr { break-inside:avoid; page-break-inside:avoid; }
th, td { border:1px solid var(--rule); padding:.45em .6em; text-align:left; vertical-align:top; }
th { background:#f0f2f5; font-weight:600; }
tbody tr:nth-child(even) td { background:#fafbfc; }
input[type=checkbox] { margin-right:.4em; }
`.trim();

marked.setOptions({ gfm: true, breaks: false });

function markdownToHtml(md, opts = {}) {
  const body = marked.parse(String(md));
  const title = opts.title ? String(opts.title) : 'Document';
  const extraCss = opts.css ? String(opts.css) : '';
  // Inter and JetBrains Mono are installed in the container, so the default
  // Markdown look needs no network round-trip. Callers who want a specific web
  // font can pass `googleFonts: "Playfair Display:wght@700"` (or their own <link> in `css`).
  const fonts = opts.googleFonts
    ? `<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(String(opts.googleFonts)).replace(/%3A/gi, ':').replace(/%40/g, '@').replace(/%3B/gi, ';').replace(/%2C/gi, ',')}&display=swap" rel="stylesheet">`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>${fonts}` +
    `<style>${MARKDOWN_CSS}\n${extraCss}</style></head>` +
    `<body><div class="pdfmint-md">${body}</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { markdownToHtml, MARKDOWN_CSS, escapeHtml };
