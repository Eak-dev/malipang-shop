import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetCellNumberFormats,getSheetGridInfo,SheetsHttpError} from './client';
import {OperationTimeoutError} from '../shared/async';
import {GoogleOAuthHttpError,GoogleOAuthPreflightError} from './google-auth';
import {columnName,legacySourceWallet,resolvePayment} from './daily-expense';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import {appendDailyRowFormulas,insertContinuousDailyRowRequests} from './append-daily-template';
import {decodeAtomicDailyPayload,encodeAtomicDailyPayload} from './atomic-daily-template';
import {verifyMixedDailyAccounting} from './mixed-daily-accounting';
import {readLegacyDailyCoverage,type VerifiedLegacyCoverage} from './legacy-daily-coverage';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {stableExpensePreimageStatement} from './stable-expense-preimage';
import {paymentOptionForPair} from '../expense/document';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {pendingDailyCancellations,verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {readContinuousReportHealth} from './continuous-report-health';

type Snapshot={formula:unknown[][];effective:unknown[][]};
type Grid={sheetId:number;rowCount:number;columnCount:number};
const helper=new Set([8,9,17,18,20]);
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const amountCols:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};
export class InsertDailyPendingCancellationError extends Error{
 constructor(readonly pendingEntityId:string){super('INSERT_DAILY_PENDING_CANCELLATION');this.name='InsertDailyPendingCancellationError';}
}
/** Only raised before any intent/provider dispatch for this expense. */
export class InsertDailyDefiniteFailure extends Error{
 constructor(readonly reason:'CAPACITY'|'MONTH_OPENING'|'ROW_FORMULA'|'LEGACY_COVERAGE'){super(`INSERT_DAILY_${reason}`);this.name='InsertDailyDefiniteFailure';}
}
/** Only before any provider mutation or intent for this expense. */
export class InsertDailyPreflightReviewError extends Error{
 constructor(readonly reason:string){super(`INSERT_DAILY_PREFLIGHT_${reason}`);this.name='InsertDailyPreflightReviewError';}
}
/** Wrap only provider reads before this expense reserves any write intent.
 * Do not wrap the later pre-dispatch callback or readback: those occur after
 * reservation and their uncertain state must remain fenced. */
async function beforeIntentRead<T>(read:()=>Promise<T>):Promise<T>{
 try{return await read();}catch(error){
  if(error instanceof SheetsHttpError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)throw new InsertDailyPreflightReviewError(`SHEETS_READ_HTTP_${error.status}`);
  if(error instanceof GoogleOAuthHttpError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)throw new InsertDailyPreflightReviewError(`GOOGLE_OAUTH_HTTP_${error.status}`);
  if(error instanceof GoogleOAuthPreflightError)throw new InsertDailyPreflightReviewError(error.code);
  if(error instanceof OperationTimeoutError&&/^Google OAuth timed out after \d+ms$/.test(error.message))throw new InsertDailyPreflightReviewError('GOOGLE_OAUTH_TIMEOUT');
  if(error instanceof OperationTimeoutError)throw new InsertDailyPreflightReviewError('SHEETS_READ_TIMEOUT');
  throw error;
 }
}
async function verifyInsertedNumberFormats(env:Env,sheet:string,sheetId:number,row:number):Promise<boolean>{
 const formats=await getSheetCellNumberFormats(env,sheet,sheetId,row);
 return formats.length===17&&formats.slice(0,15).every(f=>f?.type==='NUMBER'&&f.pattern==='#,##0.00')&&formats[16]?.type==='DATE'&&formats[16]?.pattern==='dd/MM/yyyy';
}

