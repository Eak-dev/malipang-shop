import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {sha256Hex} from "../shared/ids";
import {isIsoDate} from "../shared/time";
import {batchGetSheetFormulaValues,batchGetSheetSerialValues,getSheetId,getSheetRowMetadataById,type SheetRowMetadata} from "./client";
import {legacySourceWallet,resolvePayment} from "./daily-expense";
import {matchesOwnerCorrectionIdentity} from "./owner-correction-identity";

// The formulas were read from the private report test copy. Any drift fails closed.
const formulaDigest="5aa6fbf7b33d26783d2ff0fc58fa385131bc110f5b961416a08d9fe4afb3d203";
const flowFormulaDigest="7477383cebb25e383af88b6bb10564bbde0c79a1c898baccf8acc83c588b445f";
const formulaRanges=["'04_OWNER_MONTH_CLOSE'!B12","'04_OWNER_MONTH_CLOSE'!C24:C35","'04_OWNER_MONTH_CLOSE'!L14","'97_EXPENSE_CLEAN'!A2","'35_EXPENSE_FLOW_CHECK'!A2","'35_EXPENSE_FLOW_CHECK'!A5","'35_EXPENSE_FLOW_CHECK'!B5:G65","'รายวัน'!A:W"];
const valueRanges=["'04_OWNER_MONTH_CLOSE'!C2","'04_OWNER_MONTH_CLOSE'!B12","'04_OWNER_MONTH_CLOSE'!C24:C35","'04_OWNER_MONTH_CLOSE'!L14","'97_EXPENSE_CLEAN'!A2:H4500","'V52_EXPENSE_RAW'!A2:Q","'รายละเอียดการซื้อ'!A2:Q","'35_EXPENSE_FLOW_CHECK'!A2","'35_EXPENSE_FLOW_CHECK'!A5:G65","'รายวัน'!A:W"];
interface Ports{formulas:typeof batchGetSheetFormulaValues;values:typeof batchGetSheetSerialValues;digest:(value:unknown)=>Promise<string>;metadata:(env:Env,id:number)=>Promise<SheetRowMetadata|null>;sheetId:(env:Env,name:string)=>Promise<number>}
interface FlowRow{date:string;dailyAmount:number|null;cleanAmount:number|null;difference:number|null;status:string;dailyCount:number|null;cleanCount:number|null}
export interface CorrectionReportSnapshot{month:string;expenseId:string;date:string;postingDate:string;description:string;amountSatang:number;wallet:string;category:string;total:number;categories:number[];bankTotal:number;otherRowsDigest:string;targetEvidenceDigest:string;formulaDigest:string;flowFormulaDigest:string;flowAlert:string;flow:FlowRow[]}
const money=(n:unknown)=>typeof n==="number"&&Number.isFinite(n)?n:null;
const digest=(v:unknown)=>sha256Hex(new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer);
const defaults:Ports={formulas:batchGetSheetFormulaValues,values:batchGetSheetSerialValues,digest,metadata:getSheetRowMetadataById,sheetId:getSheetId};
function day(value:unknown):string|null{
  if(typeof value==="string")return isIsoDate(value)?value:null;
  if(typeof value!=="number"||!Number.isFinite(value))return null;const n=Math.floor(value);if(n<1||n>100000)return null;
  const result=new Date(Date.UTC(1899,11,30)+n*86400000).toISOString().slice(0,10);return isIsoDate(result)?result:null;
}

