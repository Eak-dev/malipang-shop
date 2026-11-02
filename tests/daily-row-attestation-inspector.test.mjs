import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {inspectSignedExistingRow}=require('../dist/sheets/daily-row-attestation-inspector.js');
const {encodeEnrollmentApproval}=require('../dist/sheets/daily-row-enrollment.js');
const {sha256Hex}=require('../dist/shared/ids.js');
const auth=require('../dist/sheets/google-auth.js');
const formulaCols=[8,9,17,18,20],literalCols=Array.from({length:25},(_,i)=>i).filter(i=>!formulaCols.includes(i));
async function runCase(kind){
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const pub=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('base64');
 const headers=[['heading'],['','','','','','','','เงินโอน'],['','','','','','','NON-FIXED']],headerDigest=await sha256Hex(new TextEncoder().encode(JSON.stringify(headers)).buffer);
 const literals=Object.fromEntries(literalCols.map(i=>[i,'']));Object.assign(literals,{1:10,2:10,3:'personal',10:735,21:'บัญชีร้าน'});
 const formulas={8:'=SUM(F10:H10)',9:'=J9-I10',17:'=SUM(K10:Q10)',18:'=J10-R10',20:'=DATE($A$5,B10,C10)'};
 const entry={expenseId:'exp1',expenseVersion:5,postingDate:'2026-10-10',amountSatang:73500,paymentKey:'transfer',expenseStatus:'CONFIRMED',sourceWallet:'SHOP_BANK',category:'general',description:'personal',messageId:'msg1',rowNumber:10,metadataId:11,headerDigest,literals,formulas};
 const now=Date.now(),approval={version:'daily-row-enrollment-v1',approvalId:'a1',reviewerId:'owner1',spreadsheetId:'book',sheetId:1,leaseId:'unverified-lease',leaseVersion:1,issuedAtMs:now-1000,expiresAtMs:now+60000,entries:[entry]};
 const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,encodeEnrollmentApproval(approval)));
 const row={expense_id:'exp1',version:5,transaction_date:'2026-10-10',amount_satang:73500,payment_key:'transfer',status:'CONFIRMED',source_wallet:'SHOP_BANK',category:'general',description:'personal',message_id:'msg1'};
 let dbReads=0,fetches=0;
 const env={GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org',EXTERNAL_API_TIMEOUT_MS:'1000',DAILY_ROW_REVIEWER_ID:'owner1',DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64:pub,DAILY_ROW_SHEET_ID:'1',DAILY_ROW_APPROVED_PERIOD:'2026-10',DB:{prepare(sql){assert.match(sql,/FROM expense_events WHERE expense_id=\?/);return {bind(id){assert.equal(id,'exp1');return {async first(){dbReads++;const result=structuredClone(row);if(kind==='changed-db'&&dbReads===2)result.amount_satang++;if(kind==='stale-db')result.status='CANCELLED';if(kind==='missing-db')return null;return result}}}}}}};
 if(kind==='wrong-reviewer')env.DAILY_ROW_REVIEWER_ID='someone-else';
 if(kind==='wrong-key'){const other=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64=Buffer.from(await crypto.subtle.exportKey('raw',other.publicKey)).toString('base64');}
 if(kind==='wrong-sheet')env.DAILY_ROW_SHEET_ID='2';
 if(kind==='invalid-key')env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64='bad';
 if(kind==='wrong-period')env.DAILY_ROW_APPROVED_PERIOD='2026-09';
 if(kind==='tampered')entry.literals[10]=1000;
 const rows=Array.from({length:20},()=>[]);rows[4]=[2026];rows[5]=['',10,'','รายรับทั้งหมดในบัญชี'];rows[15]=['รวม',10];
 const cells=Array.from({length:25},()=>({}));for(const [i,f] of Object.entries(formulas))cells[Number(i)]={userEnteredValue:{formulaValue:f},effectiveValue:{numberValue:0}};for(const [i,v] of Object.entries(literals))if(v!=='')cells[Number(i)]={userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v},effectiveValue:typeof v==='number'?{numberValue:v}:{stringValue:v}};
 if(kind==='sheet-changed')cells[10].effectiveValue.numberValue=734;
 const sheet={properties:{sheetId:1,title:'daily',gridProperties:{rowCount:20,columnCount:25}},protectedRanges:[{range:{sheetId:1},requestingUserCanEdit:true,editors:{users:['worker@example.org']}}]};
 const target={properties:{sheetId:1,title:'daily'},data:[{startRow:9,rowData:[{values:cells}]}]};
 const marker={metadataId:11,metadataKey:'malipang_expense_daily',metadataValue:'exp1',location:{dimensionRange:{sheetId:1,dimension:'ROWS',startIndex:9,endIndex:10}}};
 const originalFetch=globalThis.fetch,originalAuth=auth.getGoogleAccessToken;auth.getGoogleAccessToken=async()=> 'synthetic';
 globalThis.fetch=async(input)=>{fetches++;const url=new URL(String(input));let json;if(url.pathname.endsWith('/developerMetadata:search'))json={matchedDeveloperMetadata:[{developerMetadata:marker}]};else if(url.pathname.endsWith('/developerMetadata/11'))json=marker;else if(url.pathname.endsWith('/values:batchGet'))json={valueRanges:[{values:rows},{values:headers}]};else if(url.searchParams.has('ranges'))json={sheets:[target]};else json={sheets:[sheet]};return new Response(JSON.stringify(json),{status:200,headers:{'content-type':'application/json'}})};
 try{return {result:await inspectSignedExistingRow(env,approval,signature),dbReads,fetches}}finally{globalThis.fetch=originalFetch;auth.getGoogleAccessToken=originalAuth;}
}
test('pinned signer, direct fresh D1 source and authenticated bounded sheet observations must all match',async()=>{const result=await runCase('valid');assert.equal(result.result,'CONSISTENT_READ_ONLY');assert.equal(result.dbReads,2);assert.equal(result.fetches,10)});
test('fail closed on untrusted authority, stale source, modified sheet or changed source',async()=>{for(const kind of ['wrong-reviewer','wrong-key','wrong-sheet','invalid-key','wrong-period','tampered','stale-db','missing-db','sheet-changed','changed-db']){const r=await runCase(kind);assert.equal(r.result,'HELD',kind)}});