export function verifiedInsertDailyPayment(rows:unknown[][],key:string,year:number,month:number,day:number):ReturnType<typeof resolvePayment>{
 const payment=resolvePayment(rows.slice(0,3),key,year,month,day),amountColumn=amountCols[payment.amountColumn];
 const names:Record<string,string[]>={cash:['nonfixed'],transfer:['เงินโอน'],kbank:['kbank'],firstchoice:['firstchoice'],aeon:['aeon'],citibank:['cibitbank','citibank','citi'],ttb:['thanachart','ttb'],homepro:['homepro'],t1:['theone','the1']};
 const normalize=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/[\s_\-/]+/g,''),k=normalize(key),aliases=names[k];
 const headers=k==='transfer'?[rows[1]??[],rows[2]??[]]:[rows[2]??[]],matches=new Set(headers.flatMap(r=>r.flatMap((v,i)=>{const x=normalize(v);return x&&aliases?.some(a=>x===a||x.includes(a))?[i]:[]})));
 if(amountColumn===undefined||!aliases||matches.size!==1||!matches.has(amountColumn))throw Error('INSERT_DAILY_PAYMENT_UNVERIFIED');return payment;
}

/** Read-only final verification for a previously VERIFIED inserted carrier. */
export async function verifyInsertedDailyFinalSnapshot(env:Env,job:SheetsSyncJob,source:StableExpenseSource,sheet:string,sheetId:number,grid:Grid,snapshot:Snapshot,journal:{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string;operation_token?:string},legacy:VerifiedLegacyCoverage):Promise<void>{
 if(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==sheetId||journal.sheet_name!==sheet||!journal.operation_token||grid.sheetId!==sheetId)throw Error('INSERT_DAILY_FINAL_JOURNAL');
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('INSERT_DAILY_FINAL_SOURCE');
 const payment=verifiedInsertDailyPayment(snapshot.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet)});
 if(!verifyMixedDailyAccounting(snapshot,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy)||!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,snapshot.formula))throw Error('INSERT_DAILY_FINAL_ACCOUNTING');
 const found=snapshot.formula.flatMap((row,i)=>decodeAtomicDailyPayload(row[24])?.expenseId===job.entityKey?[i]:[]);
 if(found.length!==1||snapshot.formula[found[0]!]![24]!==payload||snapshot.effective[found[0]!]![24]!==payload||snapshot.effective[found[0]!]![23]!==stableDailyExpenseKey(job.entityKey))throw Error('INSERT_DAILY_FINAL_IDENTITY');
 if(!await verifyInsertedNumberFormats(env,sheet,sheetId,found[0]!+1))throw Error('INSERT_DAILY_FORMAT_UNVERIFIED');
 const row=snapshot.formula[found[0]!]??[],cells=Array.from({length:grid.columnCount},(_,i)=>row[i]===undefined||row[i]===''?null:row[i]),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(cells)))),v=>v.toString(16).padStart(2,'0')).join('');
 const evidence=await env.DB.prepare(`SELECT 1 AS ok FROM stable_expense_projection_preimages p JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=? AND p.source_version=? AND p.source_digest=? AND p.preimage_width=? AND p.preimage_digest=? AND m.operation_token=? AND substr(m.marker,1,7)='INSERT_' AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity}`).bind(env.GOOGLE_SPREADSHEET_ID,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,grid.columnCount,digest,journal.operation_token).first<{ok:number}>();
 if(evidence?.ok!==1)throw Error('INSERT_DAILY_FINAL_PREIMAGE');
}

/** Check the complete unaffected prefix, shifted blank template tail, and
 * the physically fixed budget panel. The new row itself is checked by the
 * mixed accounting/identity verifier. */
