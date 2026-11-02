import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {loadOwnerCorrectionDraft} from "../expense/owner-correction-repository";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {createSheetRowMetadata,getSheetRowMetadataById,type NewSheetRowMetadata} from "./client";
import {inspectOwnerCorrectionBootstrapPlan} from "./owner-correction-bootstrap-service";
import type {CategoryMetadataPlan,CategoryMetadataTarget} from "./owner-correction-metadata";

interface BootstrapPorts{inspect:typeof inspectOwnerCorrectionBootstrapPlan;create:typeof createSheetRowMetadata;byId:typeof getSheetRowMetadataById;now:()=>number;newId:()=>number}
const defaults:BootstrapPorts={inspect:inspectOwnerCorrectionBootstrapPlan,create:createSheetRowMetadata,byId:getSheetRowMetadataById,now:()=>Date.now(),newId:()=>{const value=new Uint32Array(1);crypto.getRandomValues(value);return (value[0]!%2147483647)+1;}};
interface PlannedTarget{target:CategoryMetadataTarget;metadataId:number}
type Result="READY"|"PENDING"|"REVIEW"|"STALE";
const key=(target:CategoryMetadataTarget)=>`${target.key}\u0000${target.value}`;
function match(planned:PlannedTarget[],actual:CategoryMetadataPlan[]):{missing:NewSheetRowMetadata[]}|null{
  if(planned.length!==actual.length||planned.length<2||planned.length>3)return null;
  const ids=new Set<number>(),keys=new Set<string>(),missing:NewSheetRowMetadata[]=[];
  for(const expected of planned){
    const target=expected?.target,id=expected?.metadataId;if(!target||!Number.isSafeInteger(id)||id<1||id>2147483647||ids.has(id)||keys.has(key(target)))return null;
    ids.add(id);keys.add(key(target));const found=actual.filter(item=>key(item.target)===key(target));
    if(found.length!==1||found[0]!.target.sheetId!==target.sheetId||found[0]!.kind==="CONFLICT")return null;
    const current=found[0]!;
    if(current.kind==="EXISTING"){if(current.metadataId!==id)return null;}
    else{
      // An older request could still use the saved row number. A moved,
      // currently unlinked target must therefore be reviewed, not retargeted.
      if(current.target.rowIndex!==target.rowIndex)return null;
      missing.push({metadataId:id,metadataKey:target.key,metadataValue:target.value,sheetId:target.sheetId,rowIndex:target.rowIndex});
    }
  }
  return {missing};
}

/**
 * Link only independently verified historic rows. Each possible create uses
 * an ID persisted before dispatch, so even overlapping lost-response retries
 * cannot create two associations. No expense value is changed here.
 */
export async function bootstrapStableOwnerCorrectionTargets(env:Env,owner:OwnerReviewIdentity,correctionId:string,before:OwnerCorrectionSnapshot,ports:BootstrapPorts=defaults):Promise<Result>{
  const nowMs=ports.now();if(!Number.isFinite(nowMs)||before.status!=="CONFIRMED"||!Number.isSafeInteger(before.version)||before.version<1)return "STALE";
  const draft=await loadOwnerCorrectionDraft(env,owner,correctionId,nowMs);if(!draft||draft.before_json!==JSON.stringify(before))return "STALE";
  let observed:CategoryMetadataPlan[]|null;try{observed=await ports.inspect(env,before);}catch{return "REVIEW";}
  if(!observed||observed.some(item=>item.kind==="CONFLICT"))return "REVIEW";
  let saved=await env.DB.prepare(`SELECT snapshot_json,targets_json FROM expense_owner_correction_bootstrap WHERE expense_id=? AND expense_version=?`).bind(before.expenseId,before.version).first<{snapshot_json:string;targets_json:string}>();
  if(!saved&&observed.every(item=>item.kind==="EXISTING"))return "READY";
  if(!saved){
    const used=new Set(observed.flatMap(item=>item.kind==="EXISTING"?[item.metadataId]:[])),targets:PlannedTarget[]=[];
    for(const item of observed){
      let id=item.kind==="EXISTING"?item.metadataId:0;
      for(let tries=0;!id&&tries<10;tries++){const candidate=ports.newId();if(Number.isSafeInteger(candidate)&&candidate>0&&candidate<=2147483647&&!used.has(candidate))id=candidate;}
      if(!id||targets.some(target=>target.metadataId===id))return "REVIEW";
      used.add(id);targets.push({target:item.target,metadataId:id});
    }
    if(!match(targets,observed))return "REVIEW";
    await env.DB.prepare(`INSERT INTO expense_owner_correction_bootstrap(expense_id,expense_version,snapshot_json,targets_json,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
        WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=?
          AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=?
          AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
          AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED'))
      ON CONFLICT(expense_id,expense_version) DO NOTHING`)
      .bind(before.expenseId,before.version,JSON.stringify(before),JSON.stringify(targets),new Date(nowMs).toISOString(),correctionId,owner.employeeId,new Date(nowMs).toISOString(),JSON.stringify(before),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
    saved=await env.DB.prepare(`SELECT snapshot_json,targets_json FROM expense_owner_correction_bootstrap WHERE expense_id=? AND expense_version=?`).bind(before.expenseId,before.version).first<{snapshot_json:string;targets_json:string}>();
  }
  if(!saved||saved.snapshot_json!==JSON.stringify(before))return "STALE";
  let planned:PlannedTarget[];try{planned=JSON.parse(saved.targets_json) as PlannedTarget[];}catch{return "REVIEW";}
  if(!Array.isArray(planned))return "REVIEW";
  let state=match(planned,observed);if(!state)return "REVIEW";if(!state.missing.length)return "READY";
  if(!await loadOwnerCorrectionDraft(env,owner,correctionId,ports.now()))return "STALE";
  for(const target of state.missing){
    const existing=await ports.byId(env,target.metadataId!);
    if(existing){
      if(existing.metadataKey!==target.metadataKey||existing.metadataValue!==target.metadataValue||existing.sheetId!==target.sheetId||existing.rowIndex!==target.rowIndex)return "REVIEW";
      // A direct ID lookup sees the association before the key search does.
      return "PENDING";
    }
  }
  try{await ports.create(env,state.missing);}catch{/* Re-read; a lost response may have created all IDs. */}
  try{observed=await ports.inspect(env,before);}catch{return "REVIEW";}
  if(!observed)return "PENDING";state=match(planned,observed);if(!state)return "REVIEW";
  return state.missing.length?"PENDING":"READY";
}
