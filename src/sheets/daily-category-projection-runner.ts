import type {Env} from "../types";
import {batchWriteMetadataColumns,getSheetId,readSheetRowsByMetadata,searchSheetRowMetadata,type MetadataColumnWrite,type SheetRowMetadata} from "./client";
import {planDailyCategoryProjection,type MetadataRow} from "./daily-category-projection";
import {numberEnv} from "../shared/env";

export interface CategoryProjectionPorts{
  sheetId:(env:Env,name:string)=>Promise<number>;
  search:(env:Env,key:string)=>Promise<SheetRowMetadata[]>;
  read:(env:Env,ids:number[])=>Promise<Map<number,unknown[]>>;
  write:(env:Env,writes:MetadataColumnWrite[],fence:()=>Promise<void>)=>Promise<void>;
}
const defaultPorts:CategoryProjectionPorts={sheetId:getSheetId,search:searchSheetRowMetadata,read:readSheetRowsByMetadata,write:batchWriteMetadataColumns};

async function prepareTargets(env:Env,expenseId:string,version:number,fromCategory:string,toCategory:string,ports:CategoryProjectionPorts,requireOriginal=false):Promise<MetadataColumnWrite[]>{
  const targets=await env.DB.prepare(`SELECT target_type,item_id,metadata_id FROM daily_category_projection_targets WHERE expense_id=?`).bind(expenseId).all<Record<string,unknown>>();
  const items=await env.DB.prepare(`SELECT item_id FROM expense_document_items WHERE expense_id=? AND document_id=(SELECT d.document_id FROM expense_document_links l
    JOIN expense_documents d ON d.document_id=l.document_id WHERE l.expense_id=? AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at LIMIT 1)`).bind(expenseId,expenseId).all<{item_id:string}>();
  const expected=(items.results||[]).map(item=>String(item.item_id)),records=targets.results||[],rawTargets=records.filter(item=>item.target_type==="RAW"),itemTargets=records.filter(item=>item.target_type==="ITEM");
  if(rawTargets.length!==1||itemTargets.length!==expected.length||records.length!==1+expected.length)throw new Error("CATEGORY_PROJECTION_TARGETS_INCOMPLETE");
  const [rawSheetId,detailSheetId,rawMetadata,itemMetadata]=await Promise.all([ports.sheetId(env,env.SHEET_EXPENSE_RAW),ports.sheetId(env,env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ"),ports.search(env,"malipang_expense_raw"),ports.search(env,"malipang_expense_item")]);
  const ids=records.map(target=>Number(target.metadata_id)),metadata=[...rawMetadata,...itemMetadata].filter(item=>ids.includes(item.metadataId));
  if(new Set(ids).size!==ids.length||metadata.length!==ids.length)throw new Error("CATEGORY_PROJECTION_METADATA_INCOMPLETE");
  const values=await ports.read(env,ids),asRow=(id:number):MetadataRow=>{const m=metadata.find(item=>item.metadataId===id),v=values.get(id);if(!m||!v)throw new Error("CATEGORY_PROJECTION_METADATA_MISSING");return {...m,values:v};};
  const raw=asRow(Number(rawTargets[0]!.metadata_id)),details=itemTargets.map(target=>asRow(Number(target.metadata_id)));
  if(requireOriginal&&(raw.values[6]!==fromCategory||details.some(detail=>detail.values[14]!==fromCategory)))throw new Error("CATEGORY_PREFLIGHT_TARGET_CHANGED");
  return planDailyCategoryProjection({expenseId,expenseVersion:version,jobVersion:version,status:"CONFIRMED",fromCategory,toCategory,currentCategory:toCategory,rawSheetId,detailSheetId,raw,details,expectedItemIds:expected});
}

/** Revalidate every downstream target before accepting the owner's approval. */
export async function preflightDailyCategoryProjection(env:Env,input:{expenseId:string;version:number;fromCategory:string;toCategory:string},ports:CategoryProjectionPorts=defaultPorts):Promise<void>{
  const current=await env.DB.prepare(`SELECT 1 ok FROM expense_events WHERE expense_id=? AND status='CONFIRMED' AND version=? AND category=?`).bind(input.expenseId,input.version,input.fromCategory).first<{ok:number}>();
  if(!current)throw new Error("CATEGORY_PREFLIGHT_STALE");
  await prepareTargets(env,input.expenseId,input.version,input.fromCategory,input.toCategory,ports,true);
}

/** The caller owns and maintains the long-lived per-expense sync lease. */
export async function runDailyCategoryProjection(env:Env,job:{expenseId:string;version:number;leaseToken:string},ports:CategoryProjectionPorts=defaultPorts):Promise<void>{
  if(!job.expenseId||!Number.isSafeInteger(job.version)||job.version<1||!job.leaseToken)throw new Error("INVALID_CATEGORY_PROJECTION_JOB");
  const row=await env.DB.prepare(`SELECT e.expense_id,e.status,e.version,e.category,r.from_category,r.to_category
    FROM expense_events e JOIN daily_category_requests r ON r.expense_id=e.expense_id AND r.status='APPROVED'
    JOIN expense_audit_log a ON a.expense_id=e.expense_id AND json_extract(a.after_json,'$.requestId')=r.request_id
      AND json_extract(a.after_json,'$.version')=? AND a.action='EDIT'
    WHERE e.expense_id=? AND e.version=? LIMIT 1`).bind(job.version,job.expenseId,job.version).first<Record<string,unknown>>();
  if(!row||row.status!=="CONFIRMED"||row.category!==row.to_category)throw new Error("CATEGORY_PROJECTION_NOT_CURRENT");
  const writes=await prepareTargets(env,job.expenseId,job.version,String(row.from_category),String(row.to_category),ports);
  await ports.write(env,writes,async()=>{
    const nowMs=Date.now(),now=new Date(nowMs).toISOString(),clientTimeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000));
    const leaseUntil=new Date(nowMs+Math.max(15*60_000,clientTimeout+240_000)).toISOString();
    const guard=await env.DB.prepare(`UPDATE sync_jobs SET lease_until=?,updated_at=?
      WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>?
        AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.status='CONFIRMED' AND e.version=? AND e.category=?)`)
      .bind(leaseUntil,now,job.expenseId,job.version,job.leaseToken,now,job.version,String(row.to_category)).run();
    if(Number(guard.meta.changes||0)!==1)throw new Error("CATEGORY_PROJECTION_FENCE_LOST");
  });
}
