'use strict';

const { bad } = require('./errors');

const FORMATS = ['A0','A1','A2','A3','A4','A5','A6','Letter','Legal','Tabloid','Ledger'];
const FORMAT_LOOKUP = new Map(FORMATS.map((f) => [f.toLowerCase(), f]));

const LENGTH_RE = /^-?\d+(\.\d+)?(px|in|cm|mm|pt|pc)?$/i;

function asLength(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw bad('invalid_option', `"${field}" must be a finite number.`);
    return `${value}px`;
  }
  const s = String(value).trim();
  if (!LENGTH_RE.test(s)) {
    throw bad('invalid_option', `"${field}" is not a valid length: ${JSON.stringify(value)}.`, {
      hint: 'Use a CSS length such as "10mm", "0.5in", "12pt" or a plain number (interpreted as px).',
      docs: '/docs#options',
    });
  }
  return /[a-z]$/i.test(s) ? s : `${s}px`;
}

function toMm(len) {
  if (!len) return 0;
  const m = /^(-?\d+(?:\.\d+)?)(px|in|cm|mm|pt|pc)?$/i.exec(String(len).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'px').toLowerCase()) {
    case 'mm': return n;
    case 'cm': return n * 10;
    case 'in': return n * 25.4;
    case 'pt': return (n / 72) * 25.4;
    case 'pc': return (n / 6) * 25.4;
    default:   return (n / 96) * 25.4; // px at 96dpi
  }
}

function asBool(value, field, dflt) {
  if (value === undefined || value === null || value === '') return dflt;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw bad('invalid_option', `"${field}" must be true or false, got ${JSON.stringify(value)}.`);
}

function normaliseMargin(raw, field = 'margin') {
  if (raw === undefined || raw === null || raw === '') return { top: '0', right: '0', bottom: '0', left: '0' };
  if (typeof raw === 'string' || typeof raw === 'number') {
    const all = asLength(raw, field);
    return { top: all, right: all, bottom: all, left: all };
  }
  if (typeof raw !== 'object') throw bad('invalid_option', `"${field}" must be a length or an object with top/right/bottom/left.`);
  return {
    top: asLength(raw.top, `${field}.top`) || '0',
    right: asLength(raw.right, `${field}.right`) || '0',
    bottom: asLength(raw.bottom, `${field}.bottom`) || '0',
    left: asLength(raw.left, `${field}.left`) || '0',
  };
}

const HF_STYLE =
  "width:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  'font-size:9pt;line-height:1.35;color:#555;-webkit-print-color-adjust:exact;print-color-adjust:exact;';

/**
 * Chrome renders header/footer templates in their own document with a default
 * font-size of 0 and no page padding, which is why so many people end up with a
 * blank strip where their header should be. We always wrap the caller's markup
 * in a container that has a readable size and lines up with the page margins.
 * Styles the caller sets on their own elements still win, because they are
 * nested inside this one.
 */
const MIN_HF_SIDE_PADDING_MM = 12;
function wrapHeaderFooter(html, margin) {
  const pad = (side) => (toMm(margin[side]) >= MIN_HF_SIDE_PADDING_MM ? margin[side] : `${MIN_HF_SIDE_PADDING_MM}mm`);
  return `<div style="${HF_STYLE}padding:0 ${pad('right')} 0 ${pad('left')};">${html}</div>`;
}

function pageNumberTemplate(spec) {
  const tpl = typeof spec === 'string' && spec.trim() ? spec : 'Page {page} of {total}';
  const body = tpl
    .replace(/\{page\}/g, '<span class="pageNumber"></span>')
    .replace(/\{total\}/g, '<span class="totalPages"></span>')
    .replace(/\{date\}/g, '<span class="date"></span>')
    .replace(/\{title\}/g, '<span class="title"></span>')
    .replace(/\{url\}/g, '<span class="url"></span>');
  return `<div style="width:100%;text-align:center;">${body}</div>`;
}

