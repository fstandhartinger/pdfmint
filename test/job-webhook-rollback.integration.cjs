'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fork } = require('node:child_process');
const db = require('../src/db');
const jobs = require('../src/jobs');
const delay = ms => new Promise(r=>setTimeout(r,ms));
if (!process.env.HOOK_TEST_DB) throw Error('isolated HOOK_TEST_DB required');
if(process.argv[2]==='worker') {
  jobs.startWebhookWorker();process.send({ready:true});setInterval(()=>{},1000);
} else test('rollback delivery-only companion drains captured legacy completions without claiming queued renders',async()=>{
  let server,worker;
  try {
    await db.query(`CREATE TABLE accounts(id int PRIMARY KEY,webhook_secret text,credits_used int);
      CREATE TABLE jobs(id text PRIMARY KEY,account_id int,kind text,request jsonb,webhook_url text,client text,status text DEFAULT 'queued',attempts int DEFAULT 0,created_at timestamptz DEFAULT now(),started_at timestamptz,finished_at timestamptz,result jsonb,error jsonb);
      INSERT INTO accounts VALUES(1,'isolated-secret',10)`);
    // A failure after all DDL must roll the whole additive migration back.
    const migration = require('../src/job-webhook-schema').migration;
    await assert.rejects(db.query(migration.join(';') + '; SELECT 1/0'), { code: '22012' });
    assert.equal((await db.query("SELECT to_regclass('job_webhooks') AS name")).rows[0].name, null);
    await Promise.all([0,1].map(async()=>{
      for(const sql of migration) await db.query(sql);
    }));
    assert.equal(typeof jobs.startWebhookWorker,'function','rollback requires a delivery-only worker, not a render worker');
    let hits=0;server=http.createServer(async(req,res)=>{for await(const b of req){}hits++;res.writeHead(204);res.end();});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${server.address().port}/hook`;
    const queued=await jobs.enqueue(1,'pdf',{},url),terminal=await jobs.enqueue(1,'pdf',{},url);
    // Exact SQL shape used by the old binary, no new application helper required.
    await db.query("UPDATE jobs SET status='succeeded',result='{\"file_path\":\"/f/fixture\"}',finished_at=now() WHERE id=$1 AND status='queued'",[terminal]);
    worker=fork(__filename,['worker'],{stdio:['ignore','inherit','inherit','ipc']});
    await new Promise((r,reject)=>{worker.once('message',r);worker.once('exit',()=>reject(Error('worker exited before ready')));});
    for(let n=0;n<400;n++){if((await db.query('SELECT status FROM job_webhooks WHERE job_id=$1',[terminal])).rows[0].status==='delivered')break;await delay(25);}
    assert.equal((await db.query('SELECT status FROM job_webhooks WHERE job_id=$1',[terminal])).rows[0].status,'delivered');
    assert.equal(hits,1);assert.equal((await jobs.get(1,queued)).status,'queued');
    assert.equal((await db.query('SELECT credits_used FROM accounts WHERE id=1')).rows[0].credits_used,10);
  } finally {
    if(worker&&worker.exitCode===null&&worker.signalCode===null)await new Promise(r=>{worker.once('exit',r);worker.kill('SIGKILL');});
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await db.query('DELETE FROM jobs;DELETE FROM accounts');await db.pool.end();
  }
});
