'use strict';

/**
 * Which integration made this call.
 *
 * This exists because of a question we could not answer on 2026-08-30. npm
 * reported 1,002 weekly downloads of `n8n-nodes-pdfmint` while the service had
 * rendered 16 documents for the outside world in seven days. The downloads turned
 * out to be machines -- they were spread almost evenly across all six published
 * versions, including week-old ones nobody would install -- but the point is that
 * we had no way to check the other direction: not one record anywhere said whether
 * a render had come through the n8n node, through Zapier, through Make, or from
 * somebody typing curl. The node has always sent `User-Agent: n8n-nodes-pdfmint`.
 * We were throwing it away on every request.
 *
 * A label rather than the raw header, because the question is "did this channel
 * convert" and a bounded vocabulary answers it with a GROUP BY. Anything we do not
 * recognise becomes 'other' rather than being dropped, so an integration we have
 * not thought of still shows up as a number that demands an explanation.
 */

// Ordered: the first match wins, so put the specific ones before the generic.
const SIGNATURES = [
  [/n8n-nodes-(pdfmint|docmint|mailmint)/i, 'n8n-node'],
  [/n8n/i, 'n8n-other'],
  [/zapier/i, 'zapier'],
  [/make\.com|integromat/i, 'make'],
  [/pipedream/i, 'pipedream'],
  [/python-requests|httpx|aiohttp/i, 'python'],
  [/axios|node-fetch|undici|got\//i, 'node'],
  [/PostmanRuntime|insomnia/i, 'api-client'],
  [/curl|wget/i, 'curl'],
  [/Mozilla\/|Chrome\/|Safari\/|Firefox\//i, 'browser'],
];

function clientOf(req) {
  // No request at all is a real answer, not a missing one: the async queue worker
  // renders long after the caller has gone. It is recorded at enqueue time instead
  // and carried on the job, so 'unknown' here would be a bug rather than a gap.
  const ua = req && typeof req.get === 'function' ? req.get('user-agent') : null;
  if (!ua) return 'unknown';
  for (const [re, label] of SIGNATURES) if (re.test(ua)) return label;
  return 'other';
}

module.exports = { clientOf, SIGNATURES };
