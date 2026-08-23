# Everything PDFMint created, what it costs, and how to reap it

Written because infrastructure that nobody wrote down is infrastructure that runs
unnoticed. `ops/reap.sh` tears all of it down.

## Monthly cost

| What | Where | Plan | Cost |
|---|---|---|---:|
| PDFMint API + site + docs | Render web service `pdfmint` (`srv-da5g1obbc2fs738ulc60`), Frankfurt | Starter, 512 MB | **$7.00** |
| Database | Neon project `pdfmint` (`muddy-sunset-47374431`), aws-us-west-2 | Free tier | **$0.00** |
| npm package | `n8n-nodes-pdfmint` | public | $0.00 |
| GitHub repos + Actions | `fstandhartinger/pdfmint`, `fstandhartinger/n8n-nodes-pdfmint` | public | $0.00 |
| Stripe | live mode, 3 products/prices + 1 webhook endpoint | pay per transaction | $0.00 fixed |
| Domain | none bought — the service runs on the Render subdomain | — | $0.00 |
| **Total** | | | **$7.00 / month** |

Measured, not assumed: eight concurrent renders peaked at **128 MB** in a 512 MB
container, so the Starter plan is the right size and there is no reason to move up
until sustained concurrency exceeds two.

Render Starter does not sleep, so there is no cold start — that is what the $7
buys over the free tier.

## What exists, precisely

- **Render web service** `pdfmint` — id `srv-da5g1obbc2fs738ulc60`, region frankfurt,
  Docker runtime, auto-deploys from `master` of `fstandhartinger/pdfmint`.
- **Neon project** `pdfmint` — id `muddy-sunset-47374431`, database `neondb`,
  tables: accounts, api_keys, templates, files, usage_events, sessions, jobs, stripe_events.
  `files` holds hosted PDFs and is reaped in-process every 10 minutes; `jobs` after 7 days.
- **Stripe (live)** — products `prod_V7sRgrjvmOLOld` (Starter), `prod_V7sR40gIxD9b3k` (Pro),
  `prod_V7sR5vvYj2AhPc` (Scale); webhook endpoint `we_1U7cgBCozVR51OgaRZj8KPi3` →
  `https://pdfmint-b9tt.onrender.com/stripe/webhook`.
- **npm** — `n8n-nodes-pdfmint`, published from GitHub Actions with a provenance attestation.
- **GitHub secret** `NPM_TOKEN` on `fstandhartinger/n8n-nodes-pdfmint`.
- **n8n creator account** — `fstandhartinger` at creators.n8n.io.

Nothing else. No EC2, no GPU, no queues, no object storage, no CDN, no cron service.

## Reaping it

```bash
ops/reap.sh --list      # show everything and what it costs, change nothing
ops/reap.sh --suspend   # stop the Render service billing, keep the data
ops/reap.sh --destroy   # delete the Render service, the Neon project and the Stripe webhook
```

`--destroy` asks for confirmation and prints exactly what it will remove first.
It deliberately does **not** unpublish the npm package: npm unpublish breaks
anyone who installed it, and after 72 hours npm refuses anyway.

## Local, on this machine only

Docker containers `n8n-test`, `n8n-fresh` and `n8n-ui` were used to prove the node
works. They cost nothing but hold ~1.4 GB each and have been removed;
`ops/reap.sh --local` removes them again if they come back.

## Audited on 2026-08-23, after the work was done

Every Render service on the account was listed, not just this one, because the
whole point of writing this down is that nothing hides:

- **PDFMint's own:** one service, `pdfmint`, Starter, running — **$7/month.**
- **Pre-existing, not from this project:** `agent-as-a-service` (Starter, running,
  $7/month) and `siegi-locator` (Starter, running, $7/month) also bill. Everything
  else on the account is either free-tier or suspended. That is **$14/month that
  predates PDFMint** and is worth a look if it is not wanted.
- **Neon:** one project, free tier, created for this.
- **Stripe:** one webhook endpoint, three products (products do not bill), and the
  one $9 Starter subscription bought to prove the payment path, set to cancel at
  the end of its period on 2026-09-23.
- **Nothing else:** no EC2, no GPU, no queue, no object store, no cron service,
  no domain.
