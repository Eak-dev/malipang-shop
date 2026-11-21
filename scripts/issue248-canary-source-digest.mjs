// Issue 248 hotfix-only: the G7 canary's CURRENT source digest with the exact
// formula of src/sheets/stable-expense-source.ts, computed INSIDE D1 by one
// read-only statement. No expense column (LINE user ID, message ID, employee IDs,
// description) leaves the provider: the runner receives only the revision, counts,
// a provider self-test digest and the canary digest.
// - The exception accepts only the zero-item canary, so the statement hashes
//   '{"expense":<row>,"links":[],"documents":[],"items":[]}' where <row> is
//   json_object over EXPENSE_COLUMNS in table order (= SELECT e.* without
//   __stable_revision). Any link, document or item yields no digest.
// - SHA-256 is written in SQL: a recursive CTE over the hex of the UTF-8 bytes.
//   A constant synthetic row goes through the same JSON and SHA-256 SQL; its
//   digest must equal JSON.stringify + sha256 here, so a provider whose JSON,
//   integer or bitwise semantics differ stops the release instead of passing.
// - A UNION ALL with one constant per column fails to compile if expense_events
//   gains or loses a column, so the JSON cannot silently skip a column.
// - One statement is one consistent snapshot. Its revision must equal the epoch
//   query's revision (every source-table write bumps it via trigger).
// This proves the canary equals the G7 digest NOW. It cannot prove that no
// change-and-revert happened since G7 (ABA), and a zero-item canary cannot prove
// itemized DETAIL: both stay UNKNOWN and are owner-accepted residual risk.
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const fail=x=>{throw Error('NO_GO_CANARY_SOURCE_'+x)};
const integer=x=>Number.isSafeInteger(x)&&x>=0;
// expense_events in table order: migrations/0001_initial.sql, then 0013_expense_document_foundation.sql.
export const EXPENSE_COLUMNS=['expense_id','message_id','line_user_id','description','amount_satang','payment_key','source_wallet','category','transaction_date','status','trace_id','created_at','updated_at','submitted_by_employee_id','branch_id','reviewed_by_employee_id','approved_at','version'];
// Synthetic values only: quotes, backslash, control characters, Thai, emoji, U+2028/2029, DEL, NULL, 2^53-1.
const selftest={expense_id:'exp_selftest',message_id:'m"q\\b/\n\t\r\b\f',line_user_id:'U_SELFTEST\u0001\u001f\u007f',description:'ทดสอบ 😀   \'x\'',amount_satang:500,payment_key:'CASH',source_wallet:'SHOP_BANK',category:'selftest',transaction_date:'2026-11-11',status:'CONFIRMED',trace_id:null,created_at:'2026-11-11T00:00:00.000Z',updated_at:null,submitted_by_employee_id:'emp\u0008x',branch_id:null,reviewed_by_employee_id:'r ',approved_at:null,version:9007199254740991};
export const SELFTEST_ROW=Object.fromEntries(EXPENSE_COLUMNS.map(c=>[c,selftest[c]]));
export const SELFTEST_DIGEST=createHash('sha256').update(JSON.stringify({expense:SELFTEST_ROW,links:[],documents:[],items:[]})).digest('hex');
export const RESULT_COLUMNS=['rev','expense_rows','links','documents','items','selftest','digest'];

