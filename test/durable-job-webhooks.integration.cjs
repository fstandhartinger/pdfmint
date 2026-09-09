'use strict';
// Explicit integration entrypoint (not silently skipped by npm test).
// Requires a disposable PostgreSQL database, never a production DATABASE_URL.
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { Pool } = require('pg');
const source = require('node:path').resolve(__dirname, '../src');
const pool = new Pool({ connectionString: process.env.HOOK_TEST_DB });
if (!process.env.HOOK_TEST_DB) throw Error('HOOK_TEST_DB disposable database required');
const delay = ms => new Promise(r => setTimeout(r, ms));
const mode = process.argv[3];
function load(onInterval) {
  const module = { exports: {} };
  const db = { query: (...args) => pool.query(...args), tx: async fn => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const wrapped = { query: async (...args) => {
        // Deterministic crash boundary: HTTP already returned, no ACK DB write yet.
        if (mode === 'after-ack' && /UPDATE job_webhooks\s+SET status = \$3/.test(args[0])) {
          process.send({ boundary: 'after-ack-before-db' });
          await new Promise(() => {});
        }
        return c.query(...args);
      } };
      const r = await fn(wrapped); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } };
  vm.runInNewContext(fs.readFileSync(source + '/jobs.js', 'utf8'), {
    module, exports: module.exports,
    require: n => n === './db' ? db : n === './config' ? { config: { publicUrl: 'https://pdf.mintapis.com' } }
      : require(n.startsWith('./') ? source + '/' + n.slice(2) : n),
    process: { env: { JOB_POLL_MS: '50' } }, console, fetch, AbortSignal, Date, JSON, setTimeout,
    setInterval: onInterval || setInterval,
  });
  return module.exports;
}
if (process.argv[2] === 'worker') {
  load().startWorker(async j => {
    await pool.query('INSERT INTO invocations VALUES($1,$2)', [j.id, process.pid]);
    if (j.request.fail) throw Error('isolated render failure');
    if (j.request.hold) await delay(1000);
    return { file_path: '/f/fixture', pages: 1 };
  });
  process.send({ ready: true }); setInterval(() => {}, 1000);
} else {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const workers = new Set(), receipts = [];
  const jobs = load(); let server, url;
  const row = async id => (await pool.query('SELECT * FROM job_webhooks WHERE job_id=$1', [id])).rows[0];
  const hits = id => receipts.filter(r => r.id === id);
  async function until(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(25); } throw Error('condition timeout'); }
  async function start(m = '') {
    const c = fork(__filename, ['worker', m], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    workers.add(c); c.boundaries = [];
    c.on('message', m => c.boundaries.push(m));
    await new Promise((r, reject) => { c.once('message', r); c.once('error', reject); }); return c;
  }
  async function kill(c) { if (c.exitCode === null && c.signalCode === null) await new Promise(r => { c.once('exit', r); c.kill('SIGKILL'); }); workers.delete(c); }
  async function stop() { for (const c of [...workers]) await kill(c); }
  async function assertSingleRender(id) {
    assert.equal((await pool.query('SELECT count(*)::int n FROM invocations WHERE job_id=$1', [id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT credits_used FROM accounts WHERE id=1')).rows[0].credits_used, 10);
  }
  test('durable terminal hooks on real PostgreSQL, HTTP and independent OS workers', async t => {
    await pool.query(`CREATE TABLE accounts(id int PRIMARY KEY,webhook_secret text,credits_used int);
      CREATE TABLE jobs(id text PRIMARY KEY,account_id int,kind text,request jsonb,webhook_url text,client text,status text DEFAULT 'queued',attempts int DEFAULT 0,created_at timestamptz DEFAULT now(),started_at timestamptz,finished_at timestamptz,result jsonb,error jsonb);
      CREATE TABLE invocations(job_id text,pid int); INSERT INTO accounts VALUES(1,'isolated-secret',10)`);
    // Upgrade an old schema with queued, running and historical terminal jobs.
    await pool.query(`INSERT INTO jobs(id,account_id,kind,request,status,webhook_url) VALUES
      ('historical',1,'pdf','{}','succeeded','http://old.invalid'),('old-running',1,'pdf','{}','running','http://old.invalid')`);
    for (let n = 0; n < 2; n++) for (const sql of require(source + '/job-webhook-schema').migration) await pool.query(sql);
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const p = JSON.parse(body), h = req.headers;
      receipts.push({ id: p.job_id, body, delivery: h['x-pdfmint-delivery-id'], at: Date.now(), status: p.status,
        signed: h['x-pdfmint-signature'] === 'sha256=' + crypto.createHmac('sha256', 'isolated-secret').update(`${h['x-pdfmint-timestamp']}.${body}`).digest('hex') });
      if (req.url === '/hold' && hits(p.job_id).length === 1) return;
      res.writeHead(req.url === '/503' || (req.url === '/retry' && hits(p.job_id).length === 1) ? 503 : 204); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${server.address().port}`;
    try {
      await t.test('additive migration captures old in-flight writes atomically, replay does not requeue history', async () => {
        assert.equal((await pool.query('SELECT count(*)::int n FROM job_webhooks')).rows[0].n, 0);
        await pool.query('BEGIN');
        await pool.query("UPDATE jobs SET status='failed',error='{\"code\":\"fixture\"}' WHERE id='old-running'");
        assert.ok(await row('old-running')); await pool.query('ROLLBACK'); assert.equal(await row('old-running'), undefined);
        await pool.query("UPDATE jobs SET status='failed',error='{\"code\":\"fixture\"}' WHERE id='old-running'");
        assert.equal((await row('old-running')).status, 'pending');
        await pool.query("DELETE FROM jobs WHERE id IN ('old-running','historical')");
      });
      await t.test('SIGKILL after receiver ACK before DB acknowledgment replays same delivery, no render/charge', async () => {
        const c = await start('after-ack'), id = await jobs.enqueue(1, 'pdf', {}, url + '/ok');
        await until(() => c.boundaries.some(x => x.boundary));
        assert.equal(hits(id).length, 1); assert.equal((await row(id)).status, 'delivering');
        await kill(c); await Promise.all([start(), start()]);
        await until(async () => (await row(id)).status === 'delivered');
        assert.equal(hits(id).length, 2); assert.equal(hits(id)[0].body, hits(id)[1].body);
        assert.equal(hits(id)[0].delivery, hits(id)[1].delivery); assert.ok(hits(id).every(h => h.signed));
        assert.equal((await row(id)).attempts, 1); await assertSingleRender(id); await stop();
      });
      await t.test('failed render hook survives SIGKILL before ACK', async () => {
        const c = await start(), id = await jobs.enqueue(1, 'pdf', { fail: true }, url + '/hold');
        await until(() => hits(id).length === 1); await kill(c); await start();
        await until(async () => (await row(id)).status === 'delivered');
        assert.equal(hits(id).length, 2); assert.ok(hits(id).every(h => h.status === 'failed' && h.signed));
        assert.equal(hits(id)[0].delivery, hits(id)[1].delivery); assert.equal(hits(id)[0].body, hits(id)[1].body);
        await assertSingleRender(id); await stop();
      });
      await t.test('restart in retry pause preserves deadline and attempt budget', async () => {
        const c = await start(), id = await jobs.enqueue(1, 'pdf', {}, url + '/retry');
        await until(async () => (await row(id))?.status === 'pending' && (await row(id)).attempts === 1);
        const before = await row(id); await kill(c); await start();
        await until(async () => (await row(id)).status === 'delivered');
        assert.equal(hits(id).length, 2); assert.ok(hits(id)[1].at >= new Date(before.next_attempt_at).getTime());
        assert.equal((await row(id)).attempts, 2); await assertSingleRender(id); await stop();
      });
      await t.test('three recorded failures exhaust durably; restart cannot rearm notification', async () => {
        await start(); const id = await jobs.enqueue(1, 'pdf', {}, url + '/503');
        await until(async () => (await row(id))?.status === 'exhausted');
        assert.equal((await row(id)).attempts, 3); assert.equal(hits(id).length, 3);
        assert.ok(hits(id)[1].at - hits(id)[0].at >= 3900); assert.ok(hits(id)[2].at - hits(id)[1].at >= 7900);
        await stop(); await Promise.all([start(), start()]); await delay(5000);
        assert.equal(hits(id).length, 3); assert.equal((await jobs.get(1,id)).status,'succeeded');
        await assertSingleRender(id); await stop();
      });
      await t.test('two workers deliver 20 pre-persisted terminal notifications once without rendering', async () => {
        const ids = [];
        for (let n=0;n<20;n++) { const id=await jobs.enqueue(1,'pdf',{},url+'/ok');ids.push(id);await pool.query("UPDATE jobs SET status='succeeded',result='{\"pages\":1}' WHERE id=$1",[id]); }
        await Promise.all([start(),start()]); await until(async()=>Number((await pool.query("SELECT count(*) n FROM job_webhooks WHERE job_id=ANY($1) AND status='delivered'",[ids])).rows[0].n)===20);
        for(const id of ids){assert.equal(hits(id).length,1);assert.ok(hits(id)[0].signed);}
        assert.equal((await pool.query('SELECT count(*)::int n FROM invocations WHERE job_id=ANY($1)',[ids])).rows[0].n,0);await stop();
      });
      await t.test('cancel racing result produces no stale success or failure notification', async () => {
        await start();const id=await jobs.enqueue(1,'pdf',{hold:true},url+'/ok');
        await until(async()=>Number((await pool.query('SELECT count(*) n FROM invocations WHERE job_id=$1',[id])).rows[0].n)===1);
        await jobs.cancel(1,id);await delay(1500);assert.equal(await row(id),undefined);assert.equal(hits(id).length,0);
        await pool.query('UPDATE accounts SET credits_used=10 WHERE id=1');await stop();
      });
      await t.test('refund failure rolls back stale terminal transition and its notification', async () => {
        const id=await jobs.enqueue(1,'pdf',{},url+'/ok');
        await pool.query("UPDATE jobs SET status='running',attempts=1,started_at=now()-interval '11 minutes' WHERE id=$1",[id]);
        await pool.query(`CREATE FUNCTION reject_fixture_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated refund failure'; END $$;
          CREATE TRIGGER reject_fixture_refund BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION reject_fixture_refund()`);
        try {
          await start();await delay(1000);
          assert.equal((await jobs.get(1,id)).status,'running','failed refund must roll back terminal state and outbox');
          assert.equal(await row(id),undefined);
        } finally {
          await stop();await pool.query('DROP TRIGGER reject_fixture_refund ON accounts;DROP FUNCTION reject_fixture_refund()');
          await pool.query('DELETE FROM jobs WHERE id=$1',[id]);
        }
      });
      await t.test('stale final failure atomically refunds and produces exactly one failed notification', async () => {
        const id=await jobs.enqueue(1,'pdf',{},url+'/ok');
        await pool.query("UPDATE jobs SET status='running',attempts=1,started_at=now()-interval '11 minutes' WHERE id=$1",[id]);
        await Promise.all([start(),start()]);await until(async()=>(await row(id))?.status==='delivered');
        assert.equal(hits(id).length,1);assert.equal(hits(id)[0].status,'failed');assert.equal(JSON.parse(hits(id)[0].body).error.code,'renderer_crashed');
        assert.equal((await pool.query('SELECT credits_used FROM accounts WHERE id=1')).rows[0].credits_used,9);await stop();
      });
      await t.test('retention never erases an outstanding notification; terminal delivery can be reaped', async () => {
        const id=await jobs.enqueue(1,'pdf',{},url+'/ok');
        await pool.query("UPDATE jobs SET status='succeeded',result='{}',finished_at=now()-interval '8 days' WHERE id=$1",[id]);
        let reap;load((fn,ms)=>{assert.equal(ms,6*3600*1000);reap=fn;return {unref(){}};}).startJobReaper();
        await reap();assert.ok(await row(id),'pending outbox must survive retention');
        await pool.query("UPDATE job_webhooks SET status='exhausted',attempts=3 WHERE job_id=$1",[id]);
        await reap();assert.equal(await row(id),undefined);
      });
      await t.test('a job becoming stale after startup is recovered without another restart', async () => {
        await pool.query('UPDATE accounts SET credits_used=10 WHERE id=1');
        await start();await delay(1000);
        const id=await jobs.enqueue(1,'pdf',{},url+'/ok');
        // Startup recovery has already finished. Age only this isolated fixture.
        await pool.query("UPDATE jobs SET status='running',attempts=1,started_at=now()-interval '11 minutes' WHERE id=$1",[id]);
        await until(async()=>(await row(id))?.status==='delivered',70000);
        assert.equal(hits(id).length,1);assert.equal(hits(id)[0].status,'failed');await stop();
      });
    } finally {
      await stop(); server.closeAllConnections(); await new Promise(r=>server.close(r));
      await pool.query('DELETE FROM jobs;DELETE FROM accounts;DELETE FROM invocations');
      assert.equal((await pool.query('SELECT count(*)::int n FROM job_webhooks')).rows[0].n,0);await pool.end();
    }
  });
}
