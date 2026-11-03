import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from './client';
import {columnName,findMonthBlocks,legacySourceWallet,resolvePayment} from './daily-expense';
import {inspectDailyAppendSnapshot} from './daily-append-preflight';
import {verifyDailyRecoveryAccounting} from './daily-recovery-accounting';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {planStableLedgerRow} from './stable-ledger-row-plan';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import type {StableExpenseSource} from './stable-expense-source';

const rawHeaders=['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID'];
const detailHeaders=['Purchase_Item_ID','Expense_ID','Document_ID','วันที่ซื้อ','บริษัท/ร้านค้า','เลขที่เอกสาร','รายการสินค้า','จำนวน','หน่วย','ราคาต่อหน่วย','ส่วนลดรายการ','จำนวนเงินรายการ','ส่วนลด/ปรับยอดระดับเอกสาร','ยอดจ่ายจริงของ Expense','หมวด','สาขา','สถานะ','Evidence ref (private)','Created_At','Updated_At / Cancelled_At'];
type Journal={entity_id:string;projection:string;sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string};

/** Verify the complete current workbook immediately before closing a staged
 * expense. Journal evidence alone cannot prove that a person did not edit an
 * earlier projection between stages. */
export async function verifyStableExpenseProjections(env:Env,job:SheetsSyncJob,source:StableExpenseSource,journals:Journal[]):Promise<void>{
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED]),initialScope=scope(),db=env.DB;
 const plan=planStableExpenseProjections(source),daily=env.SHEET_EXPENSE_DAILY,raw=env.SHEET_EXPENSE_RAW,detail=env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ';
 const names=[daily,raw,...plan.details.length?[detail]:[]];
 if(names.some(x=>!x)||new Set(names).size!==names.length)throw Error('STABLE_FINAL_SHEET_ALIAS');
 const expected=[{id:job.entityKey,projection:'DAILY',sheet:daily},{id:job.entityKey,projection:'EXPENSE_RAW',sheet:raw},...plan.details.map(x=>({id:`${job.entityKey}|${x.itemId}`,projection:'DETAIL',sheet:detail}))];
 if(journals.length!==expected.length||expected.some(e=>journals.filter(j=>j.entity_id===e.id&&j.projection===e.projection&&j.sheet_name===e.sheet&&j.source_version===job.entityVersion&&j.source_digest===source.digest&&j.state==='VERIFIED').length!==1))throw Error('STABLE_FINAL_JOURNAL');
 const grids=await Promise.all(names.map(name=>getSheetGridInfo(env,name)));
 if(grids.some(g=>g.rowCount>5000||g.columnCount>100)||grids[0]!.columnCount<25||grids[1]!.columnCount<rawHeaders.length||plan.details.length&&grids[2]!.columnCount<detailHeaders.length)throw Error('STABLE_FINAL_GRID');
 for(const e of expected){const grid=grids[names.indexOf(e.sheet)]!,j=journals.find(x=>x.entity_id===e.id&&x.projection===e.projection)!;if(j.sheet_id!==grid.sheetId)throw Error('STABLE_FINAL_GRID');}
 const ranges=names.map((name,i)=>`'${name.replace(/'/g,"''")}'!A1:${columnName(grids[i]!.columnCount)}${grids[i]!.rowCount}`);
 const formula=await batchGetSheetFormulaValues(env,ranges),effective=await batchGetSheetEffectiveSerialValues(env,[ranges[0]!]);
 const after=await Promise.all(names.map(name=>getSheetGridInfo(env,name)));
 if(formula.length!==names.length||effective.length!==1||JSON.stringify(grids)!==JSON.stringify(after)||formula.some((rows,i)=>rows.length>grids[i]!.rowCount||rows.some(row=>!Array.isArray(row)||row.length>grids[i]!.columnCount))||effective[0]!.length>grids[0]!.rowCount)throw Error('STABLE_FINAL_READ');
 const d=formula[0]!,v=effective[0]!,e=source.expense,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.transaction_date||''));if(!date)throw Error('STABLE_FINAL_DATE');
 const payment=resolvePayment(d.slice(0,3),plan.record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3])),blocks=findMonthBlocks(d).filter(b=>b.month===payment.postingMonth),key=stableDailyExpenseKey(job.entityKey),found=d.flatMap((row,i)=>row[23]===key?[i+1]:[]);
 if(blocks.length!==1||found.length!==1)throw Error('STABLE_FINAL_DAILY_ID');
 const block=blocks[0]!,row=found[0]!,data=d[row-1]||[],columns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},col=columns[payment.amountColumn];
 if(row<=block.headerRow||row>=block.totalRow||col===undefined||Number(data[1])!==payment.postingMonth||Number(data[2])!==payment.postingDay||data[3]!==plan.record.description.trim()||data[col]!==plan.record.amountBaht||data[21]!==plan.record.category||data[22]!==legacySourceWallet(plan.record.paymentKey,plan.record.sourceWallet))throw Error('STABLE_FINAL_DAILY_DATA');
 for(let n=block.headerRow+1;n<block.totalRow;n++)if((d[n-1]??[]).slice(25).some(x=>x!==null&&x!==undefined&&x!==''))throw Error('STABLE_FINAL_DAILY_EXTRA');
 const previous=Array.from({length:25},(_,i)=>data[i]??null),checked=inspectDailyAppendSnapshot({formula:d.map(x=>x.slice(0,25)),effective:v.map(x=>x.slice(0,25)),rowCount:grids[0]!.rowCount,expenseId:job.entityKey,year:payment.postingYear,month:payment.postingMonth,expectedPrevious:previous});
 if(checked.status!=='FOUND'||checked.observedRow!==row||!verifyDailyRecoveryAccounting(d,v,row,payment.postingMonth,payment.postingYear,payment.postingDay))throw Error('STABLE_FINAL_DAILY_ACCOUNTING');
 if(rawHeaders.some((h,i)=>formula[1]![0]?.[i]!==h)||planStableLedgerRow(formula[1]!,job.entityKey,plan.raw,false).status!=='PRESENT')throw Error('STABLE_FINAL_RAW');
 if(plan.details.length&&(detailHeaders.some((h,i)=>formula[2]![0]?.[i]!==h)||plan.details.some(item=>planStableLedgerRow(formula[2]!,item.itemId,item.values,false).status!=='PRESENT')))throw Error('STABLE_FINAL_DETAIL');
 if(env.DB!==db||scope()!==initialScope)throw Error('STABLE_FINAL_SCOPE_CHANGED');
}