export function verifyInsertedDailyTransform(before:Snapshot,after:Snapshot,oldRows:number,columns:number,row:number):boolean{
 if(row<5||row>oldRows||oldRows>=5000||columns<29||columns>100||before.formula.length>oldRows||after.formula.length>oldRows+1)return false;
 const upgradedJ=appendDailyRowFormulas()[9];
 for(let r=0;r<oldRows;r++)for(let c=0;c<columns;c++){
  const b=before.formula[r]?.[c],be=before.effective[r]?.[c];
  if(c>=25||r<row-1){if(!same(b,after.formula[r]?.[c])||!same(be,after.effective[r]?.[c]))return false;continue;}
  if(helper.has(c)){
   const upgraded=c===9&&b===upgradedJ,expected=upgraded?upgradedJ:continuousDailyHelperFormulas(r+2)[c];
   if(!upgraded&&b!==continuousDailyHelperFormulas(r+1)[c]||after.formula[r+1]?.[c]!==expected||!blank(be)||!blank(after.effective[r+1]?.[c]))return false;
  }else if(!blank(b)||!blank(be)||!blank(after.formula[r+1]?.[c])||!blank(after.effective[r+1]?.[c]))return false;
 }
 for(let c=25;c<columns;c++)if(!blank(after.formula[oldRows]?.[c])||!blank(after.effective[oldRows]?.[c]))return false;
 return true;
}

/** Single atomic insert in the EXISTING draft. The caller must have proven
 * old provider requests and non-cooperating writers are fenced. A lost reply
 * leaves IN_FLIGHT and must never be replayed. This candidate is not routed. */