/** Chrome silently clips header/footer that does not fit in the page margin. */
const MIN_HF_MARGIN_MM = 15;
function ensureRoomFor(margin, side) {
  if (toMm(margin[side]) < MIN_HF_MARGIN_MM) margin[side] = `${MIN_HF_MARGIN_MM}mm`;
}

function normalisePdfOptions(input = {}) {
  const o = input || {};
  const warnings = [];

  let format;
  if (o.format !== undefined && o.format !== null && o.format !== '') {
    format = FORMAT_LOOKUP.get(String(o.format).trim().toLowerCase());
    if (!format) {
      throw bad('invalid_option', `"format" must be one of ${FORMATS.join(', ')} — got ${JSON.stringify(o.format)}.`, {
        hint: 'Use "A4" for metric paper or "Letter" for US paper. To use a custom size, set "width" and "height" instead of "format".',
        docs: '/docs#options',
      });
    }
  }
  const width = asLength(o.width, 'width');
  const height = asLength(o.height, 'height');
  if ((width && !height) || (height && !width)) {
    throw bad('invalid_option', 'Custom page sizes need both "width" and "height".', {
      hint: 'Either set both width and height, or drop them and use "format" instead.',
      docs: '/docs#options',
    });
  }
  if (format && width) warnings.push('Both "format" and "width"/"height" were given; the custom width/height wins.');

  const margin = normaliseMargin(o.margin);

  const scale = o.scale === undefined || o.scale === '' ? 1 : Number(o.scale);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
    throw bad('invalid_option', `"scale" must be between 0.1 and 2 — got ${JSON.stringify(o.scale)}.`, {
      hint: 'Chrome only accepts a print scale in that range. Use 1 for 100%.',
      docs: '/docs#options',
    });
  }

  let headerHtml = o.headerHtml || o.headerTemplate || null;
  let footerHtml = o.footerHtml || o.footerTemplate || null;
  if (o.pageNumbers) footerHtml = footerHtml || pageNumberTemplate(o.pageNumbers === true ? null : o.pageNumbers);

  const displayHeaderFooter = Boolean(headerHtml || footerHtml);
  if (displayHeaderFooter) {
    if (headerHtml) ensureRoomFor(margin, 'top'); else headerHtml = '<span></span>';
    if (footerHtml) ensureRoomFor(margin, 'bottom'); else footerHtml = '<span></span>';
    headerHtml = wrapHeaderFooter(headerHtml, margin);
    footerHtml = wrapHeaderFooter(footerHtml, margin);
  }

  const mediaType = o.mediaType ? String(o.mediaType).toLowerCase() : 'print';
  if (!['print', 'screen'].includes(mediaType)) {
    throw bad('invalid_option', `"mediaType" must be "print" or "screen" — got ${JSON.stringify(o.mediaType)}.`, {
      hint: 'Use "screen" when your CSS was written for the browser and you do not want @media print rules applied.',
      docs: '/docs#options',
    });
  }

  const pageRanges = o.pageRanges ? String(o.pageRanges).trim() : undefined;

  return {
    format: width ? undefined : (format || 'A4'),
    width, height,
    landscape: asBool(o.landscape, 'landscape', false),
    margin,
    scale,
    printBackground: asBool(o.printBackground, 'printBackground', true),
    displayHeaderFooter,
    headerTemplate: displayHeaderFooter ? headerHtml : undefined,
    footerTemplate: displayHeaderFooter ? footerHtml : undefined,
    preferCSSPageSize: asBool(o.preferCssPageSize ?? o.preferCSSPageSize, 'preferCssPageSize', false),
    pageRanges,
    mediaType,
    tagged: asBool(o.tagged, 'tagged', true),
    outline: asBool(o.outline, 'outline', false),
    warnings,
  };
}

module.exports = { normalisePdfOptions, normaliseMargin, asLength, asBool, toMm, FORMATS };
