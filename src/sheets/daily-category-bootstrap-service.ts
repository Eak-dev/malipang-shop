import type {Env} from "../types";
import {createSheetRowMetadata,getSheetId,getSheetValues,searchSheetRowMetadata,type NewSheetRowMetadata,type SheetRowMetadata} from "./client";
import {collectDailyCategorySnapshot,type CategoryObserverPorts} from "./daily-category-observer";
import {planDailyCategoryBootstrap,type CategoryBootstrapExpense,type CategoryBootstrapProjectionRow,type CategoryBootstrapResult} from "./daily-category-bootstrap";
import {planCategoryMetadata,type CategoryExistingMetadata,type CategoryMetadataTarget} from "./daily-category-metadata";
import {registerDailyCategoryProjectionTarget,seedDailyCategoryBaseline} from "./daily-category-repository";

export interface CategoryBootstrapPorts extends CategoryObserverPorts {create:(env:Env,rows:NewSheetRowMetadata[])=>Promise<SheetRowMetadata[]>}
const defaultPorts:CategoryBootstrapPorts={sheetId:getSheetId,values:getSheetValues,metadata:searchSheetRowMetadata,create:createSheetRowMetadata};
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;

async function snapshot(env:Env,ports:CategoryBootstrapPorts){
  const detailSheet=env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ";
  const [daily,rawId,detailId,rawValues,detailValues,rawMetadata,itemMetadata,dailyMetadata,items]=await Promise.all([
    collectDailyCategorySnapshot(env,ports),ports.sheetId(env,env.SHEET_EXPENSE_RAW),ports.sheetId(env,detailSheet),
    ports.values(env,`${quote(env.SHEET_EXPENSE_RAW)}!A:R`),ports.values(env,`${quote(detailSheet)}!A:Q`),
    ports.metadata(env,"malipang_expense_raw"),ports.metadata(env,"malipang_expense_item"),ports.metadata(env,"malipang_expense_daily"),
    env.DB.prepare(`SELECT i.expense_id,i.item_id FROM expense_document_items i JOIN expense_events e ON e.expense_id=i.expense_id
      WHERE e.status='CONFIRMED' AND i.document_id=(SELECT d.document_id FROM expense_document_links l JOIN expense_documents d ON d.document_id=l.document_id
        WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at LIMIT 1)`).all<{expense_id:string;item_id:string}>()
  ]);
  const grouped=new Map<string,string[]>();for(const item of items.results||[]){const list=grouped.get(String(item.expense_id))||[];list.push(String(item.item_id));grouped.set(String(item.expense_id),list);}
  const expenses:CategoryBootstrapExpense[]=daily.expenses.map(item=>({...item,itemIds:grouped.get(item.expenseId)||[]}));
  const asRows=(sheetId:number,values:unknown[][]):CategoryBootstrapProjectionRow[]=>values.map((row,index)=>({sheetId,rowNumber:index+1,values:row}));
  const existing:CategoryExistingMetadata[]=[...rawMetadata,...itemMetadata,...dailyMetadata].map(m=>({sheetId:m.sheetId,rowIndex:m.rowIndex,key:m.metadataKey,value:m.metadataValue,metadataId:m.metadataId}));
  const dailyRows=daily.rows.map(row=>({...row,sheetId:daily.sheetId}));
  const plans=planDailyCategoryBootstrap(expenses,dailyRows,asRows(rawId,rawValues),asRows(detailId,detailValues),existing);
  return {daily,plans,existing};
}

/**
 * Provision a bounded batch after a full snapshot; re-read before registering.
 * Repeated calls recover safely after ambiguous metadata creation outcomes.
 */
export async function bootstrapDailyCategoryRows(env:Env,ports:CategoryBootstrapPorts=defaultPorts,limit=20):Promise<{ready:number;registered:number;conflicts:number;remaining:number}>{
  const cap=Math.max(1,Math.min(20,Math.floor(limit))),before=await snapshot(env,ports),ready=before.plans.filter(plan=>plan.kind==="READY"&&!before.daily.baselines.has(plan.expenseId)),selected=ready.slice(0,cap),targets=selected.flatMap(plan=>plan.targets);
  const metadataPlan=planCategoryMetadata(targets,before.existing);if(metadataPlan.some(item=>item.kind==="CONFLICT"))throw new Error("CATEGORY_BOOTSTRAP_METADATA_CONFLICT");
  const toCreate=metadataPlan.filter(item=>item.kind==="CREATE").map(item=>({metadataKey:item.target.key,metadataValue:item.target.value,sheetId:item.target.sheetId,rowIndex:item.target.rowIndex}));
  // Keep individual API requests bounded; a partial run is safe to resume.
  for(let start=0;start<toCreate.length;start+=100)await ports.create(env,toCreate.slice(start,start+100));
  const after=await snapshot(env,ports),byId=new Map(after.plans.map(plan=>[plan.expenseId,plan])),expenseById=new Map(after.daily.expenses.map(expense=>[expense.expenseId,expense]));let registered=0;
  for(const prior of selected){
    const current:CategoryBootstrapResult|undefined=byId.get(prior.expenseId),expense=expenseById.get(prior.expenseId);if(!current||current.kind!=="READY"||!expense)continue;
    const metadata=planCategoryMetadata(current.targets,after.existing);if(metadata.some(item=>item.kind!=="EXISTING"))continue;
    const lookup=(target:CategoryMetadataTarget)=>metadata.find(item=>item.target.key===target.key&&item.target.value===target.value);
    const dailyTarget=current.targets.find(item=>item.key==="malipang_expense_daily"),rawTarget=current.targets.find(item=>item.key==="malipang_expense_raw");if(!dailyTarget||!rawTarget)continue;
    const daily=lookup(dailyTarget),raw=lookup(rawTarget);if(daily?.kind!=="EXISTING"||raw?.kind!=="EXISTING")continue;
    const projection=[{expenseId:expense.expenseId,targetType:"RAW" as const,itemId:"",metadataId:raw.metadataId,expenseVersion:expense.version},
      ...current.targets.filter(item=>item.key==="malipang_expense_item").map(item=>{const m=lookup(item);return {expenseId:expense.expenseId,targetType:"ITEM" as const,itemId:item.value,metadataId:m?.kind==="EXISTING"?m.metadataId:0,expenseVersion:expense.version};})];
    for(const target of projection)await registerDailyCategoryProjectionTarget(env,target);
    const stored=await env.DB.prepare(`SELECT target_type,item_id,metadata_id FROM daily_category_projection_targets WHERE expense_id=?`).bind(expense.expenseId).all<Record<string,unknown>>();
    if((stored.results||[]).length!==projection.length||projection.some(target=>!(stored.results||[]).some(row=>row.target_type===target.targetType&&row.item_id===target.itemId&&Number(row.metadata_id)===target.metadataId)))continue;
    if(await seedDailyCategoryBaseline(env,{expenseId:expense.expenseId,rowNumber:dailyTarget.rowIndex+1,metadataId:daily.metadataId,fingerprint:expense.fingerprint,category:expense.category,expenseVersion:expense.version}))registered++;
  }
  return {ready:ready.length,registered,conflicts:before.plans.filter(plan=>plan.kind==="CONFLICT").length,remaining:Math.max(0,ready.length-selected.length)};
}
