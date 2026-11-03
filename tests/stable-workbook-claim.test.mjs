import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {stableWorkbookClaimOwned,withStableWorkbookClaim} from '../dist/sheets/stable-workbook-claim.js';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY); CREATE TABLE owner_personal_transactions(personal_use_id TEXT PRIMARY KEY)');sqlite.exec(readFileSync(new URL('../migrations/0021_stable_workbook_claim.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const q=sqlite.prepare(sql);let args=[];return{bind(...values){args=values;return this;},async first(){return q.get(...args)??null;},async run(){return{success:true,meta:{changes:Number(q.run(...args).changes)}};}};}};
 return{sqlite,env:{DB,GOOGLE_SPREADSHEET_ID:'book'},close(){sqlite.close();}};
}


test('claim serializes a workbook and releases only after a verified operation',async()=>{
 const h=fixture();try{const result=await withStableWorkbookClaim(h.env,async token=>{
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not run')),/BUSY/);
  assert.equal(await stableWorkbookClaimOwned(h.env,token),true);assert.equal(await stableWorkbookClaimOwned(h.env,'other'),false);
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');return 'verified';
 });assert.equal(result,'verified');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}
});

test('uncertain operation is retained for review and never auto-retried',async()=>{
 const h=fixture();try{await assert.rejects(withStableWorkbookClaim(h.env,async()=>{throw Error('unknown provider response');}));
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not run')),/BUSY/);
 }finally{h.close();}
});

test('lost claim acknowledgement cannot start an operation or free the claim',async()=>{
 const h=fixture();try{const prepare=h.env.DB.prepare;let once=true;h.env.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){const r=await run.call(this);if(once&&sql.includes('INSERT INTO stable_workbook_claims')){once=false;throw Error('lost acknowledgement');}return r;};return s;};
  let called=false;await assert.rejects(withStableWorkbookClaim(h.env,async()=>{called=true;}));assert.equal(called,false);
  assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not run')),/BUSY/);
 }finally{h.close();}
});
