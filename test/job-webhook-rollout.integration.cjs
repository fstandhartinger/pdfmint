'use strict';
// Two-phase rolling upgrade: all unbridged processes must be gone before DDL.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),http=require('node:http'),crypto=require('node:crypto');
const {fork}=require('node:child_process'),{Pool}=require('pg');
const pool=new Pool({connectionString:process.env.HOOK_TEST_DB});
if(!process.env.HOOK_TEST_DB)throw Error('isolated HOOK_TEST_DB required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function load(file){const module={exports:{}};const db={query:(...a)=>pool.query(...a),tx:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:n=>n==='./db'?db:n==='./config'?{config:{publicUrl:'https://pdf.mintapis.com'}}:n==='./errors'?{ApiError:Error}:require(n),process:{env:{JOB_POLL_MS:'50'}},console,fetch,AbortSignal,Date,JSON,setTimeout,setInterval});return module.exports;}
if(process.argv[2]==='worker'){
 load(process.argv[3]).startWorker(async j=>{await pool.query('INSERT INTO invocations VALUES($1,$2)',[j.id,process.pid]);if(j.request.wait){process.send({boundary:j.id});await new Promise(r=>process.once('message',r));}return {file_path:'/f/fixture',pages:1};});process.send({ready:true});setInterval(()=>{},1000);
}else test('two-phase rolling bridge preserves one stable delivery identity across old/new overlap',async()=>{
 const workers=new Set(),receipts=[],held=[];let server;
 async function start(file){const c=fork(__filename,['worker',file],{stdio:['ignore','inherit','inherit','ipc']});workers.add(c);c.boundaries=[];c.on('message',m=>c.boundaries.push(m));await new Promise((r,reject)=>{c.once('message',r);c.once('exit',()=>reject(Error('worker exited')));});return c;}
 async function kill(c){if(c.exitCode===null&&c.signalCode===null)await new Promise(r=>{c.once('exit',r);c.kill('SIGKILL');});workers.delete(c);}
 async function until(fn){for(let n=0;n<1000;n++){if(await fn())return;await delay(25);}throw Error('condition timeout');}
 const hits=id=>receipts.filter(x=>x.id===id);
 try{
  await pool.query(`CREATE TABLE accounts(id int PRIMARY KEY,webhook_secret text,credits_used int);CREATE TABLE jobs(id text PRIMARY KEY,account_id int,kind text,request jsonb,webhook_url text,client text,status text DEFAULT 'queued',attempts int DEFAULT 0,created_at timestamptz DEFAULT now(),started_at timestamptz,finished_at timestamptz,result jsonb,error jsonb);CREATE TABLE invocations(job_id text,pid int);INSERT INTO accounts VALUES(1,'isolated-secret',10)`);
  server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const p=JSON.parse(body),h=req.headers;receipts.push({id:p.job_id,delivery:h['x-pdfmint-delivery-id'],body,signed:h['x-pdfmint-signature']==='sha256='+crypto.createHmac('sha256','isolated-secret').update(`${h['x-pdfmint-timestamp']}.${body}`).digest('hex')});if(req.url==='/overlap'&&hits(p.job_id).length===1){held.push(res);return;}res.writeHead(204);res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`,jobs=load('/app/src/jobs.js');
  // Old artifact finishes before bridge installation. No DDL/backfill here.
  const old=await start('/legacy-jobs.js');
  const legacy={id:await jobs.enqueue(1,'pdf',{},url+'/legacy')};
  await until(()=>hits(legacy.id).length===1);await until(async()=>Number((await pool.query('SELECT attempts FROM jobs WHERE id=$1',[legacy.id])).rows[0].attempts)===1);
  assert.equal(hits(legacy.id)[0].delivery,undefined);await kill(old);
  assert.equal(workers.size,0,'no original workers remain before bridge');
  const bridge=await start('/bridge-jobs.js');
  const bridged={id:await jobs.enqueue(1,'pdf',{},url+'/bridge')};
  await until(()=>hits(bridged.id).length===1);
  assert.equal(hits(bridged.id)[0].delivery,`wh_${bridged.id}`,'phase one bridge must provide stable identity BEFORE migration');
  const overlap={id:await jobs.enqueue(1,'pdf',{wait:true},url+'/overlap')};
  await until(()=>bridge.boundaries.some(m=>m.boundary===overlap.id));
  for(const sql of require('../src/job-webhook-schema').migration)await pool.query(sql);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM job_webhooks')).rows[0].n,0,'no historical terminal backfill');
  bridge.send({resume:true});await until(()=>hits(overlap.id).length===1);
  await start('/app/src/jobs.js');await until(()=>hits(overlap.id).length===2);
  for(const res of held){res.writeHead(204);res.end();}
  await until(async()=>(await pool.query('SELECT status FROM job_webhooks WHERE job_id=$1',[overlap.id])).rows[0]?.status==='delivered');
  assert.deepEqual(hits(overlap.id).map(x=>x.delivery),[`wh_${overlap.id}`,`wh_${overlap.id}`]);
  assert.deepEqual(JSON.parse(hits(overlap.id)[0].body),JSON.parse(hits(overlap.id)[1].body));
  assert.ok(receipts.every(x=>x.signed));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM invocations WHERE job_id=$1',[overlap.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT credits_used FROM accounts WHERE id=1')).rows[0].credits_used,10);
  assert.equal(hits(legacy.id).length,1);assert.equal(hits(bridged.id).length,1);
 }finally{
  for(const c of [...workers])await kill(c);if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await pool.query('DELETE FROM jobs;DELETE FROM accounts;DELETE FROM invocations');await pool.end();
 }
});
