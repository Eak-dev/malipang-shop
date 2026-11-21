import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetGridInfo} from './client';
import {columnName,legacySourceWallet,resolvePayment} from './daily-expense';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {isAtomicDailyMarkerForRow,atomicDailyRowFormulas,ATOMIC_DAILY_PREFIX,decodeAtomicDailyPayload,encodeAtomicDailyPayload} from './atomic-daily-template';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {paymentOptionForPair} from '../expense/document';
import {stableExpensePreimageStatement} from './stable-expense-preimage';
import {readLegacyDailyCoverage,type VerifiedLegacyCoverage} from './legacy-daily-coverage';

/** Experimental test-only writer for the NEW CARRIER TEMPLATE ONLY. The
 * existing Owner Master draft has blank Y cells and different formulas: it is
 * deliberately rejected. This is not a cutover or a recovery tool. */
type Snapshot={formula:unknown[][];effective:unknown[][]};
type Payment={postingYear:number;postingMonth:number;postingDay:number;amountColumn:string};
const budget=new Set([26,27,28]);
const inputColumns=[5,6,7,10,11,12,13,14,15,16];
const columnMap:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};
const derived=new Set([0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23,24]);
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const isMoney=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.0001;
const cents=(n:number)=>Math.round(n*100);
const matchesMoney=(v:unknown,n:number)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v*100-n)<0.001;

/** A carrier is an independently verifiable identity even when someone
 * deletes X or changes an amount formula. Never infer absence from X alone. */
function validCarrierRow(f:unknown[],e:unknown[],row:number):boolean{
 const y=f[24],effective=e[24],id=e[23],parsed=decodeAtomicDailyPayload(y);
 if(parsed){
  const key=stableDailyExpenseKey(parsed.expenseId),col=columnMap[parsed.amountColumn],templates=atomicDailyRowFormulas(row);
  return effective===y&&id===key&&col!==undefined&&Object.entries(templates).every(([c,v])=>f[Number(c)]===v)&&e[0]===parsed.postingYear&&e[1]===parsed.postingMonth&&e[2]===parsed.postingDay&&e[3]===parsed.description&&e[col]===parsed.amountSatang/100&&!inputColumns.some(c=>c!==col&&!blank(e[c]))&&e[21]===parsed.category&&e[22]===parsed.wallet;
 }
 return !((typeof y==='string'&&(y.startsWith(ATOMIC_DAILY_PREFIX)||y.includes('MALIPANG_EXPENSE:')))||(typeof effective==='string'&&(effective.startsWith(ATOMIC_DAILY_PREFIX)||effective.includes('MALIPANG_EXPENSE:')))||!blank(id));
}

function checkedPayment(rows:unknown[][],key:string,year:number,month:number,day:number):Payment{
 const payment=resolvePayment(rows.slice(0,3),key,year,month,day),names:Record<string,string[]>={cash:['nonfixed'],transfer:['เงินโอน'],kbank:['kbank'],firstchoice:['firstchoice'],aeon:['aeon'],citibank:['cibitbank','citibank','citi'],ttb:['thanachart','ttb'],homepro:['homepro'],t1:['theone','the1']};
 const normalize=(x:unknown)=>String(x??'').trim().toLowerCase().replace(/[\s_\-/]+/g,''),aliases=names[normalize(key)],col=columnMap[payment.amountColumn];
 if(!aliases||col===undefined)throw Error('ATOMIC_DAILY_PAYMENT_UNVERIFIED');
 const candidates=normalize(key)==='transfer'?[rows[1]??[],rows[2]??[]]:[rows[2]??[]],matches=new Set(candidates.flatMap(row=>row.flatMap((x,i)=>{const v=normalize(x);return v&&aliases.some(a=>v===a||v.includes(a))?[i]:[]})));
 if(matches.size!==1||!matches.has(col))throw Error('ATOMIC_DAILY_PAYMENT_UNVERIFIED');
 return payment;
}

/** Verify actual effective values, not just formulas. For any month with
 * relevant transactions, exactly one numeric opening is required. This keeps
 * a missing opening from silently becoming zero. */
