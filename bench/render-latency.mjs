// Measures render latency against the live PDFMint API.
//
// This exists because the landing page quoted "328 ms" with no published method.
// A blind critic comparing our page against a competitor's called that out
// correctly: a single self-reported sample dressed as a measurement is one a
// careful reader discounts to zero, and GOAL.md's rule is that a number must be
// measured before it is written.
//
// Usage:  PDFMINT_API_KEY=pm_live_... node bench/render-latency.mjs [samples]
//
// Reports median and p95 rather than a mean: PDF rendering has a long tail from
// browser warm-up, and a mean hides exactly the case a user notices.
const KEY = process.env.PDFMINT_API_KEY;
if (!KEY) { console.error('PDFMINT_API_KEY is not set'); process.exit(1); }

const BASE = process.env.PDFMINT_BASE_URL || 'https://pdf.mintapis.com';
const N = Number(process.argv[2] || 20);

// The document the landing page's own curl example produces, so the quoted
// number describes the thing a reader would actually run.
const BODY = JSON.stringify({
  html: '<h1>Hello from PDFMint</h1>',
  options: { margin: '20mm' },
});

const ms = [];
let bytes = 0;
let failures = 0;

for (let i = 0; i < N; i += 1) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(`${BASE}/v1/pdf`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
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
  document: 'the landing page curl example (<h1>Hello from PDFMint</h1>, 20mm margin)',
  note: 'wall clock from this machine, so it includes network round-trip to the live service',
  bytes,
  median_ms: Math.round(at(50)),
  p95_ms: Math.round(at(95)),
  min_ms: Math.round(ms[0]),
  max_ms: Math.round(ms[ms.length - 1]),
}, null, 2));