// ASCII-only SQL literal: printable runs stay quoted, every other code point uses char().
const sqlValue=v=>{
 if(v===null)return 'NULL';if(Number.isSafeInteger(v))return String(v);
 const parts=[];let run='';
 for(const c of v){if(/[ -&(-~]/.test(c))run+=c;else{if(run)parts.push(`'${run}'`);run='';parts.push(`char(${c.codePointAt(0)})`)}}
 if(run)parts.push(`'${run}'`);return parts.length?`(${parts.join('||')})`:"''";
};
const jsonOf=alias=>`'{"expense":'||json_object(${EXPENSE_COLUMNS.map(c=>`'${c}',${alias}.${c}`).join(',')})||',"links":[],"documents":[],"items":[]}'`;

const M=4294967295;
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const IV=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
// SQLite gives << >> & | one precedence level, so every operation is parenthesized.
// Values stay in [0, 2^32); XOR is (a|b)-(a&b).
const rotr=(x,n)=>`((${x}>>${n})|((${x}<<${32-n})&${M}))`;
const xor=(a,b)=>`((${a}|${b})-(${a}&${b}))`,xor3=(a,b,c)=>xor(xor(a,b),c);
const S0=xor3(rotr('a',2),rotr('a',13),rotr('a',22)),S1=xor3(rotr('e',6),rotr('e',11),rotr('e',25));
const s0=xor3(rotr('w1',7),rotr('w1',18),'(w1>>3)'),s1=xor3(rotr('w14',17),rotr('w14',19),'(w14>>10)');
// p is the padded message as a BLOB of hex digits (O(1) substr); 65 steps per 64-byte block,
// step 64 adds the block result into h0..h7; w0..w15 hold the last 16 schedule words.
const nibble=j=>`(instr('0123456789ABCDEF',substr(p,((s/65)*16+(s%65))*8+${j},1))-1)`;
const wt=`(CASE WHEN (s%65)<16 THEN (${[1,2,3,4,5,6,7,8].map(j=>`${nibble(j)}*${16**(8-j)}`).join('+')}) ELSE ((${s1}+w9+${s0}+w0)&${M}) END)`;
const t1=`((h+${S1}+((e&f)|((~e)&g))+(SELECT v FROM sha_k WHERE t=(s%65))+${wt})&${M})`,t2=`((${S0}+((a&b)|(a&c)|(b&c)))&${M})`;
const W=Array.from({length:16},(_,i)=>'w'+i),at64=(x,i)=>`CASE WHEN (s%65)=64 THEN ((h${i}+${x})&${M}) ELSE `;
const STEP=['p','n','s+1',`${at64('a',0)}((${t1}+${t2})&${M}) END`,`${at64('b',1)}a END`,`${at64('c',2)}b END`,`${at64('d',3)}c END`,
 `${at64('e',4)}((d+${t1})&${M}) END`,`${at64('f',5)}e END`,`${at64('g',6)}f END`,`${at64('h',7)}g END`,
 ...[...'abcdefgh'].map((x,i)=>`${at64(x,i)}h${i} END`),...W.slice(1),`CASE WHEN (s%65)=64 THEN 0 ELSE ${wt} END`];
const sha256Ctes=(name,hexSelect)=>`${name}_msg(x) AS (${hexSelect}),
${name}_pad(p,n) AS (SELECT CAST(x||'80'||hex(zeroblob((119-(length(x)/2)%64)%64))||printf('%016X',length(x)*4) AS BLOB),(length(x)/2+9+(119-(length(x)/2)%64)%64)/64 FROM ${name}_msg),
${name}(p,n,s,a,b,c,d,e,f,g,h,h0,h1,h2,h3,h4,h5,h6,h7,${W.join(',')}) AS (SELECT p,n,0,${IV.join(',')},${IV.join(',')},${W.map(()=>0).join(',')} FROM ${name}_pad UNION ALL SELECT ${STEP.join(',')} FROM ${name} WHERE s<n*65)`;
const digestOf=name=>`(SELECT printf('%08x%08x%08x%08x%08x%08x%08x%08x',h0,h1,h2,h3,h4,h5,h6,h7) FROM ${name} WHERE s=n*65)`;
const SELFTEST_CTES=`selftest_row AS (SELECT ${EXPENSE_COLUMNS.map(c=>`${sqlValue(SELFTEST_ROW[c])} AS ${c}`).join(',')}),
sha_k(t,v) AS (VALUES ${K.map((x,i)=>`(${i},${x})`).join(',')}),
${sha256Ctes('sha_selftest',`SELECT hex(${jsonOf('t')}) FROM selftest_row t`)}`;
// Provider preflight that reads no table: the same JSON and SHA-256 SQL over the synthetic row only.
export const selftestSql=()=>`WITH RECURSIVE ${SELFTEST_CTES} SELECT ${digestOf('sha_selftest')} AS selftest`.replace(/\n/g,' ');

export function canarySourceSql(targetKey,targetVersion){
 checkTarget(targetKey,targetVersion);const k=`'${targetKey}'`,v=targetVersion;
 return `WITH RECURSIVE src AS (SELECT (SELECT revision FROM stable_source_revision WHERE singleton=1) AS rev,
(SELECT count(*) FROM expense_events WHERE expense_id=${k} AND version=${v} AND status='CONFIRMED') AS expense_rows,
(SELECT count(*) FROM expense_document_links WHERE expense_id=${k}) AS links,
(SELECT count(*) FROM expense_documents WHERE expense_id=${k} OR document_id IN (SELECT document_id FROM expense_document_links WHERE expense_id=${k})) AS documents,
(SELECT count(*) FROM expense_document_items WHERE expense_id=${k}) AS items,
(SELECT count(*) FROM (SELECT e.* FROM expense_events e WHERE 0 UNION ALL SELECT ${EXPENSE_COLUMNS.map((_,i)=>i+1).join(',')})) AS width),
canary_json(j) AS (SELECT ${jsonOf('e')} FROM expense_events e,src WHERE e.expense_id=${k} AND e.version=${v} AND e.status='CONFIRMED' AND src.expense_rows=1 AND src.links=0 AND src.documents=0 AND src.items=0),
${SELFTEST_CTES},
${sha256Ctes('sha_canary','SELECT hex(j) FROM canary_json WHERE length(CAST(j AS BLOB))<=256000')}
SELECT rev,expense_rows,links,documents,items,${digestOf('sha_selftest')} AS selftest,${digestOf('sha_canary')} AS digest FROM src WHERE width=1`.replace(/\n/g,' '); // one line: no literal holds a newline
}
function checkTarget(targetKey,targetVersion){if(typeof targetKey!=='string'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(targetKey)||!Number.isSafeInteger(targetVersion)||targetVersion<1)fail('TARGET');}
const readOnlyRow=(rows,columns)=>{
 if(!Array.isArray(rows)||rows.length!==1)fail('EVIDENCE');
 const r=rows[0];if(r?.success!==true||r?.meta?.changed_db!==false||r?.meta?.rows_written!==0||!Array.isArray(r?.results)||r.results.length!==1)fail('EVIDENCE');
 const x=r.results[0];if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).join()!==columns.join())fail('EVIDENCE');
 return x;
};
export function verifySelftest(rows){if(readOnlyRow(rows,['selftest']).selftest!==SELFTEST_DIGEST)fail('PROVIDER_SELFTEST');return true;}
export function canarySourceDigest(rows,{targetKey,targetVersion,epochRevision}){
 checkTarget(targetKey,targetVersion);if(!integer(epochRevision))fail('EPOCH_REVISION');
 // One statement: exactly one read-only envelope holding one row of exactly RESULT_COLUMNS.
 const x=readOnlyRow(rows,RESULT_COLUMNS);
 if(x.selftest!==SELFTEST_DIGEST)fail('PROVIDER_SELFTEST');
 if(!integer(x.rev))fail('REVISION');if(x.rev!==epochRevision)fail('REVISION_MOVED');
 if(x.expense_rows!==1)fail('ROW_COUNT');
 if(![x.links,x.documents,x.items].every(integer))fail('EVIDENCE');
 if(x.links!==0||x.documents!==0||x.items!==0)fail('SHAPE');
 if(typeof x.digest!=='string'||!/^[0-9a-f]{64}$/.test(x.digest))fail('DIGEST');
 return {digest:x.digest,revision:x.rev,itemCount:0,documentCount:0,linkCount:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 const [mode,...a]=process.argv.slice(2);
 if(mode==='sql'){console.log(canarySourceSql(a[0],Number(a[1])))}
 else if(mode==='digest'){const r=canarySourceDigest(JSON.parse(readFileSync(a[0],'utf8')),{targetKey:a[1],targetVersion:Number(a[2]),epochRevision:Number(a[3])});console.log(JSON.stringify({digest:r.digest,revision:r.revision,items:r.itemCount,documents:r.documentCount,links:r.linkCount}))}
 else if(mode==='selftest-sql'){console.log(selftestSql())}
 else if(mode==='selftest-verify'){verifySelftest(JSON.parse(readFileSync(a[0],'utf8')));console.log('PROVIDER_SELFTEST_OK')}
 else fail('MODE');
}catch(e){console.error(typeof e?.message==='string'&&/^NO_GO_[A-Z0-9_]+$/.test(e.message)?e.message:'NO_GO_CANARY_SOURCE_UNKNOWN');process.exitCode=1}}
