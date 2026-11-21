import {continuousSheetsReadPolicy,type ContinuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from './client';
import {columnName,findMonthBlocks,legacySourceWallet,resolvePayment} from './daily-expense';
import {inspectDailyAppendSnapshot} from './daily-append-preflight';
import {verifyDailyRecoveryAccounting} from './daily-recovery-accounting';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {planStableLedgerRow} from './stable-ledger-row-plan';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import type {StableExpenseSource} from './stable-expense-source';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {verifyInsertedDailyFinalSnapshot} from './insert-daily-writer';
import {resolveCarrierLedgerTarget,indexCarrierLedgerSnapshot,type CarrierLedgerSnapshotIndex} from './atomic-expense-ledger-writer';
import type {CarrierLedgerRow} from './atomic-expense-ledger-template';
import {continuousDailyCutoverIntegrity} from './continuous-daily-cutover';
import {stableSourceIntegrity} from './stable-source-cutover';
import {readContinuousReportHealth} from './continuous-report-health';
import {readLegacyDailyCoverage,type LegacyDailySnapshot} from './legacy-daily-coverage';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';
import type {DailyPublicationAccountingEvidence} from './mixed-daily-accounting';

const rawHeaders=['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID'];
const detailHeaders=['Purchase_Item_ID','Expense_ID','Document_ID','วันที่ซื้อ','บริษัท/ร้านค้า','เลขที่เอกสาร','รายการสินค้า','จำนวน','หน่วย','ราคาต่อหน่วย','ส่วนลดรายการ','จำนวนเงินรายการ','ส่วนลด/ปรับยอดระดับเอกสาร','ยอดจ่ายจริงของ Expense','หมวด','สาขา','สถานะ','Evidence ref (private)','Created_At','Updated_At / Cancelled_At'];
type Journal={entity_id:string;projection:string;sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string;operation_token?:string};
export type PublicationFinalEvidence=DailyPublicationAccountingEvidence&{phase:'STAGED'|'PUBLISHED'};

/** Verify the complete current workbook immediately before closing a staged
 * expense. Journal evidence alone cannot prove that a person did not edit an
 * earlier projection between stages. */
export async function verifyStableExpenseProjections(env:Env,job:SheetsSyncJob,source:StableExpenseSource,journals:Journal[],publication?:PublicationFinalEvidence,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,snapshot?:PublicationBatchSnapshot):Promise<void>{
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]),initialScope=scope(),db=env.DB;
 const target=await assertContinuousDailyActivated(env),dailyJournal=journals.find(j=>j.entity_id===job.entityKey&&j.projection==='DAILY'),daily=dailyJournal?.sheet_name||env.SHEET_EXPENSE_DAILY;
 const atomic=!!target&&daily===target.sheet;
 const publicationCopy=publication?{...publication,markers:new Map(publication.markers)}:undefined;
 if(publicationCopy&&(!atomic||!['STAGED','PUBLISHED'].includes(publicationCopy.phase)||publicationCopy.allowAbsentStaged!==undefined||publicationCopy.markers.get(job.entityKey)?.state!==publicationCopy.phase||publicationCopy.markers.get(job.entityKey)?.version!==job.entityVersion))throw Error('STABLE_FINAL_PUBLICATION');
 if(daily!==env.SHEET_EXPENSE_DAILY&&!atomic)throw Error('STABLE_FINAL_DAILY_TARGET');
 if(atomic&&dailyJournal?.sheet_id!==target!.sheetId)throw Error('STABLE_FINAL_DAILY_TARGET');
 const plan=planStableExpenseProjections(source),rawTarget=atomic?resolveCarrierLedgerTarget(env,'EXPENSE_RAW'):null,detailTarget=atomic?resolveCarrierLedgerTarget(env,'DETAIL'):null,raw=rawTarget?.sheet||env.SHEET_EXPENSE_RAW,detail=detailTarget?.sheet||env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ';
 const names=[daily,raw,...plan.details.length?[detail]:[]];
 if(names.some(x=>!x)||new Set(names).size!==names.length)throw Error('STABLE_FINAL_SHEET_ALIAS');
 const expected=[{id:job.entityKey,projection:'DAILY',sheet:daily},{id:job.entityKey,projection:'EXPENSE_RAW',sheet:raw},...plan.details.map(x=>({id:`${job.entityKey}|${x.itemId}`,projection:'DETAIL',sheet:detail}))];
 const journalKey=(id:string,projection:string)=>JSON.stringify([id,projection]),journalByKey=new Map<string,Journal>();for(const j of journals){const k=journalKey(j.entity_id,j.projection);if(journalByKey.has(k))throw Error('STABLE_FINAL_JOURNAL');journalByKey.set(k,j);}
 if(journals.length!==expected.length||expected.some(e=>{const j=journalByKey.get(journalKey(e.id,e.projection));return !j||j.sheet_name!==e.sheet||j.source_version!==job.entityVersion||j.source_digest!==source.digest||j.state!=='VERIFIED';}))throw Error('STABLE_FINAL_JOURNAL');
 const grids=snapshot?names.map(name=>{const s=snapshot.metadata.find(x=>x.title===name);if(!s)throw Error('STABLE_FINAL_GRID');return{sheetId:s.sheetId,rowCount:s.rowCount,columnCount:s.columnCount};}):await Promise.all(names.map(name=>getSheetGridInfo(env,name,atomic?policy:undefined)));
 if(grids.some(g=>g.rowCount>5000||g.columnCount>100)||grids[0]!.columnCount<25||grids[1]!.columnCount<rawHeaders.length||plan.details.length&&grids[2]!.columnCount<detailHeaders.length)throw Error('STABLE_FINAL_GRID');
 for(const e of expected){const grid=grids[names.indexOf(e.sheet)]!,j=journalByKey.get(journalKey(e.id,e.projection))!;if(j.sheet_id!==grid.sheetId)throw Error('STABLE_FINAL_GRID');}
 const ranges=names.map((name,i)=>`'${name.replace(/'/g,"''")}'!A1:${columnName(grids[i]!.columnCount)}${grids[i]!.rowCount}`);
 const formula=snapshot?grids.map(g=>publicationSnapshotRange(snapshot,g.sheetId,1,g.rowCount,1,g.columnCount,'FORMULA')):await batchGetSheetFormulaValues(env,ranges,atomic?policy:undefined),effective=snapshot?grids.slice(0,atomic?grids.length:1).map(g=>publicationSnapshotRange(snapshot,g.sheetId,1,g.rowCount,1,g.columnCount,'EFFECTIVE')):await batchGetSheetEffectiveSerialValues(env,atomic?ranges:[ranges[0]!],atomic?policy:undefined);
 const after=snapshot?grids:await Promise.all(names.map(name=>getSheetGridInfo(env,name,atomic?policy:undefined)));
 if(formula.length!==names.length||effective.length!==(atomic?names.length:1)||JSON.stringify(grids)!==JSON.stringify(after)||formula.some((rows,i)=>rows.length>grids[i]!.rowCount||rows.some(row=>!Array.isArray(row)||row.length>grids[i]!.columnCount))||effective.some((rows,i)=>rows.length>grids[i]!.rowCount||rows.some(row=>!Array.isArray(row)||row.length>grids[i]!.columnCount)))throw Error('STABLE_FINAL_READ');
 const d=formula[0]!,v=effective[0]!,e=source.expense,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.transaction_date||''));if(!date)throw Error('STABLE_FINAL_DATE');let legacy:LegacyDailySnapshot|undefined;
 if(atomic){
  if(!dailyJournal)throw Error('STABLE_FINAL_DAILY_TARGET');
  const payment=resolvePayment(d.slice(0,3),plan.record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
  legacy=await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,daily,atomic?policy:undefined,snapshot);
  await verifyInsertedDailyFinalSnapshot(env,job,source,daily,grids[0]!.sheetId,grids[0]!,{formula:d,effective:v},dailyJournal,legacy.coverage,publicationCopy,policy);
 }else{
 const payment=resolvePayment(d.slice(0,3),plan.record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3])),blocks=findMonthBlocks(d).filter(b=>b.month===payment.postingMonth),key=stableDailyExpenseKey(job.entityKey),found=d.flatMap((row,i)=>row[23]===key?[i+1]:[]);
 if(blocks.length!==1||found.length!==1)throw Error('STABLE_FINAL_DAILY_ID');
 const block=blocks[0]!,row=found[0]!,data=d[row-1]||[],columns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},col=columns[payment.amountColumn];
 if(row<=block.headerRow||row>=block.totalRow||col===undefined||Number(data[1])!==payment.postingMonth||Number(data[2])!==payment.postingDay||data[3]!==plan.record.description.trim()||data[col]!==plan.record.amountBaht||data[21]!==plan.record.category||data[22]!==legacySourceWallet(plan.record.paymentKey,plan.record.sourceWallet))throw Error('STABLE_FINAL_DAILY_DATA');
 for(let n=block.headerRow+1;n<block.totalRow;n++)if((d[n-1]??[]).slice(25).some(x=>x!==null&&x!==undefined&&x!==''))throw Error('STABLE_FINAL_DAILY_EXTRA');
 const previous=Array.from({length:25},(_,i)=>data[i]??null),checked=inspectDailyAppendSnapshot({formula:d.map(x=>x.slice(0,25)),effective:v.map(x=>x.slice(0,25)),rowCount:grids[0]!.rowCount,expenseId:job.entityKey,year:payment.postingYear,month:payment.postingMonth,expectedPrevious:previous});
 if(checked.status!=='FOUND'||checked.observedRow!==row||!verifyDailyRecoveryAccounting(d,v,row,payment.postingMonth,payment.postingYear,payment.postingDay))throw Error('STABLE_FINAL_DAILY_ACCOUNTING');
 }
 if(atomic){
  if(!rawTarget||grids[1]!.sheetId!==rawTarget.sheetId||plan.details.length&&(!detailTarget||grids[2]!.sheetId!==detailTarget.sheetId))throw Error('STABLE_FINAL_CARRIER_TARGET');
  const expectedRows:CarrierLedgerRow[]=[{projection:'EXPENSE_RAW',expenseId:job.entityKey,itemId:'',confirmedVersion:job.entityVersion,status:'CONFIRMED',cancelVersion:null,cancelledAt:'',values:plan.raw},...plan.details.map(item=>({projection:'DETAIL' as const,expenseId:job.entityKey,itemId:item.itemId,confirmedVersion:job.entityVersion,status:'CONFIRMED' as const,cancelVersion:null,cancelledAt:'',values:item.values}))];
  const evidenceStatements:D1PreparedStatement[]=[],indexes=new Map<'EXPENSE_RAW'|'DETAIL',CarrierLedgerSnapshotIndex>();
  for(const item of expectedRows){
   const index=item.projection==='EXPENSE_RAW'?1:2,entity=item.projection==='EXPENSE_RAW'?job.entityKey:`${job.entityKey}|${item.itemId}`,j=journalByKey.get(journalKey(entity,item.projection));let carrierIndex=indexes.get(item.projection);if(!carrierIndex){carrierIndex=indexCarrierLedgerSnapshot({formula:formula[index]!,effective:effective[index]!},grids[index]!.rowCount,grids[index]!.columnCount,item.projection);indexes.set(item.projection,carrierIndex);}const row=carrierIndex.find(item);
   if(!row||!j?.operation_token)throw Error('STABLE_FINAL_CARRIER_IDENTITY');
   const cells=Array.from({length:26},(_,i)=>formula[index]![row-1]?.[i]===undefined||formula[index]![row-1]?.[i]===''?null:formula[index]![row-1]![i]),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(cells)))),v=>v.toString(16).padStart(2,'0')).join('');
   evidenceStatements.push(db.prepare(`SELECT 1 AS ok FROM stable_expense_projection_preimages p JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection=? AND p.sheet_id=? AND p.sheet_name=? AND p.source_version=? AND p.source_digest=? AND p.preimage_width=26 AND p.preimage_digest=? AND m.operation_token=? AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity}`).bind(env.GOOGLE_SPREADSHEET_ID,entity,item.projection,grids[index]!.sheetId,names[index],job.entityVersion,source.digest,digest,j.operation_token));
  }
  const evidence=await db.batch(evidenceStatements);if(evidence.length!==evidenceStatements.length||evidence.some(r=>r.success!==true||r.results?.length!==1))throw Error('STABLE_FINAL_CARRIER_PREIMAGE');
 }else{
  if(rawHeaders.some((h,i)=>formula[1]![0]?.[i]!==h)||planStableLedgerRow(formula[1]!,job.entityKey,plan.raw,false).status!=='PRESENT')throw Error('STABLE_FINAL_RAW');
  if(plan.details.length&&(detailHeaders.some((h,i)=>formula[2]![0]?.[i]!==h)||plan.details.some(item=>planStableLedgerRow(formula[2]!,item.itemId,item.values,false).status!=='PRESENT')))throw Error('STABLE_FINAL_DETAIL');
 }
 if(legacy&&JSON.stringify(await readLegacyDailyCoverage(env,legacy.coverage.year,legacy.coverage.month,daily,atomic?policy:undefined,snapshot))!==JSON.stringify(legacy))throw Error('STABLE_FINAL_LEGACY_CHANGED');
 if(atomic){
  const report=publicationCopy?.phase==='STAGED'?{expenseId:job.entityKey,absent:true as const,absentFromViews:true}:{expenseId:job.entityKey,transactionDate:plan.record.transactionDate,amountSatang:Number(source.expense.amount_satang),wallet:plan.record.sourceWallet,category:plan.record.category,itemIds:plan.details.map(item=>item.itemId)};
  if(await readContinuousReportHealth(env,report,publicationCopy?{dailySheet:daily}:undefined,policy,snapshot)!=='OK')throw Error('STABLE_FINAL_REPORT_UNVERIFIED');
 }
 if(env.DB!==db||scope()!==initialScope)throw Error('STABLE_FINAL_SCOPE_CHANGED');
}

/** Separate post-publication readback. It repeats source projections,
 * preimages, accounting, installed formulas and exact report item coverage;
 * the caller must independently re-read the published marker immediately
 * before and after this check. */
export async function verifyStableExpensePostpublication(env:Env,job:SheetsSyncJob,source:StableExpenseSource,journals:Journal[],publication:DailyPublicationAccountingEvidence):Promise<void>{
 await verifyStableExpenseProjections(env,job,source,journals,{...publication,phase:'PUBLISHED'});
}
