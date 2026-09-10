'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {authorized}=require('../src/ads-report');
test('aggregate report rejects missing, short, malformed and wrong credentials',()=>{
 const secret='a'.repeat(64);
 assert.equal(authorized(undefined,secret),false);
 assert.equal(authorized('Bearer '+secret,undefined),false);
 assert.equal(authorized('Bearer short','short'),false);
 assert.equal(authorized('Bearer '+'b'.repeat(64),secret),false);
 assert.equal(authorized('Bearer '+secret,secret),true);
});
