import type {Env} from '../types';
import {expenseSourceEvidenceIntegrity} from './expense-projection-runtime-journal';
import {personalRecoverySourceIntegrity} from './personal-projection-runtime-journal';
import {sheetScopesDistinct} from './sheet-scope-isolation';

// Ordered JSON is transient D1 preimage evidence, never an audit field or a
// row locator. This covers only expense/personal sources. Payroll, manual
// entries and other possible origins are not yet excluded, so it cannot
// authorize attachment or a write even when these snapshots match.
const expenseRows=`SELECT json_group_array(json_array(expense_id,transaction_date,description,amount_satang,payment_key,source_wallet,category,status,version,revision,revision_state)) FROM (SELECT e.expense_id,e.transaction_date,e.description,e.amount_satang,e.payment_key,e.source_wallet,e.category,e.status,e.version,r.revision,r.state AS revision_state FROM expense_events e LEFT JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id WHERE e.transaction_date>=? AND e.transaction_date<? ORDER BY e.expense_id LIMIT 1001)`;
const personalRows=`SELECT json_group_array(json_array(personal_use_id,transaction_date,description,amount_satang,source_wallet,transaction_type,status,version,revision,revision_state)) FROM (SELECT p.personal_use_id,p.transaction_date,p.description,p.amount_satang,p.source_wallet,p.transaction_type,p.status,p.version,r.revision,r.state AS revision_state FROM owner_personal_transactions p LEFT JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id WHERE p.transaction_date>=? AND p.transaction_date<? ORDER BY p.personal_use_id LIMIT 501)`;
const integrity=`${expenseSourceEvidenceIntegrity} AND ${personalRecoverySourceIntegrity} AND EXISTS(SELECT 1 FROM expense_projection_bootstrap WHERE singleton=1 AND state='COMPLETE') AND EXISTS(SELECT 1 FROM personal_projection_bootstrap WHERE singleton=1 AND state='COMPLETE') AND NOT EXISTS(SELECT 1 FROM expense_events e WHERE typeof(e.transaction_date)<>'text' OR e.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(e.transaction_date,'+0 days') IS NOT e.transaction_date) AND NOT EXISTS(SELECT 1 FROM owner_personal_transactions p WHERE typeof(p.transaction_date)<>'text' OR p.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(p.transaction_date,'+0 days') IS NOT p.transaction_date)`;
function check(env:Env):void{if(env.RUNTIME_MODE!=='production'||env.DAILY_LEGACY_SOURCE_FENCE_ENABLED!=='true'||env.DAILY_LEGACY_ENROLLMENT_PREFLIGHT_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!sheetScopesDistinct(env))throw Error('DAILY_LEGACY_SOURCE_FENCE_DISABLED');}
function scope(env:Env):string{return JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ']);}
function bounds(year:number,month:number):{start:string;end:string}{if(!Number.isInteger(year)||year<1901||year>9998||!Number.isInteger(month)||month<1||month>12)throw Error('DAILY_LEGACY_SOURCE_FENCE_INVALID');const fmt=(d:Date)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`;return{start:fmt(new Date(Date.UTC(year,month-2,1))),end:fmt(new Date(Date.UTC(year,month,1)))};}
function validRows(json:string,kind:'EXPENSE'|'PERSONAL'):boolean{
 if(new TextEncoder().encode(json).byteLength>1000000)return false;let rows:unknown;try{rows=JSON.parse(json);}catch{return false;}
 if(!Array.isArray(rows)||rows.length>(kind==='EXPENSE'?1000:500))return false;
 return rows.every(r=>{if(!Array.isArray(r)||r.length!==(kind==='EXPENSE'?11:10))return false;const expense=kind==='EXPENSE',version=expense?8:7,revision=expense?9:8,state=expense?10:9;return typeof r[0]==='string'&&(expense?/^exp_[A-Za-z0-9_-]{1,128}$/:/^personal_[A-Za-z0-9_-]{1,128}$/).test(r[0])&&typeof r[1]==='string'&&typeof r[2]==='string'&&Number.isSafeInteger(r[3])&&r[3]>0&&r.slice(4,version).every(v=>typeof v==='string'&&v.length>0)&&Number.isSafeInteger(r[version])&&r[version]>0&&Number.isSafeInteger(r[revision])&&r[revision]>0&&r[state]==='TRACKED';});
}
const constructorKey=Symbol('daily-legacy-source-fence');
/** A single D1 snapshot of expense and personal-use source rows only. */
export class DailyLegacySourceFence {
 #expense:string;#personal:string;#start:string;#end:string;#env:Env;#db:Env['DB'];#scope:string;
 private constructor(key:symbol,env:Env,start:string,end:string,expense:string,personal:string){if(key!==constructorKey)throw Error('DAILY_LEGACY_SOURCE_FENCE_INVALID');this.#env=env;this.#db=env.DB;this.#scope=scope(env);this.#start=start;this.#end=end;this.#expense=expense;this.#personal=personal;Object.freeze(this);}
 static async capture(env:Env,year:number,month:number):Promise<DailyLegacySourceFence>{
  check(env);const {start,end}=bounds(year,month),db=env.DB,initialScope=scope(env);
  try{const row=await db.prepare(`SELECT (${expenseRows}) AS expenses,(${personalRows}) AS personal WHERE ${integrity}`).bind(start,end,start,end).first<{expenses:string;personal:string}>();
   check(env);if(env.DB!==db||scope(env)!==initialScope||!row||typeof row.expenses!=='string'||typeof row.personal!=='string'||!validRows(row.expenses,'EXPENSE')||!validRows(row.personal,'PERSONAL'))throw Error('unavailable');
   return new DailyLegacySourceFence(constructorKey,env,start,end,row.expenses,row.personal);
  }catch{throw Error('DAILY_LEGACY_SOURCE_FENCE_UNAVAILABLE');}
 }
 /** Read-only comparison of the two covered source families. Matching is
  * partial evidence, not permission to attach an identity. */
 async matches(env:Env):Promise<boolean>{check(env);if(env!==this.#env||env.DB!==this.#db||scope(env)!==this.#scope)throw Error('DAILY_LEGACY_SOURCE_FENCE_CHANGED');try{const row=await this.#db.prepare(`SELECT 1 AS ok WHERE ${integrity} AND (${expenseRows})=? AND (${personalRows})=?`).bind(this.#start,this.#end,this.#expense,this.#start,this.#end,this.#personal).first<{ok:number}>();check(env);return env.DB===this.#db&&scope(env)===this.#scope&&!!row;}catch{return false;}}
 /** Other possible sources lack a verified inventory. Never use a partial
  * tuple match as authority for a provider mutation. */
 dispatchPredicate(env:Env):{sql:string;args:unknown[]}{check(env);if(env!==this.#env||env.DB!==this.#db||scope(env)!==this.#scope)throw Error('DAILY_LEGACY_SOURCE_FENCE_CHANGED');return{sql:'0=1',args:[]};}
}
Object.freeze(DailyLegacySourceFence);Object.freeze(DailyLegacySourceFence.prototype);
