'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{fork}=require('node:child_process');
const db=require('../src/db'),jobs=require('../src/jobs');
if(!process.env.HOOK_TEST_DB||process.env.DATABASE_URL!==process.env.HOOK_TEST_DB)throw Error('isolated test DB required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==='worker'){jobs.startWorker(async()=>({pages:1}));process.send({ready:true});setInterval(()=>{},1000);}
else test('independent review regressions',async t=>{
 let child,server,hits=0;
 async function start(){child=fork(__filename,['worker'],{stdio:['ignore','inherit','inherit','ipc']});await new Promise((r,reject)=>{child.once('message',r);child.once('error',reject);});}
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(r=>{child.once('exit',r);child.kill('SIGKILL');});child=null;}
 try{
  await db.query(`CREATE TABLE accounts(id int PRIMARY KEY,webhook_secret text,credits_used int);CREATE TABLE jobs(id text PRIMARY KEY,account_id int,kind text,request jsonb,webhook_url text,client text,status text DEFAULT 'queued',attempts int DEFAULT 0,created_at timestamptz DEFAULT now(),started_at timestamptz,finished_at timestamptz,result jsonb,error jsonb);INSERT INTO accounts VALUES(1,'isolated-secret',10),(2,'isolated-secret',10)`);
  for(const sql of require('../src/job-webhook-schema').migration)await db.query(sql);
  server=http.createServer(async(req,res)=>{for await(const b of req){}hits++;res.writeHead(204);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  await t.test('one refund failure cannot roll back unrelated stalled recovery',async()=>{
   await db.query(`INSERT INTO jobs(id,account_id,kind,request,status,attempts,started_at) VALUES('bad',1,'pdf','{}','running',1,now()-interval '11 minutes'),('good',2,'pdf','{}','running',1,now()-interval '11 minutes');CREATE FUNCTION reject_one() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=1 THEN RAISE EXCEPTION 'isolated refund failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_one BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION reject_one()`);
   try{await start();await delay(1200);assert.equal((await jobs.get(2,'good')).status,'failed');assert.equal((await jobs.get(1,'bad')).status,'running');assert.equal((await db.query('SELECT credits_used FROM accounts WHERE id=2')).rows[0].credits_used,9);}
   finally{await stop();await db.query('DROP TRIGGER reject_one ON accounts;DROP FUNCTION reject_one();DELETE FROM jobs');}
  });
  await t.test('missing signing secret reaches persisted exhaustion without unsigned HTTP',async()=>{
   await db.query('UPDATE accounts SET webhook_secret=NULL WHERE id=2');const id=await jobs.enqueue(2,'pdf',{},url);await start();await delay(17000);
   const row=(await db.query('SELECT * FROM job_webhooks WHERE job_id=$1',[id])).rows[0];assert.equal(row.status,'exhausted');assert.equal(row.attempts,3);assert.match(row.last_error,/secret unavailable/);assert.equal(hits,0);await stop();
  });
 }finally{await stop();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db.query('DELETE FROM jobs;DELETE FROM accounts');await db.pool.end();}
});