export function verifyAtomicDailyAccounting(snapshot:Snapshot,rowCount:number,year:number,month:number,legacy:VerifiedLegacyCoverage):boolean{
 if(!legacy||legacy.status!=='VERIFIED'||legacy.year!==year||legacy.month!==month||!Number.isSafeInteger(legacy.legacyDebitSatang)||legacy.legacyDebitSatang<0||legacy.openingSatang!==null&&(!Number.isSafeInteger(legacy.openingSatang)||legacy.openingSatang<0))return false;
 const {formula,effective}=snapshot,openings=[] as number[];
 for(let i=3;i<Math.min(243,rowCount);i++){
  const f=formula[i]??[],e=effective[i]??[];
  if(f[26]===year&&f[27]===month||e[26]===year&&e[27]===month){if(f[26]!==year||f[27]!==month||e[26]!==year||e[27]!==month||!isMoney(f[28])||e[28]!==f[28])return false;openings.push(cents(f[28]));}
 }
 if(openings.length>1||openings.length===0&&legacy.openingSatang===null)return false;
 const opening=openings.length===1?openings[0]!:legacy.openingSatang!;
 let cash=0;
 for(let i=3;i<rowCount;i++){
  const f=formula[i]??[],e=effective[i]??[],financial=inputColumns.some(c=>!blank(e[c])||!blank(f[c])&&typeof f[c]!=='string');
  // Validate every carrier, including another month and even if its amount
  // formula was altered to produce a blank effective value.
  if(!validCarrierRow(f,e,i+1))return false;
  if(!financial&&blank(e[4]))continue;
  const y=e[0],m=e[1],d=e[2];
  if(!Number.isInteger(y)||!Number.isInteger(m)||!Number.isInteger(d))return false;
  const date=new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()+1!==m||date.getUTCDate()!==d)return false;
  if(y!==year||m!==month)continue;
  if(!blank(e[4])&&!isMoney(e[4]))return false;
  if(inputColumns.some(c=>!blank(e[c])&&!isMoney(e[c])))return false;
  const helper=atomicDailyRowFormulas(i+1);
  if([8,9,17,18,20].some(c=>f[c]!==helper[c]))return false;
  const cashCols=[5,6,7],cardCols=[10,11,12,13,14,15,16],sum=(cols:number[])=>cols.reduce((a,c)=>a+(blank(e[c])?0:cents(e[c] as number)),0),thisCash=sum(cashCols),card=sum(cardCols);
  if(!Number.isSafeInteger(cash+thisCash)||!Number.isSafeInteger(opening-legacy.legacyDebitSatang-cash-thisCash))return false;
  cash+=thisCash;
  const cashPresent=cashCols.some(c=>!blank(e[c])),cardPresent=cardCols.some(c=>!blank(e[c]));
  if(cashPresent?!matchesMoney(e[8],thisCash):!blank(e[8]))return false;
  if(cardPresent?!matchesMoney(e[17],card):!blank(e[17]))return false;
  if(!matchesMoney(e[9],opening-legacy.legacyDebitSatang-cash)||!matchesMoney(e[18],opening-legacy.legacyDebitSatang-cash-card))return false;
  if(e[20]!==Math.floor((date.getTime()-Date.UTC(1899,11,30))/86400000))return false;
 }
 return true;
}

function snapshotUnchangedExceptTarget(before:Snapshot,after:Snapshot,rowCount:number,columnCount:number,target:number):boolean{
 for(let r=0;r<rowCount;r++)for(let c=0;c<columnCount;c++){
  if(r===target-1&&c===24)continue;
  if(!same(before.formula[r]?.[c],after.formula[r]?.[c]))return false;
  if(r===target-1&&derived.has(c))continue;
  if(!same(before.effective[r]?.[c],after.effective[r]?.[c]))return false;
 }
 return true;
}

/** Pure provider readback plus the reservation evidence for an already
 * VERIFIED carrier. This function cannot write or create a projection. */