export async function insertDailyExpenseUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource,sheet:string,sheetId:number):Promise<void>{
 const target=await assertContinuousDailyActivated(env);if(!target||target.sheet!==sheet||target.sheetId!==sheetId)throw Error('INSERT_DAILY_DISABLED');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);const initial=scope();
 if(!book||!lease||!claim||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||env.CONTINUOUS_DAILY_ENABLED!=='true'||env.CONTINUOUS_DAILY_SHEET!==sheet||env.CONTINUOUS_DAILY_SHEET_ID!==String(sheetId)||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true'||!Number.isSafeInteger(sheetId)||sheetId<0||sheet===env.SHEET_EXPENSE_DAILY)throw Error('INSERT_DAILY_DISABLED');
 const stable=()=>env.DB===db&&scope()===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const retained="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace'))))=7";
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${retained} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=? AND c.state='ACTIVE' AND c.continuous_sheet_name=? AND c.continuous_sheet_id=? AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.expense_id=?) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=? AND a.source_version=? AND a.source_digest=?)) AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3) AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) `;
 const args=[source.revision,book,claim,book,sheet,sheetId,job.entityKey,job.entityKey,job.entityVersion,source.digest,job.entityKey,job.entityVersion,job.entityKey,lease];
 const sourceMatches=async()=>{const s=await readStableExpenseSource(env,job,lease,claim),r=await db.prepare(`SELECT 1 AS ok WHERE ${guard}`).bind(...args).first<{ok:number}>();return !!s&&s.revision===source.revision&&s.digest===source.digest&&s.fingerprint===source.fingerprint&&r?.ok===1&&stable()&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('INSERT_DAILY_SOURCE_UNVERIFIED');
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);
 if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('INSERT_DAILY_SOURCE_UNVERIFIED');
 const grid=await beforeIntentRead(()=>getSheetGridInfo(env,sheet));if(!stable()||grid.sheetId!==sheetId||grid.rowCount<5||grid.columnCount<29||grid.columnCount>100)throw Error('INSERT_DAILY_GRID');
 if(grid.rowCount>=5000)throw new InsertDailyDefiniteFailure('CAPACITY');
 const snapshot=async(expected:Grid):Promise<Snapshot>=>{const a=await getSheetGridInfo(env,sheet),range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(expected.columnCount)}${expected.rowCount}`,f=await batchGetSheetFormulaValues(env,[range]),e=await batchGetSheetEffectiveSerialValues(env,[range]),b=await getSheetGridInfo(env,sheet);if(!stable()||JSON.stringify(a)!==JSON.stringify(expected)||JSON.stringify(b)!==JSON.stringify(expected)||f.length!==1||e.length!==1||f[0]!.length>expected.rowCount||e[0]!.length>expected.rowCount||[...f[0]!,...e[0]!].some(r=>!Array.isArray(r)||r.length>expected.columnCount))throw Error('INSERT_DAILY_SNAPSHOT_UNVERIFIED');return{formula:f[0]!,effective:e[0]!};};
 const before=await beforeIntentRead(()=>snapshot(grid)),payment=verifiedInsertDailyPayment(before.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 let legacy:Awaited<ReturnType<typeof readLegacyDailyCoverage>>;
 try{legacy=await beforeIntentRead(()=>readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet));}catch(error){
  if(error instanceof Error&&/^LEGACY_COVERAGE_(YEAR_UNVERIFIED|MONTH_UNVERIFIED|DATE_UNVERIFIED|MONTH_BLOCK_UNVERIFIED|OPENING_UNVERIFIED|SUBTOTAL_UNVERIFIED|SUBTOTAL_MISMATCH|AMOUNT_UNVERIFIED)$/.test(error.message))throw new InsertDailyDefiniteFailure('LEGACY_COVERAGE');
  if(error instanceof Error&&/^LEGACY_COVERAGE_[A-Z_]+$/.test(error.message))throw new InsertDailyPreflightReviewError(error.message);
  throw error;
 }
 const legacyIdRange=`'${env.SHEET_EXPENSE_DAILY.replace(/'/g,"''")}'!X1:X${legacy.grid.rowCount}`,legacyIds=await beforeIntentRead(()=>batchGetSheetFormulaValues(env,[legacyIdRange]));
 if(legacyIds.length!==1||legacyIds[0]!.some(r=>r[0]===stableDailyExpenseKey(job.entityKey)))throw Error('INSERT_DAILY_LEGACY_ID_UNVERIFIED');
 const openings=before.formula.slice(3,243).filter(r=>r[26]===payment.postingYear&&r[27]===payment.postingMonth);
 if(openings.length>1||openings.length===0&&legacy.coverage.openingSatang===null||openings.length===1&&(typeof openings[0]![28]!=='number'||!Number.isFinite(openings[0]![28])||Number(openings[0]![28])<0))throw new InsertDailyDefiniteFailure('MONTH_OPENING');
 if(!verifyMixedDailyAccounting(before,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage))throw Error('INSERT_DAILY_ACCOUNTING_UNVERIFIED');
 if(!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,before.formula)){
  const pending=await pendingDailyCancellations(env,sheet,sheetId,claim);
  if(pending.size&&await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,before.formula,undefined,pending))throw new InsertDailyPendingCancellationError([...pending][0]!);
  throw Error('INSERT_DAILY_ACCOUNTING_UNVERIFIED');
 }
 try{if(await beforeIntentRead(()=>readContinuousReportHealth(env))==='CAPACITY')throw new InsertDailyDefiniteFailure('CAPACITY');}catch(error){
  if(error instanceof Error&&/^REPORT_HEALTH_[A-Z_]+$/.test(error.message))throw new InsertDailyPreflightReviewError(error.message);
  throw error;
 }
 const key=stableDailyExpenseKey(job.entityKey);let last=3;
 for(let i=3;i<grid.rowCount;i++){
  const f=before.formula[i]??[],e=before.effective[i]??[],carrier=decodeAtomicDailyPayload(f[24]);
  if(carrier?.expenseId===job.entityKey||e[23]===key)throw Error('INSERT_DAILY_DUPLICATE_ID');
  if(carrier||Array.from({length:25},(_,c)=>c).some(c=>!helper.has(c)&&!blank(f[c])))last=i+1;
 }
 const row=Math.max(5,last+1);if(row>grid.rowCount)throw new InsertDailyDefiniteFailure('CAPACITY');
 // Prove the whole shifted tail has only known blank template formulas.
 const upgradedJ=appendDailyRowFormulas()[9];
 for(let i=row-1;i<grid.rowCount;i++)for(let c=0;c<25;c++){
  const f=before.formula[i]?.[c],e=before.effective[i]?.[c];
  if(helper.has(c)){if(!blank(e))throw Error('INSERT_DAILY_TAIL_UNVERIFIED');if(f!==continuousDailyHelperFormulas(i+1)[c]&&(c!==9||f!==upgradedJ))throw new InsertDailyDefiniteFailure('ROW_FORMULA');}
  else if(!blank(f)||!blank(e))throw Error('INSERT_DAILY_TAIL_UNVERIFIED');
 }
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet)});
 const prior=await db.prepare("SELECT 1 AS ok FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY'").bind(book,job.entityKey).first<{ok:number}>();if(prior||!await sourceMatches())throw Error('INSERT_DAILY_PRIOR_INTENT');
 const marker=`INSERT_${crypto.randomUUID().replaceAll('-','')}`;
 const reserved=await db.batch([
  db.prepare(`INSERT INTO atomic_daily_marker_reservations(spreadsheet_id,sheet_id,marker,entity_id,source_version,operation_token,created_at) SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard}`).bind(book,sheetId,marker,job.entityKey,job.entityVersion,claim,...args),
  db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guard}`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,claim,...args),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||reserved.length!==3||reserved.some(r=>r.success!==true)||Number(reserved[0]!.meta?.changes)!==1||Number(reserved[1]!.meta?.changes)!==1)throw Error('INSERT_DAILY_RESERVATION_UNCERTAIN');
 const reply=await batchUpdateSpreadsheetWithReply(env,insertContinuousDailyRowRequests(sheetId,row,grid.rowCount,payload),async()=>{
  if(!await sourceMatches()||JSON.stringify(await snapshot(grid))!==JSON.stringify(before)||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet))!==JSON.stringify(legacy)||JSON.stringify(await batchGetSheetFormulaValues(env,[legacyIdRange]))!==JSON.stringify(legacyIds)||await readContinuousReportHealth(env)!=='OK'||!await sourceMatches())throw Error('INSERT_DAILY_PRE_DISPATCH_CHANGED');
 });
 const replies=reply&&typeof reply==='object'?(reply as {replies?:unknown[]}).replies:undefined;if(!Array.isArray(replies)||replies.length!==3||replies.some(r=>!r||typeof r!=='object'))throw Error('INSERT_DAILY_OUTCOME_UNKNOWN');
 const afterGrid={...grid,rowCount:grid.rowCount+1},after=await snapshot(afterGrid);
 if(!await verifyInsertedNumberFormats(env,sheet,sheetId,row))throw Error('INSERT_DAILY_FORMAT_UNVERIFIED');
 if(!verifyInsertedDailyTransform(before,after,grid.rowCount,grid.columnCount,row)||after.formula[row-1]?.[24]!==payload||after.effective[row-1]?.[24]!==payload||after.effective[row-1]?.[23]!==key||!verifyMixedDailyAccounting(after,afterGrid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage)||!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,after.formula,{entityId:job.entityKey,operationToken:claim,payload})||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet))!==JSON.stringify(legacy)||JSON.stringify(await batchGetSheetFormulaValues(env,[legacyIdRange]))!==JSON.stringify(legacyIds)||!await sourceMatches())throw Error('INSERT_DAILY_READBACK_UNCERTAIN');
 const verified=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guard}`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,claim,...args);
 const preimage=await stableExpensePreimageStatement(env,{book,entity:job.entityKey,projection:'DAILY',sheetId,sheetName:sheet,version:job.entityVersion,sourceDigest:source.digest,row:after.formula[row-1]??[],width:grid.columnCount});if(!preimage||!stable())throw Error('INSERT_DAILY_PREIMAGE_UNVERIFIED');
 const result=await db.batch([verified,preimage]);if(result.length!==2||result.some(r=>r.success!==true||Number(r.meta?.changes)!==1))throw Error('INSERT_DAILY_VERIFY_UNCERTAIN');
}
