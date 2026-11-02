import type {Env} from "../types";
import {getSheetValues} from "../sheets/client";
import {activeOwnerSql,type OwnerReviewIdentity} from "./online-order-review-repository";
import {loadOwnerCorrectionDraft,loadOwnerExpense} from "./owner-correction-repository";
import type {OwnerCorrectionSnapshot} from "./owner-correction";
import {correctionAccountingPeriods,correctionPeriodHeaderDigest} from "./owner-correction-period-math";
export {correctionAccountingPeriods} from "./owner-correction-period-math";

export interface CorrectionPeriodView{periods:Array<{period:string;decision:"OPEN"|"HOLD"|"UNKNOWN"}>;headerDigest:string;version:number}
export interface CorrectionPeriodPorts{headers:(env:Env,range:string)=>Promise<unknown[][]>}
const defaults:CorrectionPeriodPorts={headers:getSheetValues};
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
const keys:Array<keyof OwnerCorrectionSnapshot>=["expenseId","status","version","updatedAt","description","category","amountSatang","transactionDate","paymentKey","sourceWallet"];
const equal=(a:OwnerCorrectionSnapshot,b:OwnerCorrectionSnapshot)=>keys.every(key=>a[key]===b[key]);

async function load(env:Env,owner:OwnerReviewIdentity,id:string,nowMs:number,ports:CorrectionPeriodPorts){
  const row=await loadOwnerCorrectionDraft(env,owner,id,nowMs);if(!row)return null;
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return null;}
  if(!before||!after||before.status!=="CONFIRMED"||before.expenseId!==after.expenseId||before.version!==after.version||before.updatedAt!==after.updatedAt)return null;
  const current=await loadOwnerExpense(env,owner,before.expenseId);if(!current||!equal(current,before))return null;
  const headers=await ports.headers(env,`${quote(env.SHEET_EXPENSE_DAILY)}!A1:W3`),periods=correctionAccountingPeriods(before,after,headers);
  const digest=await correctionPeriodHeaderDigest(headers);
  return {row,before,after,periods,digest};
}

/** Missing, conflicting, stale, or held decisions are never treated as open. */
export async function inspectOwnerCorrectionPeriods(env:Env,owner:OwnerReviewIdentity,id:string,nowMs=Date.now(),ports:CorrectionPeriodPorts=defaults):Promise<CorrectionPeriodView|null>{
  if(!Number.isFinite(nowMs))return null;const data=await load(env,owner,id,nowMs,ports);if(!data)return null;
  const result=await env.DB.prepare(`SELECT p.period,p.decision FROM expense_owner_correction_period_decisions p JOIN expense_owner_corrections c ON c.correction_id=p.correction_id WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND p.header_digest=? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,new Date(nowMs).toISOString(),data.digest,owner.employeeId,owner.lineUserId).all<{period:string;decision:string}>();
  const decisions=new Map<string,string>();for(const item of result.results||[])if(item.decision==="HOLD"||!decisions.has(item.period))decisions.set(item.period,item.decision);
  return {periods:data.periods.map(value=>({period:value,decision:decisions.get(value)==="OPEN"?"OPEN":decisions.get(value)==="HOLD"?"HOLD":"UNKNOWN"})),headerDigest:data.digest,version:data.before.version};
}

/** The explicit answer belongs only to this draft, actor, period and header layout. */
export async function recordOwnerCorrectionPeriodDecision(env:Env,owner:OwnerReviewIdentity,id:string,input:{period:string;headerDigest:string;version:number;decision:"OPEN"|"HOLD"},nowMs=Date.now(),ports:CorrectionPeriodPorts=defaults):Promise<"RECORDED"|"ALREADY"|"CONFLICT"|"STALE">{
  if(!Number.isFinite(nowMs)||(input.decision!=="OPEN"&&input.decision!=="HOLD"))return "STALE";
  const data=await load(env,owner,id,nowMs,ports);if(!data||data.digest!==input.headerDigest||data.before.version!==input.version||!data.periods.includes(input.period))return "STALE";
  const b=data.before,now=new Date(nowMs).toISOString();
  const inserted=await env.DB.prepare(`INSERT INTO expense_owner_correction_period_decisions(correction_id,period,header_digest,decision,actor_employee_id,created_at)
    SELECT c.correction_id,?,?,?,?,? FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
    WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=?
      AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=?
      AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED') AND ${activeOwnerSql}
      AND (?='HOLD' OR NOT EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions held WHERE held.correction_id=c.correction_id AND held.period=? AND held.header_digest=? AND held.decision='HOLD'))
    ON CONFLICT(correction_id,period,header_digest,decision) DO NOTHING`)
    .bind(input.period,data.digest,input.decision,owner.employeeId,now,id,owner.employeeId,now,String(data.row.before_json),String(data.row.after_json),b.expenseId,b.version,b.updatedAt,b.description,b.category,b.amountSatang,b.transactionDate,b.paymentKey,b.sourceWallet,owner.employeeId,owner.lineUserId,input.decision,input.period,data.digest).run();
  if(Number(inserted.meta.changes||0)===1)return "RECORDED";
  const view=await inspectOwnerCorrectionPeriods(env,owner,id,nowMs,ports),existing=view?.headerDigest===input.headerDigest?view.periods.find(item=>item.period===input.period)?.decision:null;
  return existing===input.decision?"ALREADY":existing&&existing!=="UNKNOWN"?"CONFLICT":"STALE";
}