export async function verifyAtomicDailyFinalSnapshot(env:Env,job:SheetsSyncJob,source:StableExpenseSource,sheetName:string,sheetId:number,rowCount:number,columnCount:number,snapshot:Snapshot,journal:{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string;operation_token?:string},legacy:VerifiedLegacyCoverage):Promise<void>{
 if(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==sheetId||journal.sheet_name!==sheetName||!journal.operation_token||rowCount<4||rowCount>5000||columnCount<29||columnCount>100||snapshot.formula.length>rowCount||snapshot.effective.length>rowCount)throw Error('ATOMIC_FINAL_JOURNAL_UNVERIFIED');
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);
 if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('ATOMIC_FINAL_SOURCE_UNVERIFIED');
 const payment=checkedPayment(snapshot.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet)});
 if(!verifyAtomicDailyAccounting(snapshot,rowCount,payment.postingYear,payment.postingMonth,legacy))throw Error('ATOMIC_FINAL_ACCOUNTING_UNVERIFIED');
 const key=stableDailyExpenseKey(job.entityKey),ids=new Set<string>(),nonces=new Set<string>();let found=0;
 for(let i=3;i<rowCount;i++){
  const f=snapshot.formula[i]??[],e=snapshot.effective[i]??[],y=f[24],candidate=decodeAtomicDailyPayload(y);
  if(i>=243&&[26,27,28].some(c=>!blank(f[c])))throw Error('ATOMIC_FINAL_BUDGET_OUTSIDE_RANGE');
  if(!validCarrierRow(f,e,i+1))throw Error('ATOMIC_FINAL_CARRIER_UNVERIFIED');
  if(typeof y==='string'&&y.startsWith('MPD1_EMPTY_')){
   if(!isAtomicDailyMarkerForRow(y,i+1)||e[24]!==y)throw Error('ATOMIC_FINAL_MARKER_UNVERIFIED');
   const nonce=y.slice(-32);if(nonces.has(nonce))throw Error('ATOMIC_FINAL_MARKER_UNVERIFIED');nonces.add(nonce);
  }
  if(candidate){const id=stableDailyExpenseKey(candidate.expenseId);if(ids.has(id))throw Error('ATOMIC_FINAL_DUPLICATE_ID');ids.add(id);if(id===key)found=i+1;}
 }
 if(!found)throw Error('ATOMIC_FINAL_ID_UNVERIFIED');
 const f=snapshot.formula[found-1]??[],e=snapshot.effective[found-1]??[],col=columnMap[payment.amountColumn]!;
 if(f[24]!==payload||e[24]!==payload||e[23]!==key||e[0]!==payment.postingYear||e[1]!==payment.postingMonth||e[2]!==payment.postingDay||e[3]!==record.description.trim()||e[col]!==Number(source.expense.amount_satang)/100||inputColumns.some(c=>c!==col&&!blank(e[c]))||e[21]!==record.category.trim()||e[22]!==legacySourceWallet(record.paymentKey,record.sourceWallet)||!blank(e[4])||!Object.entries(atomicDailyRowFormulas(found)).every(([c,v])=>f[Number(c)]===v))throw Error('ATOMIC_FINAL_ROW_UNVERIFIED');
 const marker=await env.DB.prepare("SELECT 1 AS ok FROM atomic_daily_marker_reservations WHERE spreadsheet_id=? AND sheet_id=? AND entity_id=? AND source_version=? AND operation_token=? LIMIT 1").bind(env.GOOGLE_SPREADSHEET_ID,sheetId,job.entityKey,job.entityVersion,journal.operation_token).first<{ok:number}>();
 if(marker?.ok!==1)throw Error('ATOMIC_FINAL_RESERVATION_UNVERIFIED');
}

/** One provider-side conditional mutation of column Y. Never retries an
 * ambiguous dispatch. A human can still restore a prior marker while the
 * original provider request is in flight: the D1 marker ledger does not
 * fence that external undo or prove that the provider request has settled.
 * Retain workbook REVIEW on every uncertain outcome and do not release it
 * until provider settlement and external-writer control are evidenced.
 * Only call while withStableWorkbookClaim owns `claim`. The opt-in runtime
 * route rejects Production until cutover and cancellation are resolved. */
