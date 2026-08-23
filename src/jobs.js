'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { config } = require('./config');
const { ApiError } = require('./errors');

const MAX_WEBHOOK_ATTEMPTS = 3;
const POLL_MS = Number(process.env.JOB_POLL_MS || 1500);

/**
 * The queue is a table rather than an in-memory list on purpose: a Render
 * redeploy restarts the process, and a job that only lived in memory would be
 * lost with no way for the caller to find out.
 */
async function enqueue(accountId, kind, request, webhookUrl) {
  const id = `job_${crypto.randomBytes(12).toString('base64url')}`;
  await query(
    `INSERT INTO jobs (id, account_id, kind, request, webhook_url) VALUES ($1, $2, $3, $4, $5)`,
    [id, accountId, kind, JSON.stringify(request), webhookUrl || null],
  );
  return id;
}

async function get(accountId, id) {
  const { rows } = await query(
    `SELECT id, kind, status, result, error, attempts, created_at, started_at, finished_at
     FROM jobs WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  if (!rows.length) {
    throw new ApiError(404, 'job_not_found', `There is no job called "${id}" on this account.`, {
      hint: 'Job IDs are returned by an asynchronous request and look like job_XXXX. They belong to the account that created them.',
      docs: '/docs#async',
    });
  }
  const j = rows[0];
  return {
    job_id: j.id,
    kind: j.kind,
    status: j.status,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    attempts: j.attempts,
    ...(j.result || {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

/** Claims one queued job, so two workers never take the same row. */
async function claim() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) return null;
    await client.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1`, [rows[0].id]);
    return rows[0];
  });
}

async function deliver(job, payload) {
  if (!job.webhook_url) return;
  const body = JSON.stringify(payload);

  // Anything that learns a webhook URL could otherwise forge a "succeeded" call.
  // The signature is HMAC-SHA256 over `timestamp.body` with the account's webhook
  // secret, so a receiver can verify both the sender and that it is not a replay.
  const { rows } = await query(`SELECT webhook_secret FROM accounts WHERE id = $1`, [job.account_id]).catch(() => ({ rows: [] }));
  const secret = rows[0] && rows[0].webhook_secret;
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'PDFMint-Webhook/1',
    'X-PDFMint-Timestamp': String(timestamp),
    'X-PDFMint-Job-Id': job.id,
  };
  if (secret) {
    headers['X-PDFMint-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  }

  for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(job.webhook_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        await query(`UPDATE jobs SET attempts = $2 WHERE id = $1`, [job.id, attempt]);
        return;
      }
      console.warn(`[jobs] webhook ${job.id} attempt ${attempt} -> HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[jobs] webhook ${job.id} attempt ${attempt} failed: ${e.message}`);
    }
    await query(`UPDATE jobs SET attempts = $2 WHERE id = $1`, [job.id, attempt]);
    if (attempt < MAX_WEBHOOK_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 4000));
  }
}

/**
 * `runner` is injected so this module does not depend on the route layer.
 * It receives (accountId, request) and resolves to the JSON body the
 * synchronous endpoint would have returned with output "url".
 */
function startWorker(runner) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let job = null;
    try {
      job = await claim();
      if (job) {
        const result = await runner(job);
        await query(`UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now() WHERE id = $1`,
          [job.id, JSON.stringify(result)]);
        // The webhook has no request to take a host from, so it uses the configured
        // public URL. The stored path stays relative for GET /v1/jobs/{id}.
        const { file_path: filePath, ...rest } = result;
        await deliver(job, {
          job_id: job.id,
          status: 'succeeded',
          ...rest,
          ...(filePath ? { url: `${(config.publicUrl || '').replace(/\/$/, '')}${filePath}` } : {}),
        });
      }
    } catch (e) {
      if (job) {
        const error = {
          code: e.code || 'render_failed',
          message: String(e.message || e).slice(0, 400),
          ...(e.hint ? { hint: e.hint } : {}),
        };
        await query(`UPDATE jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [job.id, JSON.stringify(error)]).catch(() => {});
        await deliver(job, { job_id: job.id, status: 'failed', error });
      } else {
        console.warn('[jobs] worker tick failed:', e.message);
      }
    } finally {
      setTimeout(tick, job ? 50 : POLL_MS).unref();
    }
  };
  setTimeout(tick, 3000).unref();

  // Anything left 'running' when the process died is retried once on boot.
  query(`UPDATE jobs SET status = 'queued', started_at = NULL
         WHERE status = 'running' AND started_at < now() - interval '10 minutes'`)
    .then((r) => { if (r.rowCount) console.log(`[jobs] requeued ${r.rowCount} stalled job(s)`); })
    .catch(() => {});

  return () => { stopped = true; };
}

/** Deletes finished jobs after a week so the table stays small. */
function startJobReaper() {
  const tick = () => query(`DELETE FROM jobs WHERE finished_at < now() - interval '7 days'`).catch(() => {});
  setInterval(tick, 6 * 3600 * 1000).unref();
}

module.exports = { enqueue, get, startWorker, startJobReaper, MAX_WEBHOOK_ATTEMPTS };
