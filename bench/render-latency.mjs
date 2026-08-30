// Measures render latency against the live PDFMint API.
//
// This exists because the landing page quoted "328 ms" with no published method.
// A blind critic comparing our page against a competitor's called that out
// correctly: a single self-reported sample dressed as a measurement is one a
// careful reader discounts to zero, and GOAL.md's rule is that a number must be
// measured before it is written.
//
// Usage:  PDFMINT_API_KEY=pm_live_... node bench/render-latency.mjs [samples]
//         node bench/render-latency.mjs --demo [samples]      (no key needed)
//
// Two endpoints, because the landing page shows two calls and they are not the
// same call. The keyless POST /v1/demo/pdf is what the curl tab tells a reader to
// paste; POST /v1/pdf with a key is what a customer integrates against. The demo
// also pays a Postgres round trip for its per-address budget, so a number measured
// on one of them does not describe the other. Whichever is quoted on a page has to
// name the endpoint and the document it was measured with.
//
// --demo is capped by the service at 5 renders an hour per address, so it reports
// a median of at most 5 samples and says so.
//
// Reports median and p95 rather than a mean: PDF rendering has a long tail from
// browser warm-up, and a mean hides exactly the case a user notices.
const DEMO = process.argv.includes('--demo');
const KEY = process.env.PDFMINT_API_KEY;
if (!DEMO && !KEY) { console.error('PDFMINT_API_KEY is not set (or pass --demo)'); process.exit(1); }

const BASE = process.env.PDFMINT_BASE_URL || 'https://pdf.mintapis.com';
const N = Number(process.argv.filter((a) => !a.startsWith('--'))[2] || (DEMO ? 5 : 20));

const PATH = DEMO ? '/v1/demo/pdf' : '/v1/pdf';
// Byte-for-byte the document the corresponding tab on the landing page shows, so
// the quoted number describes the thing a reader would actually run.
const BODY = DEMO
  ? JSON.stringify({ html: '<h1>Invoice 1042</h1><p>Thanks for your business.</p>' })
  : JSON.stringify({ html: '<h1>Hello from PDFMint</h1>', options: { margin: '20mm' } });
const DOCUMENT = DEMO
  ? 'the landing page curl tab verbatim: no key, {"html":"<h1>Invoice 1042</h1><p>Thanks for your business.</p>"}'
  : 'the landing page Node tab: a key, <h1>Hello from PDFMint</h1> and a 20mm margin';

const ms = [];
let bytes = 0;
let failures = 0;

for (let i = 0; i < N; i += 1) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(DEMO ? {} : { Authorization: `Bearer ${KEY}` }) },
      body: BODY,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const t1 = process.hrtime.bigint();
    if (res.status !== 200 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      failures += 1;
      continue;
    }
    bytes = buf.length;
    ms.push(Number(t1 - t0) / 1e6);
  } catch {
    failures += 1;
  }
}

if (!ms.length) { console.error('every request failed'); process.exit(1); }
ms.sort((a, b) => a - b);
const at = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];

console.log(JSON.stringify({
  base_url: BASE,
  measured_at: new Date().toISOString(),
  samples: ms.length,
  failures,
  endpoint: `POST ${PATH}`,
  document: DOCUMENT,
  note: 'wall clock from this machine, so it includes network round-trip to the live service',
  bytes,
  median_ms: Math.round(at(50)),
  p95_ms: Math.round(at(95)),
  min_ms: Math.round(ms[0]),
  max_ms: Math.round(ms[ms.length - 1]),
}, null, 2));
