import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),{InvocationBindingBudget}=require('../dist/sheets/invocation-binding-budget.js');

test('shared invocation counter reserves post-write D1 and queue capacity across competing callers',async()=>{
 const h=expenseSqlite();try{
  const usage=new InvocationBindingBudget({d1:6,queue:3}),main=usage.wrapD1(h.DB),out=[];
  const queue=usage.wrapQueue({async send(v){out.push(v);},async sendBatch(v){out.push(v);}});
  const retained=main.prepare('SELECT 1 AS n');assert.equal((await retained.first()).n,1);
  const token=usage.reservePost(3,2);assert.ok(token);
  const post=usage.wrapD1(h.DB,token),postQueue=usage.wrapQueue({async send(v){out.push(v);}},token);
  // The same invocation can perform two more pre-write calls, but neither
  // they nor another queue caller can consume reserved verification slots.
  const batched=await main.batch([main.prepare('SELECT 1 AS n'),main.prepare('SELECT 2 AS n')]);assert.equal(batched.length,2);
  await main.prepare('SELECT 3 AS n').all();await queue.send('pre');
  assert.throws(()=>main.prepare('SELECT 4').first(),/PRE_EXHAUSTED/);assert.throws(()=>queue.send('late'),/PRE_EXHAUSTED/);
  // A statement prepared in the main scope can participate in the
  // privileged post batch and still reaches the actual D1 binding unwrapped.
  assert.equal((await post.batch([retained]))[0].results[0].n,1);
  await post.prepare('SELECT 5').first();await post.prepare('SELECT 6').first();
  await postQueue.send('post1');await postQueue.send('post2');
  assert.throws(()=>post.prepare('SELECT 7').first(),/POST_EXHAUSTED/);assert.throws(()=>postQueue.send('post3'),/POST_EXHAUSTED/);
  assert.deepEqual(usage.snapshot().used,{d1:6,queue:3});assert.deepEqual(out,['pre','post1','post2']);usage.releasePost(token);
 }finally{h.close();}
});

test('invalid reservation and unwrapped methods fail closed',()=>{
 const usage=new InvocationBindingBudget({d1:2,queue:1});assert.equal(usage.reservePost(3,0),null);
 const token=usage.reservePost(1,1);assert.ok(token);assert.equal(usage.reservePost(1,0),null);
 const db=usage.wrapD1({prepare(){throw Error('unused');},exec(){},withSession(){}});
 assert.throws(()=>db.exec('select 1'),/UNSUPPORTED_D1_METHOD/);assert.throws(()=>db.withSession(),/UNSUPPORTED_D1_METHOD/);
 assert.throws(()=>usage.releasePost({}),/INVALID_TOKEN/);usage.releasePost(token);
});

test('caller cannot change limits, and releasing a reservation invalidates the old token',async()=>{
 const limits={d1:3,queue:2},usage=new InvocationBindingBudget(limits),h=expenseSqlite();try{
  limits.d1=100;const main=usage.wrapD1(h.DB),token=usage.reservePost(2,1),post=usage.wrapD1(h.DB,token);assert.ok(token);
  await main.prepare('SELECT 1').first();assert.throws(()=>main.prepare('SELECT 2').first(),/PRE_EXHAUSTED/);
  usage.releasePost(token);assert.throws(()=>post.prepare('SELECT 3').first(),/POST_EXHAUSTED/);
  await main.prepare('SELECT 4').first();await main.prepare('SELECT 5').first();assert.throws(()=>main.prepare('SELECT 6').first(),/PRE_EXHAUSTED/);
 }finally{h.close();}
});
