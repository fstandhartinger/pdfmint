'use strict';

// Additive: old writers are captured too. Do not replay historical terminal jobs:
// the old attempts field cannot distinguish delivered from lost notifications.
const statements = [
  `CREATE TABLE IF NOT EXISTS job_webhooks (
     job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
     delivery_id TEXT NOT NULL UNIQUE,
     account_id BIGINT NOT NULL,
     webhook_url TEXT NOT NULL,
     payload JSONB NOT NULL,
     body TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','delivered','exhausted')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     lease_until TIMESTAMPTZ,
     lease_token TEXT,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS job_webhooks_due_idx ON job_webhooks(next_attempt_at)
     WHERE status IN ('pending','delivering')`,
  `CREATE OR REPLACE FUNCTION enqueue_job_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.status IN ('succeeded','failed') AND OLD.status NOT IN ('succeeded','failed','cancelled')
        AND NEW.webhook_url IS NOT NULL THEN
       INSERT INTO job_webhooks(job_id,delivery_id,account_id,webhook_url,payload)
       VALUES(NEW.id,'wh_' || NEW.id,NEW.account_id,NEW.webhook_url,
         jsonb_build_object('job_id',NEW.id,'status',NEW.status,'result',NEW.result,'error',NEW.error))
       ON CONFLICT (job_id) DO NOTHING;
     END IF;
     RETURN NEW;
   END $$`,
  // Replaying this migration is atomic: no interval without the trigger.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='jobs_webhook_outbox' AND tgrelid='jobs'::regclass) THEN
       CREATE TRIGGER jobs_webhook_outbox AFTER UPDATE OF status ON jobs
       FOR EACH ROW EXECUTE FUNCTION enqueue_job_webhook();
     END IF;
   END $$`,
];
// One simple-query message is one implicit PostgreSQL transaction: schema and
// trigger become visible together. Serialize simultaneous boots; IF NOT EXISTS
// alone still races on pg_type during concurrent CREATE TABLE. Bound DDL waits.
const migration = [`SET LOCAL lock_timeout = '5s';
  SELECT pg_advisory_xact_lock(73090901);
  ${statements.join(';\n')}`];
module.exports = { migration };
