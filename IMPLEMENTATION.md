# PDFMint advertising measurement, 2026-09-10

Dedicated `/ads/pdf?campaign=growth-ads-pdfmint-20260910` landing page links to signup with the allowlisted campaign. Successful account creation inserts one row per account. Invalid/failed/existing signup and dashboard reload do not count. QA accounts use the existing internal-account filter. No Google tag, advertising cookie or gclid is recorded. Existing session cookies remain unchanged.

The hidden token is HMAC signed with GROWTH_ADS_REPORT_TOKEN (SESSION_SECRET fallback for isolated development), valid seven days. Rotating this secret invalidates outstanding form tokens. A signed token validates the allowlisted campaign, **not proof of a paid Google click**; anyone can visit/share the campaign link. A visitor who leaves this flow and signs up via the ordinary homepage later is not attributed. The seven days are token validity, not persistent cross-session attribution.

GET `/internal/growth-ads/report` requires the dedicated random bearer token (minimum 32 characters) from deployment environment. Returns aggregate successful signups (`trials`), accounts with successful production usage since signup (`activated`), accounts currently on a nonfree plan with subscription ID (`paid_plan_accounts`, NOT independently verified cash receipts), and today's trials in Europe/Berlin. QA/internal accounts excluded. No personal identifiers returned; no-store; 401 unauthorized, 503 on query failure. It never turns query failure into zero.

No Stripe configuration or billing behavior changes. Migration is additive and idempotent. Conversion insertion errors preserve working signup and emit an application warning; operators should inspect these if attribution looks incomplete.

Validation: 17 attribution tests passed on dedicated local PostgreSQL pdfmint_ads_test. 29 regression tests passed, 1 skipped. Existing free-tier expectation (402 vs 200) also failed on pristine HEAD; outside this patch. Added aggregate endpoint integration/authentication tests passed. Deployment must be followed by a directly opened landing-page QA signup and report check, never a click on an own ad.
