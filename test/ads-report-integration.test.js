'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {query,pool}=require('../src/db');
const express=require('express');
const {install}=require('../src/ads-report');
test('authenticated report excludes QA and observes activation', {skip:!String(process.env.DATABASE_URL||'').includes('pdfmint_ads_test')},async()=>{
 const app=express();install(app);process.env.GROWTH_ADS_REPORT_TOKEN='test-only-'.repeat(8);
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port+'/internal/growth-ads/report';
 const headers={Authorization:'Bearer '+process.env.GROWTH_ADS_REPORT_TOKEN};let ids=[];
 try{
 assert.equal((await fetch(url)).status,401);
 const before=await(await fetch(url,{headers})).json();
 for(const qa of [false,true]){
 const {rows}=await query("INSERT INTO accounts(email,password_hash,internal) VALUES($1,'test-only',$2) RETURNING id",['ads-report-'+require('crypto').randomBytes(8).toString('hex')+'@example.com',qa]);
 const id=rows[0].id;ids.push(id);
 await query('INSERT INTO ad_signup_conversions(account_id,campaign_id,qa) VALUES($1,$2,$3)',[id,'growth-ads-pdfmint-20260910',qa]);
 await query("INSERT INTO usage_events(account_id,kind,ok,origin) VALUES($1,'pdf',true,'production')",[id]);
 }
 const r=await fetch(url,{headers});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const data=await r.json();assert.equal(data.trials,before.trials+1);assert.equal(data.activated,before.activated+1);
 }finally{await query('DELETE FROM accounts WHERE id=ANY($1::bigint[])',[ids]);server.close();await pool.end();}
});