export async function writeAtomicDailyCellUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource,sheetName:string,expectedSheetId:number):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,others=()=>[env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean),scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,...others(),env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]),initialScope=scope(),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!book||!lease||!claim||!sheetName||!Number.isSafeInteger(expectedSheetId)||expectedSheetId<0||others().includes(sheetName))throw Error('ATOMIC_DAILY_TARGET_INVALID');
 const stable=()=>env.DB===db&&scope()===initialScope&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const sourceMatches=async()=>{const now=await readStableExpenseSource(env,job,lease,claim);return !!now&&stable()&&now.revision===source.revision&&now.digest===source.digest&&now.fingerprint===source.fingerprint&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date)throw Error('ATOMIC_DAILY_DATE');
 if(!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('ATOMIC_DAILY_PAYMENT_UNVERIFIED');
 const grid=await getSheetGridInfo(env,sheetName);if(!stable()||grid.sheetId!==expectedSheetId||grid.rowCount>5000||grid.columnCount<29||grid.columnCount>100)throw Error('ATOMIC_DAILY_GRID');
 const sameGrid=async()=>{const g=await getSheetGridInfo(env,sheetName);return stable()&&JSON.stringify(g)===JSON.stringify(grid);};
 const range=`'${sheetName.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const snapshot=async():Promise<Snapshot>=>{if(!await sameGrid())throw Error('ATOMIC_DAILY_GRID_CHANGED');const f=await batchGetSheetFormulaValues(env,[range]),e=await batchGetSheetEffectiveSerialValues(env,[range]);if(f.length!==1||e.length!==1||[...f[0]!,...e[0]!].some(r=>!Array.isArray(r)||r.length>grid.columnCount)||f[0]!.length>grid.rowCount||e[0]!.length>grid.rowCount||!await sameGrid())throw Error('ATOMIC_DAILY_READ_UNVERIFIED');return{formula:f[0]!,effective:e[0]!};};
 const before=await snapshot(),payment=checkedPayment(before.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 const legacy=await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheetName);
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet)}),key=stableDailyExpenseKey(job.entityKey);
 if(!verifyAtomicDailyAccounting(before,grid.rowCount,payment.postingYear,payment.postingMonth,legacy.coverage))throw Error('ATOMIC_DAILY_ACCOUNTING_UNVERIFIED');
 const journal=await db.prepare("SELECT state,source_version,source_digest,sheet_id,sheet_name,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY'").bind(book,job.entityKey).first<{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string;operation_token:string}>();
 const ids=new Set<string>(),markerNonces=new Set<string>();let found=0,lastUsed=3;
 for(let i=3;i<grid.rowCount;i++){
  const f=before.formula[i]??[],e=before.effective[i]??[];
  if(i>=243&&[26,27,28].some(c=>!blank(f[c])))throw Error('ATOMIC_DAILY_BUDGET_OUTSIDE_RANGE');
  const y=f[24],templates=atomicDailyRowFormulas(i+1);
  const formulasValid=Object.entries(templates).every(([c,v])=>f[Number(c)]===v),manualCellsBlank=Array.from({length:grid.columnCount},(_,c)=>c).every(c=>budget.has(c)||c===24||Object.hasOwn(templates,c)||blank(f[c]));
  // X is a formula and can be deleted or changed by a collaborator. Scan Y
  // independently so an orphaned or malformed carrier is never mistaken for
  // a fresh expense merely because its displayed ID disappeared.
  const candidate=decodeAtomicDailyPayload(y);
  if(!validCarrierRow(f,e,i+1))throw Error('ATOMIC_DAILY_CARRIER_UNVERIFIED');
  if(typeof y==='string'&&y.startsWith('MPD1_EMPTY_')){
   if(!isAtomicDailyMarkerForRow(y,i+1)||e[24]!==y)throw Error('ATOMIC_DAILY_MARKER_CORRUPT');
   const nonce=y.slice(-32);if(markerNonces.has(nonce))throw Error('ATOMIC_DAILY_MARKER_DUPLICATE');markerNonces.add(nonce);
  }
  if(candidate){const id=stableDailyExpenseKey(candidate.expenseId);if(ids.has(id))throw Error('ATOMIC_DAILY_DUPLICATE_ID');ids.add(id);if(id===key)found=i+1;}
  if(blank(y)&&formulasValid&&manualCellsBlank)throw Error('ATOMIC_DAILY_MARKER_MISSING');
  const cleanMarker=isAtomicDailyMarkerForRow(y,i+1)&&e[24]===y&&formulasValid&&manualCellsBlank;
  if(!cleanMarker)lastUsed=i+1;
 }
 if(found){
  const row=before.formula[found-1]??[],values=before.effective[found-1]??[],col=columnMap[payment.amountColumn]!,template=atomicDailyRowFormulas(found);
  if(!journal||journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==grid.sheetId||journal.sheet_name!==sheetName||row[24]!==payload||values[24]!==payload||values[23]!==key||values[0]!==payment.postingYear||values[1]!==payment.postingMonth||values[2]!==payment.postingDay||values[3]!==record.description.trim()||values[col]!==Number(source.expense.amount_satang)/100||inputColumns.some(c=>c!==col&&!blank(values[c]))||values[21]!==record.category.trim()||values[22]!==legacySourceWallet(record.paymentKey,record.sourceWallet)||!blank(values[4])||!Object.entries(template).every(([c,v])=>row[Number(c)]===v)||!await sourceMatches())throw Error('ATOMIC_DAILY_IDENTITY_REVIEW');
  const priorMarker=await db.prepare("SELECT 1 AS ok FROM atomic_daily_marker_reservations WHERE spreadsheet_id=? AND sheet_id=? AND entity_id=? AND source_version=? AND operation_token=? LIMIT 1").bind(book,grid.sheetId,job.entityKey,job.entityVersion,journal.operation_token).first<{ok:number}>();
  if(priorMarker?.ok!==1||!stable())throw Error('ATOMIC_DAILY_PRIOR_MARKER_UNVERIFIED');
  return;
 }
 if(journal)throw Error('ATOMIC_DAILY_PRIOR_INTENT');
 const row=lastUsed+1;if(row>grid.rowCount)throw Error('ATOMIC_DAILY_CAPACITY');
 const target=before.formula[row-1]??[],template=atomicDailyRowFormulas(row),marker=target[24];
 if(!isAtomicDailyMarkerForRow(marker,row)||before.effective[row-1]?.[24]!==marker||!Object.entries(template).every(([c,v])=>target[Number(c)]===v)||Array.from({length:grid.columnCount},(_,c)=>c).some(c=>!budget.has(c)&&c!==24&&!Object.hasOwn(template,c)&&!blank(target[c])))throw Error('ATOMIC_DAILY_ROW_UNVERIFIED');
 if(!await sourceMatches())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');
 const guard=`${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
 const args=[source.revision,book,claim,job.entityKey,job.entityVersion,job.entityKey,lease];
 const markerIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace'))=3";
 // The immutable ledger prevents a *new Worker dispatch* from reserving a
 // marker again. It cannot cancel an earlier in-flight provider request if a
 // collaborator restores the marker. Both D1 records commit or neither does.
 const reservations=await db.batch([
  db.prepare(`INSERT INTO atomic_daily_marker_reservations(spreadsheet_id,sheet_id,marker,entity_id,source_version,operation_token,created_at) SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${markerIntegrity} AND ${guard} AND NOT EXISTS(SELECT 1 FROM atomic_daily_marker_reservations r WHERE r.spreadsheet_id=? AND r.sheet_id=? AND r.marker=?)`).bind(book,grid.sheetId,marker,job.entityKey,job.entityVersion,claim,...args,book,grid.sheetId,marker),
  db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${markerIntegrity} AND ${guard} AND EXISTS(SELECT 1 FROM atomic_daily_marker_reservations r WHERE r.spreadsheet_id=? AND r.sheet_id=? AND r.marker=? AND r.entity_id=? AND r.source_version=? AND r.operation_token=?)`).bind(book,job.entityKey,grid.sheetId,sheetName,job.entityVersion,source.digest,claim,...args,book,grid.sheetId,marker,job.entityKey,job.entityVersion,claim),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||reservations.length!==3||reservations.some(x=>x.success!==true)||Number(reservations[0]!.meta?.changes)!==1||Number(reservations[1]!.meta?.changes)!==1)throw Error('ATOMIC_DAILY_RESERVATION_UNCERTAIN');
 // `sheetsFetch` awaits this callback before invoking fetch. Only this exact
 // locally-created error proves that this invocation never dispatched its
 // mutation. A timeout, malformed response, or any other error stays
 // IN_FLIGHT because the provider outcome may be unknown.
 let preDispatchChanged:Error|undefined,reply:unknown;
 try{
  reply=await batchUpdateSpreadsheetWithReply(env,[{findReplace:{range:{sheetId:grid.sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:24,endColumnIndex:25},find:marker,replacement:payload,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}}],async()=>{
   if(!await sourceMatches())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');const fresh=await snapshot();
   if(JSON.stringify(fresh)!==JSON.stringify(before)||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheetName))!==JSON.stringify(legacy)){
    if(!await sourceMatches())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');
    preDispatchChanged=Error('ATOMIC_DAILY_PRE_DISPATCH_SHEET_CHANGED');throw preDispatchChanged;
   }
   if(!await sourceMatches())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');
  });
 }catch(error){
  if(error===preDispatchChanged&&preDispatchChanged&&stable()){
   // Keep the immutable marker reservation, and retain the workbook claim for
   // review: the observed change could be an external writer still running.
   // If this guarded state update cannot be proven, leave IN_FLIGHT intact.
   try{
    await db.prepare(`UPDATE stable_projection_writes SET state='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${markerIntegrity} AND ${guard} AND EXISTS(SELECT 1 FROM atomic_daily_marker_reservations r WHERE r.spreadsheet_id=? AND r.sheet_id=? AND r.marker=? AND r.entity_id=? AND r.source_version=? AND r.operation_token=?)`).bind(book,job.entityKey,grid.sheetId,sheetName,job.entityVersion,source.digest,claim,...args,book,grid.sheetId,marker,job.entityKey,job.entityVersion,claim).run();
   }catch{/* Outer claim remains REVIEW; uncertain D1 state is not released. */}
  }
  throw error;
 }
 const out=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined,changed=out?.[0]?.findReplace;
 if(!Array.isArray(out)||out.length!==1||!changed||changed.valuesChanged!==1||changed.occurrencesChanged!==1||Number(changed.formulasChanged??0)!==0)throw Error('ATOMIC_DAILY_CONDITIONAL_UNCERTAIN');
 const after=await snapshot(),data=after.formula[row-1]??[],values=after.effective[row-1]??[],col=columnMap[payment.amountColumn]!;
 if(!snapshotUnchangedExceptTarget(before,after,grid.rowCount,grid.columnCount,row)||data[24]!==payload||values[24]!==payload||values[23]!==key||values[0]!==payment.postingYear||values[1]!==payment.postingMonth||values[2]!==payment.postingDay||values[3]!==record.description.trim()||values[col]!==Number(source.expense.amount_satang)/100||inputColumns.some(c=>c!==col&&!blank(values[c]))||values[21]!==record.category.trim()||values[22]!==legacySourceWallet(record.paymentKey,record.sourceWallet)||!blank(values[4])||!Object.entries(template).every(([c,v])=>data[Number(c)]===v)||!verifyAtomicDailyAccounting(after,grid.rowCount,payment.postingYear,payment.postingMonth,legacy.coverage)||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheetName))!==JSON.stringify(legacy)||!await sourceMatches())throw Error('ATOMIC_DAILY_READBACK_UNCERTAIN');
 const verified=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guard}`).bind(book,job.entityKey,grid.sheetId,sheetName,job.entityVersion,source.digest,claim,...args);
 const preimage=await stableExpensePreimageStatement(env,{book,entity:job.entityKey,projection:'DAILY',sheetId:grid.sheetId,sheetName,version:job.entityVersion,sourceDigest:source.digest,row:data,width:grid.columnCount});
 if(!stable())throw Error('ATOMIC_DAILY_SOURCE_CHANGED');
 // Commit verification and preimage in the same transaction, so a crash or
 // stale lease cannot leave a verified projection without required evidence.
 const results=preimage?await db.batch([verified,preimage]):[await verified.run()];
 if(results.length!==(preimage?2:1)||results.some(result=>result.success!==true||Number(result.meta?.changes)!==1))throw Error('ATOMIC_DAILY_VERIFICATION_UNCERTAIN');
}