/** Capture stable report evidence for a modern expense with at most one verifiable detail row. */
export async function captureOwnerCorrectionReport(env:Env,snapshot:OwnerCorrectionSnapshot,dailyMetadataId:number,ports:Ports=defaults):Promise<CorrectionReportSnapshot|null>{
  if(env.SHEET_EXPENSE_DAILY!=="รายวัน"||env.SHEET_EXPENSE_RAW!=="V52_EXPENSE_RAW"||(env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ")!=="รายละเอียดการซื้อ"||!snapshot.expenseId||snapshot.status!=="CONFIRMED"||!Number.isSafeInteger(snapshot.amountSatang)||snapshot.amountSatang<=0||!Number.isSafeInteger(dailyMetadataId)||dailyMetadataId<1||!isIsoDate(snapshot.transactionDate)||snapshot.transactionDate<"2026-09-01")return null;
  const read=async()=>Promise.all([ports.formulas(env,formulaRanges),ports.values(env,valueRanges),ports.metadata(env,dailyMetadataId),ports.sheetId(env,env.SHEET_EXPENSE_DAILY)]),first=await read(),second=await read();
  if(JSON.stringify(first)!==JSON.stringify(second))return null;
  const [formulaValues,values,metadata,dailySheetId]=first;if(formulaValues.length!==8||values.length!==10||!metadata||metadata.metadataId!==dailyMetadataId||metadata.metadataKey!=="malipang_expense_daily"||metadata.metadataValue!==snapshot.expenseId||metadata.sheetId!==dailySheetId)return null;
  const formulas=formulaValues.slice(0,4).flatMap(rows=>rows.map(row=>row[0])),flowFormulas=formulaValues.slice(4,7).flatMap(rows=>rows.flatMap(row=>row)),dailyFormulas=formulaValues[7]||[];
  if(formulas.length!==15||formulas.some(value=>typeof value!=="string")||formulas.some(value=>(value as string).includes(snapshot.expenseId))||await ports.digest(formulas)!==formulaDigest)return null;
  if(flowFormulas.length!==368||flowFormulas.some(value=>typeof value!=="string")||await ports.digest(flowFormulas)!==flowFormulaDigest)return null;
  const selected=day(values[0]?.[0]?.[0]),total=money(values[1]?.[0]?.[0]),categories=(values[2]||[]).map(row=>money(row[0])),bankTotal=money(values[3]?.[0]?.[0]);
  if(!selected||selected.slice(0,7)!==snapshot.transactionDate.slice(0,7)||total===null||bankTotal===null||categories.length!==12||categories.some(value=>value===null))return null;
  const clean=values[4]||[],raw=values[5]||[],details=values[6]||[],flowValues=values[8]||[],daily=values[9]||[],matchingClean=clean.filter(row=>row[1]===snapshot.expenseId),matchingRaw=raw.filter(row=>row[0]===snapshot.expenseId),matchingDetails=details.filter(row=>row[1]===snapshot.expenseId);
  if(matchingClean.length!==1||matchingRaw.length!==1||matchingDetails.length>1)return null;
  if(matchingDetails.length===1){const item=matchingDetails[0]!,line=money(item[11]);if(typeof item[0]!=="string"||!item[0]||details.filter(value=>value[0]===item[0]).length!==1||line===null||line<=0||item[13]!==snapshot.amountSatang/100||item[14]!==snapshot.category||item[16]!=="CONFIRMED")return null;}
  const c=matchingClean[0]!,r=matchingRaw[0]!;
  if(day(c[0])!==snapshot.transactionDate||c[2]!==snapshot.description||c[3]!==snapshot.amountSatang/100||c[4]!==snapshot.sourceWallet||c[5]!==snapshot.category||c[6]!=="V52_CONFIRMED"||day(r[1])!==snapshot.transactionDate||r[2]!==snapshot.description||r[3]!==snapshot.amountSatang/100||r[4]!==snapshot.paymentKey||r[5]!==snapshot.sourceWallet||r[6]!==snapshot.category||r[7]!=="CONFIRMED")return null;
  const [year,month,dayOfMonth]=snapshot.transactionDate.split("-").map(Number);let posting:ReturnType<typeof resolvePayment>;try{posting=resolvePayment(daily.slice(0,3),snapshot.paymentKey,year!,month!,dayOfMonth!);}catch{return null;}
  const postingDate=`${String(posting.postingYear).padStart(4,"0")}-${String(posting.postingMonth).padStart(2,"0")}-${String(posting.postingDay).padStart(2,"0")}`;
  let col=0;for(const char of posting.amountColumn)col=col*26+char.charCodeAt(0)-64;
  const row=daily[metadata.rowIndex],identity={expenseId:snapshot.expenseId,description:snapshot.description,amountSatang:snapshot.amountSatang,postingYear:posting.postingYear,postingMonth:posting.postingMonth,postingDay:posting.postingDay,amountColumn:col-1};
  if(!row||Number(daily[4]?.[0])!==posting.postingYear||!matchesOwnerCorrectionIdentity(identity,{rowNumber:metadata.rowIndex+1,sheetYear:posting.postingYear,values:row})||row[21]!==snapshot.category||row[22]!==legacySourceWallet(snapshot.paymentKey,snapshot.sourceWallet)||day(row[20])!==postingDate||money(row[8])===null||money(row[17])===null||!close(Number(row[8])+Number(row[17]),snapshot.amountSatang/100))return null;
  if(daily.filter((candidate,index)=>matchesOwnerCorrectionIdentity(identity,{rowNumber:index+1,sheetYear:posting.postingYear,values:candidate})).length!==1)return null;
  const flowAlert=values[7]?.[0]?.[0];if(typeof flowAlert!=="string"||flowValues.length!==61)return null;
  const flow:FlowRow[]=[];for(const [index,entry] of flowValues.entries()){const date=day(entry[0]),expectedDate=new Date(Date.UTC(2026,10,1)+index*86400000).toISOString().slice(0,10);if(date!==expectedDate)return null;flow.push({date,dailyAmount:money(entry[1]),cleanAmount:money(entry[2]),difference:money(entry[3]),status:typeof entry[4]==="string"?entry[4]:"",dailyCount:money(entry[5]),cleanCount:money(entry[6])});}
  if(new Set(flow.map(entry=>entry.date)).size!==61)return null;
  // Keep other people's inputs and every formula unchanged, but do not hash
  // calculated results as inputs: a valid amount edit recalculates totals.
  const otherDaily=Array.from({length:Math.max(daily.length,dailyFormulas.length)},(_,index)=>({item:daily[index]||[],index})).filter(({index})=>index!==metadata.rowIndex).map(({item,index})=>{
    const rowFormulas=dailyFormulas[index]||[],length=Math.max(item.length,rowFormulas.length);
    return Array.from({length},(_,col)=>typeof rowFormulas[col]==="string"&&(rowFormulas[col] as string).startsWith("=")?["FORMULA",rowFormulas[col]]:["VALUE",item[col]??null]);
  });
  const otherRowsDigest=await ports.digest([clean.filter(item=>item[1]!==snapshot.expenseId),raw.filter(item=>item[0]!==snapshot.expenseId),details.filter(item=>item[1]!==snapshot.expenseId),otherDaily]);
  // Keep document/order identity and receipt facts immutable while allowing
  // the explicitly reviewed raw fields and summary projections to change.
  const targetEvidenceDigest=await ports.digest([[0,7,8,9,10,11,12,13,14,15,16].map(index=>r[index]??null),matchingDetails.map(item=>[0,1,2,4,5,6,7,8,9,10,11,16].map(index=>item[index]??null))]);
  return {month:selected.slice(0,7),expenseId:snapshot.expenseId,date:snapshot.transactionDate,postingDate,description:snapshot.description,amountSatang:snapshot.amountSatang,wallet:snapshot.sourceWallet,category:snapshot.category,total,categories:categories as number[],bankTotal,otherRowsDigest,targetEvidenceDigest,formulaDigest,flowFormulaDigest,flowAlert,flow};
}

const groups:Record<string,number>={rent:0,staff:1,ingredients:2,fillings:3,packaging:4,utilities:5,gas:6,transport:7,equipment:8,marketing:9,general:10,bank_fee:10};
const close=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<0.005;
/** A mismatch is held for review; this verifier never tries to repair the report. */
export function ownerCorrectionReportMatches(before:CorrectionReportSnapshot,after:CorrectionReportSnapshot):boolean{
  if(!before||!after||!before.expenseId||before.expenseId!==after.expenseId||before.month!==after.month||before.formulaDigest!==formulaDigest||after.formulaDigest!==formulaDigest||before.flowFormulaDigest!==flowFormulaDigest||after.flowFormulaDigest!==flowFormulaDigest||before.flowAlert!==after.flowAlert||!(/^[0-9a-f]{64}$/.test(before.otherRowsDigest))||before.otherRowsDigest!==after.otherRowsDigest||!(/^[0-9a-f]{64}$/.test(before.targetEvidenceDigest))||before.targetEvidenceDigest!==after.targetEvidenceDigest||!isIsoDate(before.date)||!isIsoDate(after.date)||!isIsoDate(before.postingDate)||!isIsoDate(after.postingDate)||before.date.slice(0,7)!==before.month||after.date.slice(0,7)!==after.month||!Number.isSafeInteger(before.amountSatang)||before.amountSatang<=0||!Number.isSafeInteger(after.amountSatang)||after.amountSatang<=0||!Array.isArray(before.categories)||!Array.isArray(after.categories)||before.categories.length!==12||after.categories.length!==12||!Array.isArray(before.flow)||!Array.isArray(after.flow)||before.flow.length!==61||after.flow.length!==61)return false;
  const oldGroup=groups[before.category],newGroup=groups[after.category];if(oldGroup===undefined||newGroup===undefined)return false;
  const oldAmount=before.amountSatang/100,newAmount=after.amountSatang/100;
  if(!close(after.total-before.total,newAmount-oldAmount))return false;
  for(let i=0;i<12;i++){const expected=(i===newGroup?newAmount:0)-(i===oldGroup?oldAmount:0);if(!close(after.categories[i]!-before.categories[i]!,expected))return false;}
  if(!close(after.bankTotal-before.bankTotal,(after.wallet==="SHOP_BANK"?newAmount:0)-(before.wallet==="SHOP_BANK"?oldAmount:0)))return false;
  for(let i=0;i<61;i++){
    const a=before.flow[i]!,b=after.flow[i]!;if(!a||!b||a.date!==b.date||!isIsoDate(a.date))return false;
    const dailyDelta=(b.date===after.postingDate?newAmount:0)-(a.date===before.postingDate?oldAmount:0),cleanDelta=(b.date===after.date?newAmount:0)-(a.date===before.date?oldAmount:0),dailyCount=(b.date===after.postingDate?1:0)-(a.date===before.postingDate?1:0),cleanCount=(b.date===after.date?1:0)-(a.date===before.date?1:0);
    if(a.dailyAmount===null||a.cleanAmount===null||a.dailyCount===null||a.cleanCount===null||b.dailyAmount===null||b.cleanAmount===null||b.dailyCount===null||b.cleanCount===null){if(dailyDelta||cleanDelta||dailyCount||cleanCount||JSON.stringify(a)!==JSON.stringify(b))return false;continue;}
    if(!close(b.dailyAmount-a.dailyAmount,dailyDelta)||!close(b.cleanAmount-a.cleanAmount,cleanDelta)||b.dailyCount-a.dailyCount!==dailyCount||b.cleanCount-a.cleanCount!==cleanCount)return false;
    if(a.difference===null||b.difference===null||Math.abs(a.difference-(a.dailyAmount-a.cleanAmount))>0.0051||Math.abs(b.difference-(b.dailyAmount-b.cleanAmount))>0.0051)return false;
    const status=(row:FlowRow)=>row.dailyCount===0&&row.cleanCount===0?"ยังไม่พบรายการ / ยังไม่ยืนยัน":Math.abs(row.difference!)>0.005?"ยอดไม่ตรง — ตรวจรายการ":row.dailyCount!==row.cleanCount?"ยอดรวมตรง จำนวนแถวต่าง — ตรวจ":"ยอดรวมตรง — ยังต้องตรวจรายการ";
    if(a.status!==status(a)||b.status!==status(b))return false;
  }
  return true;
}
