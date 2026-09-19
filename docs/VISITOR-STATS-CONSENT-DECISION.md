# Visitor statistics — consent decision for PDFMint (engineering assessment)

Status: **implemented 2026-09-19** in this repository. This document is an engineering
assessment written from the code that is actually shipped here. **It is not legal advice.**
It ports the design and reasoning of the Benchmark Heaven decision record
`/opt/model-market-comparison/ops/ux-2026-09-12/CR-67.5-CONSENT-DECISION.md` (CR-67.5,
which contains the full source research) to PDFMint's Express app, and binds it to this code.

## 1. What is implemented (the facts the decision rests on)

Code: `src/visit-stats.js` (classification, aggregation, schema, report), `src/visit-counter.js`
(Express middleware, in-memory totals, flush, operator endpoint), wired in `src/server.js`
(middleware after the canonical-host redirect, before the Stripe router; `install(app)` next to
`ads-report.js`). Tests: `test/visit-stats.test.js`. Public disclosure: `/privacy`, section 2,
subsection "Visitor statistics".

| Question | Answer from the code |
|---|---|
| Storage on / active reading from the device | **None.** The counter places no cookie, no `localStorage`/`sessionStorage`, no script, pixel, beacon, `Accept-CH`/client hint, ETag or link decoration on or in the visitor's device, and reads nothing back. It runs only on the server, on the HTTP request the browser already makes to get the page. (The site's separate functional storage — the session cookie — is disclosed in section 2 of `/privacy` and is not read by the counter.) |
| Data used per request (in memory, then discarded) | The request line (method and path — the page URL the browser asks for) and the headers the browser sends anyway to get the page: `Sec-Fetch-Dest`/`Accept`/`Sec-Purpose`/`Purpose` (full page load, not a prefetch or file?), the full `User-Agent` string (regex bot filter only, **never stored**), `Referer` (reduced to the host name), `Sec-GPC`/`DNT` (objection). Several of these headers are optional and not sent with every request. **The IP address and forwarded-IP headers are never read.** |
| Identifiers | **None.** No IP, no hash, no salt, no fingerprint, no session or account link. Consequence: unique visitors are **deliberately not measured** — counting them would require an identifier, and none is derived. |
| What is stored | Table `visit_daily(day, path, referrer_host, views, visits)` — daily totals only. `path` has no query string and is limited to known page routes (anything else is stored as one `(unknown route)` row); `referrer_host` is a host name without path or query, empty for direct/same-site requests. "views" = full page loads answered with status 200; "visits" = page loads without a same-site referrer. |
| Where | The service's own first-party PostgreSQL database that holds everything else in this service — self-hosted by the operator on his own Hetzner server (EU), verified 19 Sep 2026 from the deployed container's `DATABASE_URL` host (the operator's server address; no third-party database vendor) — in its own table, never joined with `accounts`. No analytics vendor; the counter has no other integration. Note: `/privacy` section 5 still names the previous hosts (Render/Neon); correcting that processor table is tracked separately (criterion D9) and does not change this counter's storage facts. |
| Retention | A delete of rows older than 13 months runs at least hourly while the server runs, independent of traffic. Unwritten totals are normally flushed within ~60 s; if the database is unreachable they are kept in memory for at most the current and previous UTC day, then dropped. At most 5,000 distinct rows are held in memory; further new rows are skipped, also when a failed write is put back. |
| Output | `GET /api/operator/visits?days=N` (Bearer `VISIT_STATS_TOKEN`, compared timing-safe via SHA-256 digests; 404 when unconfigured; 503 — never zeros — when the database fails; `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`): daily totals, the top 25 pages and top 25 referrer hosts with at least 3 page loads in the period, and one "(other)" row each combining every remaining row (below 3, or beyond the top 25), so the report does not name a page or referrer with a single visit. The database itself holds exact daily rows, reachable only with the database credential. |
| Bots | Filtered heuristically: requests without a `User-Agent`, and user agents matching a fixed regex of known crawlers, fetchers, monitors and HTTP libraries (including `curl`, `wget`, `python`), are not counted. This is best effort, not exact. |
| Objection | Requests with `Sec-GPC: 1` or `DNT: 1` are not counted — the browser's own signalling is honoured as the objection. Email objection is offered on `/privacy`; because totals cannot be traced to a person, it is answered with an explanation and the GPC/DNT route rather than a per-person deletion. |

## 2. Decision

**(a) No consent is required under § 25 TDDDG, and no banner is added.**

- § 25(1) TDDDG covers *storing information on* or *accessing information stored in* the terminal
  equipment. This counter stores nothing and runs nothing on the device; it only evaluates the
  request line and HTTP headers of the page request the visitor makes anyway — nothing beyond
  what delivering the requested page needs. The reasoning carried over from CR-67.5: LfDI
  Baden-Württemberg (FAQ Cookies und Tracking, A.3.1) treats IP address and User-Agent sent
  automatically as not an "access" under § 25 and names local, data-minimal reach counting
  without third parties as the consent-free model — this implementation is stricter (no IP at
  all, no log rows). DSK OH Digitale Dienste v1.2 keeps active reading via JavaScript and
  server-side fingerprint hashes as access (Rn. 23–24); neither happens here, and Rn. 88 names
  plain per-page counting as the uncontroversial case. EDPB Guidelines 2/2023 bring
  header/IP-based *tracking and fingerprinting* into Art. 5(3) ePD (paras. 43, 54–55); no
  identifier is derived and no visitor is recognised or tracked, which puts this counter well
  outside those examples. This is why a daily IP+UA hash for unique visitors was **not** built.
- **Residual uncertainty (stated, not hidden):** the EDPB reading of "access" is broad, and DSK
  v1.2 Rn. 89–90 says reach measurement must be judged per configuration. This document is the
  documented assessment for exactly this configuration, and `/privacy` words the arrangement as
  a description of the code, not as a legal conclusion. If a supervisory authority or court were
  to treat this header evaluation as an access requiring consent, the fallback is to switch the
  counter off (`VISIT_STATS_DISABLED=1`), not to add a banner.
- **GDPR:** the persisted daily totals relate to no identifiable person — no personal data is
  stored. The transient processing of the request headers rests on **Art. 6(1)(f)** (legitimate
  interest: the operator's own insight into reach and capacity; no profile, no third party, no
  merging with account data; within the reasonable expectation of a visitor), with the Art. 13
  information in `/privacy#visitor-statistics` and the GPC/DNT route as the Art. 21 objection.
- **No banner is needed** for this counter: nothing is placed on the device, so there is nothing
  a consent banner would ask about. The only storage this site places on a device remains the
  login session cookie, already disclosed in `/privacy`.

## 3. Conditions that would reopen this decision

Adding any of the following makes the statistics consent-relevant or needs a new record:
client-side script/beacon, cookie or storage for statistics, any IP-derived or hashed key
(unique visitors), `Accept-CH`, full referrer URLs or query strings, an external analytics
provider, joining statistics with accounts, longer retention than 13 months.

## 4. Technical proof (for the verifier)

1. `node --test test/visit-stats.test.js` — classification (bots, GPC, DNT, prefetch, non-document
   requests, POSTs), route normalisation, the no-identifier schema, accumulator bounds, and the
   aggregate-only report with the below-3 fold.
2. Live: `/api/operator/visits` without a token → 401; with a wrong token → 401; unconfigured →
   404; with the token → aggregate JSON only, rows below 3 folded into `(other)`. The integration
   block in the test file automates the counting path when `TEST_BASE_URL` and
   `VISIT_STATS_TOKEN` are set.
3. Nothing on the device: anonymous page loads receive no `Set-Cookie`, and the pages load no
   analytics script (the only third-party request is the Google Fonts stylesheet).
