#!/usr/bin/env node
'use strict';

/**
 * Tell search engines the pages exist, instead of waiting to be found.
 *
 * IndexNow is one endpoint that Bing, Yandex, Seznam and Naver all consume: you
 * host a key file at your root and POST a list of URLs. It is free, needs no
 * account, and is the fastest route to being crawled by them for a site with no
 * inbound links yet. Google does not take part — for Google the levers are the
 * sitemap in robots.txt, Search Console, and links.
 *
 *   INDEXNOW_KEY=<key> node scripts/submit-indexnow.js
 *
 * Run it after a deploy that adds or changes a public page.
 */

const KEY = process.env.INDEXNOW_KEY;
const HOST = 'pdf.mintapis.com';

async function urlsFromSitemap() {
  const res = await fetch(`https://${HOST}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap returned ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function main() {
  if (!KEY) {
    console.error('INDEXNOW_KEY is not set. It must match the key file served at the site root.');
    process.exitCode = 1;
    return;
  }

  // The key file has to be reachable, or every submission is rejected as
  // unverified — check it before sending anything.
  const probe = await fetch(`https://${HOST}/${KEY}.txt`);
  if (!probe.ok || (await probe.text()).trim() !== KEY) {
    console.error(`key file at https://${HOST}/${KEY}.txt is missing or does not contain the key`);
    process.exitCode = 1;
    return;
  }

  const urlList = await urlsFromSitemap();
  console.log(`submitting ${urlList.length} urls`);

  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
  });

  // 200 and 202 both mean accepted; 422 usually means the key did not verify.
  console.log(`indexnow responded ${res.status} ${res.statusText}`);
  if (res.status >= 400) {
    console.error((await res.text()).slice(0, 300));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('submission failed:', err.message);
  process.exitCode = 1;
});
