'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(PUBLIC)
  .filter((file) => file.endsWith('.html') && !file.startsWith('google'));
// Keep the existing private-beta invitation route byte-for-byte unchanged in
// this refresh. The repository secret scanner flags its already-public invite
// link even when the file is not in the diff, so its SEO/schema refresh is
// deferred until the invitation flow has an owner-approved replacement.
const seoPages = pages.filter((file) => file !== 'zapier.html');

function read(file) {
  return fs.readFileSync(path.join(PUBLIC, file), 'utf8');
}

function decode(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&euro;/g, '€')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, key, value) {
  const attr = key === 'name' ? 'name' : 'property';
  const pattern = new RegExp(`<meta\\s+${attr}=["']${value}["']\\s+content=(["'])(.*?)\\1`, 'i');
  return html.match(pattern)?.[2] || '';
}

function ldJson(html) {
  return [...html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)]
    .map((match) => JSON.parse(match[1]));
}

function schemaNodes(value) {
  return value.flatMap((graph) => graph['@graph'] || [graph]);
}

test('refreshed public HTML pages have complete, bounded search and social metadata', () => {
  for (const file of seoPages) {
    const html = read(file);
    const title = decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const description = decode(meta(html, 'name', 'description'));
    const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)?.[1] || '';
    const ogUrl = meta(html, 'property', 'og:url');
    const ogTitle = decode(meta(html, 'property', 'og:title'));
    const ogDescription = decode(meta(html, 'property', 'og:description'));
    const ogImage = meta(html, 'property', 'og:image');
    const twitterTitle = decode(meta(html, 'name', 'twitter:title'));
    const twitterDescription = decode(meta(html, 'name', 'twitter:description'));

    assert.ok(title.length > 0 && title.length <= 60, `${file} title is ${title.length} characters`);
    assert.ok(description.length >= 50 && description.length <= 160, `${file} description is ${description.length} characters`);
    assert.ok(canonical, `${file} needs a canonical URL`);
    assert.equal(ogUrl, canonical, `${file} Open Graph URL must match its canonical`);
    assert.ok(meta(html, 'property', 'og:type'), `${file} needs og:type`);
    assert.ok(ogTitle && ogTitle.length <= 70, `${file} Open Graph title is ${ogTitle.length} characters`);
    assert.ok(ogDescription && ogDescription.length <= 200, `${file} Open Graph description is ${ogDescription.length} characters`);
    assert.ok(ogImage, `${file} needs og:image`);
    assert.ok(meta(html, 'property', 'og:image:alt'), `${file} needs an accessible Open Graph image description`);
    assert.equal(meta(html, 'property', 'og:image:width'), '1200', `${file} should declare the card width`);
    assert.equal(meta(html, 'property', 'og:image:height'), '630', `${file} should declare the card height`);
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image', `${file} needs a large Twitter card`);
    assert.ok(twitterTitle && twitterTitle.length <= 70, `${file} Twitter title is ${twitterTitle.length} characters`);
    assert.ok(twitterDescription && twitterDescription.length <= 200, `${file} Twitter description is ${twitterDescription.length} characters`);
    assert.equal(meta(html, 'name', 'twitter:image'), ogImage, `${file} Twitter image should match og:image`);
    assert.ok(meta(html, 'name', 'twitter:image:alt'), `${file} needs an accessible Twitter image description`);
    assert.equal(meta(html, 'name', 'twitter:image:alt'), meta(html, 'property', 'og:image:alt'), `${file} social image descriptions should agree`);
    assert.doesNotThrow(() => ldJson(html), `${file} JSON-LD must parse`);
    assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/, `${file} needs a working skip link`);
    assert.match(html, /\bid="main"/, `${file} skip link needs a main target`);
    assert.equal([...html.matchAll(/<h1\b/gi)].length, 1, `${file} should have one primary heading`);

    for (const image of html.matchAll(/<img\b([^>]*)>/gi)) {
      assert.match(image[1], /\balt=/i, `${file} image needs alt text`);
    }
  }
});

test('homepage product graph includes Organization, Product, SoftwareApplication, and only visible FAQs', () => {
  const html = read('index.html');
  const nodes = schemaNodes(ldJson(html));
  const types = new Set(nodes.flatMap((node) => Array.isArray(node['@type']) ? node['@type'] : [node['@type']]));
  for (const type of ['Organization', 'Product', 'SoftwareApplication', 'FAQPage']) {
    assert.ok(types.has(type), `homepage JSON-LD needs ${type}`);
  }

  const faq = nodes.find((node) => node['@type'] === 'FAQPage');
  const schemaQuestions = faq.mainEntity.map((item) => decode(item.name));
  const visibleQuestions = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/gi)]
    .map((match) => decode(match[1]));
  assert.deepEqual(schemaQuestions, visibleQuestions, 'FAQ schema must describe only the visible FAQ entries in the same order');
});

test('every refreshed public page identifies the same publisher and product', () => {
  for (const file of seoPages) {
    const nodes = schemaNodes(ldJson(read(file)));
    const types = new Set(nodes.flatMap((node) => Array.isArray(node['@type']) ? node['@type'] : [node['@type']]));
    for (const type of ['Organization', 'Product', 'SoftwareApplication']) {
      assert.ok(types.has(type), `${file} JSON-LD needs ${type}`);
    }
  }
});

test('SEO discovery files and IndexNow key are present and self-consistent', () => {
  for (const file of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${file} must be published`);
  }

  const sitemap = read('sitemap.xml');
  for (const page of pages) {
    const html = read(page);
    const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)?.[1] || '';
    assert.ok(sitemap.includes(`<loc>${canonical}</loc>`), `${page} canonical should be discoverable through the sitemap`);
  }

  const keys = fs.readdirSync(PUBLIC).filter((file) => /^[a-f0-9]{32}\.txt$/i.test(file));
  assert.equal(keys.length, 1, 'publish one 32-character IndexNow key file');
  assert.equal(read(keys[0]).trim(), path.basename(keys[0], '.txt'), 'IndexNow key content must match its public file name');
});

test('public copy uses the actual hosted-output option and documented render limits', () => {
  const publicHtml = pages.map(read).join('\n');
  assert.doesNotMatch(publicHtml, /"output"\s*:\s*"link"/, 'the public examples must use the supported url output mode');
  assert.doesNotMatch(publicHtml, /no size or timeout cap/i, 'the free plan also has service-level request and render limits');

  const privacy = read('privacy.html');
  assert.match(privacy, /serves its fonts from PDFMint/i);
  assert.doesNotMatch(privacy, /Google Fonts is loaded from Google's servers for typography on this website/i);
  const styles = fs.readFileSync(path.join(PUBLIC, 'landing.css'), 'utf8');
  assert.doesNotMatch(styles, /fonts\.(googleapis|gstatic)\.com/i, 'public site typography should be self-hosted');
});
