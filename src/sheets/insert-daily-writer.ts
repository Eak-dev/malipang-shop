import {normalNoticeHandoffEnabled,finishVerifiedNormalStage} from './continuous-normal-notice-handoff';
import {continuousSheetsReadPolicy,type ContinuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetCellNumberFormats,getSheetGridInfo,getSpreadsheetSheetProperties,SheetsHttpError,SheetsReadNetworkError} from './client';
import {OperationTimeoutError} from '../shared/async';
import {GoogleOAuthHttpError,GoogleOAuthPreflightError} from './google-auth';
import {columnName,legacySourceWallet,resolvePayment} from './daily-expense';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import {appendDailyRowFormulas,insertContinuousDailyRowRequests} from './append-daily-template';
import {decodeAtomicDailyPayload,encodeAtomicDailyPayload} from './atomic-daily-template';
import {verifyMixedDailyAccounting,type DailyPublicationAccountingEvidence} from './mixed-daily-accounting';
import {readPublicationAccountingEvidence,type PublicationAccountingTarget} from './publication-accounting-evidence';
import {encodePublicationCarrier} from './continuous-publication-template';
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
import {dailyPayloadDigest,dailySnapshotDigest,matchesCommittedDailyInsert} from './continuous-daily-write-evidence';
import {capturePublicationBatchSnapshot,publicationSnapshotRange,type PublicationBatchSnapshot,type PublicationSnapshotSpec} from './publication-batch-snapshot';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {ReviewRequestBudget} from './review-request-budget';

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
  if(error instanceof SheetsReadNetworkError)throw new InsertDailyPreflightReviewError('SHEETS_READ_NETWORK');
  if(error instanceof Error&&error.message==='SHEETS_RESPONSE_TOO_LARGE')throw new InsertDailyPreflightReviewError('SHEETS_READ_RESPONSE_TOO_LARGE');
  throw error;
 }
}
async function verifyInsertedNumberFormats(env:Env,sheet:string,sheetId:number,row:number,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy):Promise<boolean>{
 const formats=await getSheetCellNumberFormats(env,sheet,sheetId,row,policy);
 return formats.length===17&&formats.slice(0,15).every(f=>f?.type==='NUMBER'&&f.pattern==='#,##0.00')&&formats[16]?.type==='DATE'&&formats[16]?.pattern==='dd/MM/yyyy';
}

/** Formula cells in legacy X may evaluate to an ID even when their formula
 * text contains no ID. Return null for duplicates or unresolved values. */
export async function readVerifiedLegacyDailyIds(env:Env,range:string,rowCount:number,entityKey:string,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,captured?:{snapshot:PublicationBatchSnapshot;sheetId:number}):Promise<{formula:unknown[][];effective:unknown[][]}|null>{
 const [formula,effective]=captured?[[publicationSnapshotRange(captured.snapshot,captured.sheetId,1,rowCount,24,24,'FORMULA')],[publicationSnapshotRange(captured.snapshot,captured.sheetId,1,rowCount,24,24,'EFFECTIVE')]]:await Promise.all([batchGetSheetFormulaValues(env,[range],policy),batchGetSheetEffectiveSerialValues(env,[range],policy)]);
 const valid=(data:unknown[][][]):boolean=>Array.isArray(data)&&data.length===1&&Array.isArray(data[0])&&data[0]!.length<=rowCount&&data[0]!.every(r=>Array.isArray(r)&&r.length<=1&&(r[0]===undefined||r[0]===null||typeof r[0]==='string'||typeof r[0]==='boolean'||typeof r[0]==='number'&&Number.isFinite(r[0])));
 if(!Number.isSafeInteger(rowCount)||rowCount<1||!valid(formula)||!valid(effective))return null;
 const f=formula[0]!,e=effective[0]!,key=stableDailyExpenseKey(entityKey);
 for(let i=0;i<Math.max(f.length,e.length);i++){
  const fv=f[i]?.[0],ev=e[i]?.[0];
  const isFormula=typeof fv==='string'&&fv.startsWith('=');
  if(fv===key||ev===key||typeof ev==='string'&&ev.startsWith('#')||isFormula&&blank(ev)||!isFormula&&!same(fv,ev))return null;
 }
 return{formula:f,effective:e};
}

export function verifiedInsertDailyPayment(rows:unknown[][],key:string,year:number,month:number,day:number):ReturnType<typeof resolvePayment>{
 const payment=resolvePayment(rows.slice(0,3),key,year,month,day),amountColumn=amountCols[payment.amountColumn];
 const names:Record<string,string[]>={cash:['nonfixed'],transfer:['เงินโอน'],kbank:['kbank'],firstchoice:['firstchoice'],aeon:['aeon'],citibank:['cibitbank','citibank','citi'],ttb:['thanachart','ttb'],homepro:['homepro'],t1:['theone','the1']};
 const normalize=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/[\s_\-/]+/g,''),k=normalize(key),aliases=names[k];
 const headers=k==='transfer'?[rows[1]??[],rows[2]??[]]:[rows[2]??[]],matches=new Set(headers.flatMap(r=>r.flatMap((v,i)=>{const x=normalize(v);return x&&aliases?.some(a=>x===a||x.includes(a))?[i]:[]})));
 if(amountColumn===undefined||!aliases||matches.size!==1||!matches.has(amountColumn))throw Error('INSERT_DAILY_PAYMENT_UNVERIFIED');return payment;
}

/** Read-only final verification for a previously VERIFIED inserted carrier. */
export async function verifyInsertedDailyFinalSnapshot(env:Env,job:SheetsSyncJob,source:StableExpenseSource,sheet:string,sheetId:number,grid:Grid,snapshot:Snapshot,journal:{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string;operation_token?:string},legacy:VerifiedLegacyCoverage,publication?:DailyPublicationAccountingEvidence,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy):Promise<void>{
 if(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==sheetId||journal.sheet_name!==sheet||!journal.operation_token||grid.sheetId!==sheetId)throw Error('INSERT_DAILY_FINAL_JOURNAL');
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('INSERT_DAILY_FINAL_SOURCE');
 const payment=verifiedInsertDailyPayment(snapshot.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 if(!verifyMixedDailyAccounting(snapshot,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy,publication)||!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,snapshot.formula))throw Error('INSERT_DAILY_FINAL_ACCOUNTING');
 const found=snapshot.formula.flatMap((row,i)=>decodeAtomicDailyPayload(row[24])?.expenseId===job.entityKey?[i]:[]);
 const actual=found.length===1?decodeAtomicDailyPayload(snapshot.formula[found[0]!]![24]):null;
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet),...(actual?.operationMarker?{operationMarker:actual.operationMarker}:{}),...(publication&&actual?.publicationVersion?{publicationVersion:actual.publicationVersion}:{})});
 const state=publication?.markers.get(job.entityKey)?.state;
 // This is the confirmation verifier. A REVOKED row belongs to the separate
 // cancellation verifier, which checks the CANCELLED source and preimage.
 if(publication&&state!=='STAGED'&&state!=='PUBLISHED')throw Error('INSERT_DAILY_FINAL_PUBLICATION');
 if(found.length!==1||snapshot.formula[found[0]!]![24]!==payload||snapshot.effective[found[0]!]![24]!==payload||(publication&&state!=='PUBLISHED'?!blank(snapshot.effective[found[0]!]![23]):snapshot.effective[found[0]!]![23]!==stableDailyExpenseKey(job.entityKey)))throw Error('INSERT_DAILY_FINAL_IDENTITY');
 if(!await verifyInsertedNumberFormats(env,sheet,sheetId,found[0]!+1,policy))throw Error('INSERT_DAILY_FORMAT_UNVERIFIED');
 const row=snapshot.formula[found[0]!]??[],cells=Array.from({length:grid.columnCount},(_,i)=>row[i]===undefined||row[i]===''?null:row[i]),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(cells)))),v=>v.toString(16).padStart(2,'0')).join('');
 const evidence=await env.DB.prepare(`SELECT 1 AS ok FROM stable_expense_projection_preimages p JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=? AND p.source_version=? AND p.source_digest=? AND p.preimage_width=? AND p.preimage_digest=? AND m.operation_token=? AND substr(m.marker,1,7)='INSERT_' AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity}`).bind(env.GOOGLE_SPREADSHEET_ID,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,grid.columnCount,digest,journal.operation_token).first<{ok:number}>();
 if(evidence?.ok!==1)throw Error('INSERT_DAILY_FINAL_PREIMAGE');
}

/** Check the complete unaffected prefix, shifted blank template tail, and
 * the physically fixed budget panel. The new row itself is checked by the
 * mixed accounting/identity verifier. */
export function verifyInsertedDailyTransform(before:Snapshot,after:Snapshot,oldRows:number,columns:number,row:number,publication?:{sheet:string;rows:number}):boolean{
 if(row<5||row>oldRows||oldRows>=5000||columns<29||columns>100||before.formula.length>oldRows||after.formula.length>oldRows+1)return false;
 const upgradedJ=appendDailyRowFormulas(publication)[9],shiftedColumns=publication?26:25;
 const blankLast=Array.from({length:shiftedColumns},(_,c)=>blank(before.formula[oldRows-1]?.[c])&&blank(before.effective[oldRows-1]?.[c])).every(Boolean);
 for(let r=0;r<oldRows;r++)for(let c=0;c<columns;c++){
  const b=before.formula[r]?.[c],be=before.effective[r]?.[c];
  if(c>=shiftedColumns||r<row-1){if(!same(b,after.formula[r]?.[c])||!same(be,after.effective[r]?.[c]))return false;continue;}
  if(helper.has(c)){
   if(blankLast&&r===oldRows-1&&blank(after.formula[r+1]?.[c])&&blank(after.effective[r+1]?.[c]))continue;
   const upgraded=c===9&&b===upgradedJ,expected=upgraded?upgradedJ:continuousDailyHelperFormulas(r+2)[c];
   if(!upgraded&&b!==continuousDailyHelperFormulas(r+1)[c]||after.formula[r+1]?.[c]!==expected||!blank(be)||!blank(after.effective[r+1]?.[c]))return false;
  }else if(!blank(b)||!blank(be)||!blank(after.formula[r+1]?.[c])||!blank(after.effective[r+1]?.[c]))return false;
 }
 for(let c=shiftedColumns;c<columns;c++)if(!blank(after.formula[oldRows]?.[c])||!blank(after.effective[oldRows]?.[c]))return false;
 return true;
}

/** Single atomic insert in the EXISTING draft. The caller must have proven
 * old provider requests and non-cooperating writers are fenced. A lost reply
 * leaves IN_FLIGHT and must never be replayed. This candidate is not routed. */
export async function insertDailyExpenseUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource,sheet:string,sheetId:number,publication?:PublicationAccountingTarget,budget?:ReviewRequestBudget):Promise<void>{
 const target=await assertContinuousDailyActivated(env);if(!target||target.sheet!==sheet||target.sheetId!==sheetId)throw Error('INSERT_DAILY_DISABLED');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);const initial=scope();
 if(!book||!lease||!claim||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||env.CONTINUOUS_DAILY_ENABLED!=='true'||env.CONTINUOUS_DAILY_SHEET!==sheet||env.CONTINUOUS_DAILY_SHEET_ID!==String(sheetId)||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true'||!Number.isSafeInteger(sheetId)||sheetId<0||sheet===env.SHEET_EXPENSE_DAILY)throw Error('INSERT_DAILY_DISABLED');
 const publicationIdentity=publication?JSON.stringify(publication):undefined;
 const publicationStable=()=>!publication||JSON.stringify(publication)===publicationIdentity;
 let publicationValue:string|undefined;
 if(publication){
  if(!(budget instanceof ReviewRequestBudget)||env.STABLE_SHEETS_PACING_ENABLED!=='true')throw Error('INSERT_DAILY_PUBLICATION_BUDGET');
  publicationValue=encodePublicationCarrier(publication.expected);
  const reservedSheets=[sheet,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET,'V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL','97_EXPENSE_CLEAN'];
  if(publication.expected.expenseId!==job.entityKey||publication.expected.version!==job.entityVersion||publication.expected.state!=='STAGED'||publication.sourceDigest!==source.digest||reservedSheets.includes(publication.sheet)||publication.sheetId===sheetId||String(publication.sheetId)===env.CONTINUOUS_RAW_SHEET_ID||String(publication.sheetId)===env.CONTINUOUS_DETAIL_SHEET_ID)throw Error('INSERT_DAILY_PUBLICATION_TARGET');
 }
 const stable=()=>env.DB===db&&scope()===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion])&&publicationStable();
 const retained="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='continuous_daily_write_evidence' AND name IN ('continuous_daily_evidence_source','continuous_daily_evidence_no_update','continuous_daily_evidence_no_delete','continuous_daily_evidence_no_replace'))))=11";
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${retained} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=? AND c.state='ACTIVE' AND c.continuous_sheet_name=? AND c.continuous_sheet_id=? AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.expense_id=?) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=? AND a.source_version=? AND a.source_digest=?)) AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3) AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) `;
 const args:unknown[]=[source.revision,book,claim,book,sheet,sheetId,job.entityKey,job.entityKey,job.entityVersion,source.digest,job.entityKey,job.entityVersion,job.entityKey,lease];
 const publicationGuard=publication?` AND EXISTS(SELECT 1 FROM continuous_publication_markers p JOIN continuous_publication_intents i ON i.transition_id=p.transition_id AND i.spreadsheet_id=p.spreadsheet_id AND i.entity_id=p.entity_id AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.row_number=p.row_number AND i.source_version=p.version AND i.after_value=p.marker AND i.kind='STAGE' AND i.state='VERIFIED' WHERE p.spreadsheet_id=? AND p.entity_id=? AND p.sheet_id=? AND p.sheet_name=? AND p.row_number=? AND p.version=? AND p.state='STAGED' AND p.marker=? AND i.source_digest=?) AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents pending WHERE pending.spreadsheet_id=? AND pending.entity_id=? AND pending.state IN ('IN_FLIGHT','REVIEW'))`:'';
 const guarded=guard+publicationGuard;
 if(publication)args.push(book,job.entityKey,publication.sheetId,publication.sheet,publication.row,job.entityVersion,publicationValue,source.digest,book,job.entityKey);
 const policy:ContinuousSheetsReadPolicy=publication?{kind:'continuous-expense',budget:budget!}:continuousSheetsReadPolicy;
 const sourceMatches=async()=>{const s=await readStableExpenseSource(env,job,lease,claim),r=await db.prepare(`SELECT 1 AS ok WHERE ${guarded}`).bind(...args).first<{ok:number}>();return !!s&&s.revision===source.revision&&s.digest===source.digest&&s.fingerprint===source.fingerprint&&r?.ok===1&&stable()&&await stableWorkbookClaimOwned(env,claim,publication?budget:undefined)&&stable();};
 if(!await sourceMatches())throw Error('INSERT_DAILY_SOURCE_UNVERIFIED');
 const planned=planStableExpenseProjections(source),record=planned.record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);
 if(publication&&publication.expected.detailCount!==planned.details.length)throw Error('INSERT_DAILY_PUBLICATION_SOURCE');
 if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))throw Error('INSERT_DAILY_SOURCE_UNVERIFIED');
 const allSheets=publication?await beforeIntentRead(()=>getSpreadsheetSheetProperties(env,policy)):undefined;
 const selected=allSheets?.filter(x=>x.title===sheet),grid=publication?(selected?.length===1?{sheetId:selected[0]!.sheetId,rowCount:selected[0]!.rowCount,columnCount:selected[0]!.columnCount}:null):await beforeIntentRead(()=>getSheetGridInfo(env,sheet,policy));if(!grid||!stable()||grid.sheetId!==sheetId||grid.rowCount<5||grid.columnCount<29||grid.columnCount>100)throw Error('INSERT_DAILY_GRID');
 if(grid.rowCount>=5000)throw new InsertDailyDefiniteFailure('CAPACITY');
 let beforeBatch:PublicationBatchSnapshot|undefined,beforeSpecs:PublicationSnapshotSpec[]|undefined;
 if(publication){beforeSpecs=await planPublicationSnapshot(env,allSheets!,{sheetId:publication.sheetId,sheetName:publication.sheet,rows:publication.rows});if(!stable())throw Error('INSERT_DAILY_SCOPE_CHANGED');}
 const capture=async(expected:Grid):Promise<{daily:Snapshot;batch?:PublicationBatchSnapshot}>=>{
  if(publication){
   const specs=expected.rowCount===grid.rowCount?beforeSpecs!:await planPublicationSnapshot(env,allSheets!.map(s=>s.sheetId===sheetId?{...s,rowCount:expected.rowCount}:s),{sheetId:publication.sheetId,sheetName:publication.sheet,rows:publication.rows});
   const batch=await capturePublicationBatchSnapshot(env,specs,budget!);
   if(!stable())throw Error('INSERT_DAILY_SNAPSHOT_UNVERIFIED');
   return{batch,daily:{formula:publicationSnapshotRange(batch,sheetId,1,expected.rowCount,1,expected.columnCount,'FORMULA'),effective:publicationSnapshotRange(batch,sheetId,1,expected.rowCount,1,expected.columnCount,'EFFECTIVE')}};
  }
  const a=await getSheetGridInfo(env,sheet,policy),range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(expected.columnCount)}${expected.rowCount}`,f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy),b=await getSheetGridInfo(env,sheet,policy);if(!stable()||JSON.stringify(a)!==JSON.stringify(expected)||JSON.stringify(b)!==JSON.stringify(expected)||f.length!==1||e.length!==1||f[0]!.length>expected.rowCount||e[0]!.length>expected.rowCount||[...f[0]!,...e[0]!].some(r=>!Array.isArray(r)||r.length>expected.columnCount))throw Error('INSERT_DAILY_SNAPSHOT_UNVERIFIED');return{daily:{formula:f[0]!,effective:e[0]!}};
 };
 const first=await beforeIntentRead(()=>capture(grid));beforeBatch=first.batch;
 const before=first.daily,payment=verifiedInsertDailyPayment(before.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 let legacy:Awaited<ReturnType<typeof readLegacyDailyCoverage>>;
 try{legacy=await beforeIntentRead(()=>readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet,policy,beforeBatch));}catch(error){
  if(error instanceof Error&&/^LEGACY_COVERAGE_(YEAR_UNVERIFIED|MONTH_UNVERIFIED|DATE_UNVERIFIED|MONTH_BLOCK_UNVERIFIED|OPENING_UNVERIFIED|SUBTOTAL_UNVERIFIED|SUBTOTAL_MISMATCH|AMOUNT_UNVERIFIED)$/.test(error.message))throw new InsertDailyDefiniteFailure('LEGACY_COVERAGE');
  if(error instanceof Error&&/^LEGACY_COVERAGE_[A-Z_]+$/.test(error.message))throw new InsertDailyPreflightReviewError(error.message);
  throw error;
 }
 const legacyIdRange=`'${env.SHEET_EXPENSE_DAILY.replace(/'/g,"''")}'!X1:X${legacy.grid.rowCount}`,legacyIds=await beforeIntentRead(()=>readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy,beforeBatch?{snapshot:beforeBatch,sheetId:legacy.grid.sheetId}:undefined));
 if(!legacyIds)throw Error('INSERT_DAILY_LEGACY_ID_UNVERIFIED');
 const openings=before.formula.slice(3,243).filter(r=>r[26]===payment.postingYear&&r[27]===payment.postingMonth);
 if(openings.length>1||openings.length===0&&legacy.coverage.openingSatang===null||openings.length===1&&(typeof openings[0]![28]!=='number'||!Number.isFinite(openings[0]![28])||Number(openings[0]![28])<0))throw new InsertDailyDefiniteFailure('MONTH_OPENING');
 const publicationBefore=publication?await beforeIntentRead(()=>readPublicationAccountingEvidence(env,publication,policy,beforeBatch)):undefined;
 const publicationPre=publicationBefore?{...publicationBefore,allowAbsentStaged:job.entityKey}:undefined;
 const evidenceFingerprint=(p:DailyPublicationAccountingEvidence)=>JSON.stringify([p.sheet,p.rows,[...p.markers.entries()].sort(([a],[b])=>a.localeCompare(b))]);
 const publicationMatches=async(batch?:PublicationBatchSnapshot)=>!publication||!!publicationBefore&&!!batch&&evidenceFingerprint(await readPublicationAccountingEvidence(env,publication,policy,batch))===evidenceFingerprint(publicationBefore);
 if(!verifyMixedDailyAccounting(before,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage,publicationPre))throw Error('INSERT_DAILY_ACCOUNTING_UNVERIFIED');
 if(!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,before.formula)){
  const pending=await pendingDailyCancellations(env,sheet,sheetId,claim);
  if(pending.size&&await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,before.formula,undefined,pending))throw new InsertDailyPendingCancellationError([...pending][0]!);
  throw Error('INSERT_DAILY_ACCOUNTING_UNVERIFIED');
 }
 const reportExpected=publication?{expenseId:job.entityKey,absent:true as const,absentFromViews:true}:undefined,reportPublication=publication?{dailySheet:sheet}:undefined;
 try{if(await beforeIntentRead(()=>readContinuousReportHealth(env,reportExpected,reportPublication,policy,beforeBatch))==='CAPACITY')throw new InsertDailyDefiniteFailure('CAPACITY');}catch(error){
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
 const upgradedJ=appendDailyRowFormulas(publication)[9],shiftedColumns=publication?26:25;
 const blankTail=Array.from({length:shiftedColumns},(_,c)=>blank(before.formula[grid.rowCount-1]?.[c])&&blank(before.effective[grid.rowCount-1]?.[c])).every(Boolean);
 // Padding can result in two new rows. Reject before intent if that would
 // exceed the supported maximum even when the provider grows the grid twice.
 if(blankTail&&grid.rowCount>4998)throw new InsertDailyDefiniteFailure('CAPACITY');
 for(let i=row-1;i<grid.rowCount;i++)for(let c=0;c<shiftedColumns;c++){
  const f=before.formula[i]?.[c],e=before.effective[i]?.[c];
  if(blankTail&&i===grid.rowCount-1)continue;
  if(helper.has(c)){if(!blank(e))throw Error('INSERT_DAILY_TAIL_UNVERIFIED');if(f!==continuousDailyHelperFormulas(i+1)[c]&&(c!==9||f!==upgradedJ))throw new InsertDailyDefiniteFailure('ROW_FORMULA');}
  else if(!blank(f)||!blank(e))throw Error('INSERT_DAILY_TAIL_UNVERIFIED');
 }
 const marker=`INSERT_${crypto.randomUUID().replaceAll('-','').toLowerCase()}`;
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet),operationMarker:marker,...publication?{publicationVersion:job.entityVersion}:{}});
 const evidenceCoords={sheetId,row,rowCount:grid.rowCount,columnCount:grid.columnCount};
 const beforeDigest=await dailySnapshotDigest(before,evidenceCoords),payloadDigest=await dailyPayloadDigest(payload);
 const prior=await db.prepare("SELECT 1 AS ok FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY'").bind(book,job.entityKey).first<{ok:number}>();if(prior||!await sourceMatches())throw Error('INSERT_DAILY_PRIOR_INTENT');
 // Reserve the mutation and retain enough budget for the pre-dispatch fence
 // and complete postimage even if every GET must refresh OAuth. Pacing=true
 // above disables automatic GET retries. This check precedes durable intent.
 let heldMutation=false,heldPost=false;
 if(publication){
  heldMutation=budget!.reserveMutation();
  if(!heldMutation)throw Error('INSERT_DAILY_PUBLICATION_BUDGET');
  if(budget!.remaining<(blankTail?32:30)||!budget!.reservePost(blankTail?16:14)){budget!.releaseMutation();heldMutation=false;throw Error('INSERT_DAILY_PUBLICATION_BUDGET');}
  heldPost=true;
 }
 try{
 const reserved=await db.batch([
  db.prepare(`INSERT INTO atomic_daily_marker_reservations(spreadsheet_id,sheet_id,marker,entity_id,source_version,operation_token,created_at) SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guarded}`).bind(book,sheetId,marker,job.entityKey,job.entityVersion,claim,...args),
  db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guarded}`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,claim,...args),
  db.prepare(`INSERT INTO continuous_daily_write_evidence(spreadsheet_id,entity_id,sheet_id,sheet_name,source_version,source_digest,operation_token,marker,target_row,before_rows,before_columns,before_digest,payload_digest,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guarded}`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,claim,marker,row,grid.rowCount,grid.columnCount,beforeDigest,payloadDigest,...args),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||reserved.length!==4||reserved.some(r=>r.success!==true)||Number(reserved[0]!.meta?.changes)!==1||Number(reserved[1]!.meta?.changes)!==1||Number(reserved[2]!.meta?.changes)!==1)throw Error('INSERT_DAILY_RESERVATION_UNCERTAIN');
 const reply=await batchUpdateSpreadsheetWithReply(env,insertContinuousDailyRowRequests(sheetId,row,grid.rowCount,payload,publication,blankTail),async()=>{
  if(!await sourceMatches())throw Error('INSERT_DAILY_PRE_DISPATCH_CHANGED');
  const current=await capture(grid),captured=current.batch;
  if(publication&&JSON.stringify(captured)!==JSON.stringify(beforeBatch)||!await publicationMatches(captured)||JSON.stringify(current.daily)!==JSON.stringify(before)||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet,policy,captured))!==JSON.stringify(legacy)||JSON.stringify(await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy,captured?{snapshot:captured,sheetId:legacy.grid.sheetId}:undefined))!==JSON.stringify(legacyIds)||await readContinuousReportHealth(env,reportExpected,reportPublication,policy,captured)!=='OK'||!await sourceMatches()||publication&&budget!.postReserved!==(blankTail?16:14))throw Error('INSERT_DAILY_PRE_DISPATCH_CHANGED');
 },publication?budget:undefined);
 if(heldPost){budget!.releasePost();heldPost=false;}
 const replies=reply&&typeof reply==='object'?(reply as {replies?:unknown[]}).replies:undefined;if(!Array.isArray(replies)||replies.length!==(blankTail?3:2)||replies.some(r=>!r||typeof r!=='object'))throw Error('INSERT_DAILY_OUTCOME_UNKNOWN');
 const afterGrid=blankTail?await getSheetGridInfo(env,sheet,policy):{...grid,rowCount:grid.rowCount+1};
 if(!stable()||afterGrid.sheetId!==grid.sheetId||afterGrid.columnCount!==grid.columnCount||afterGrid.rowCount>5000||![grid.rowCount+1,grid.rowCount+2].includes(afterGrid.rowCount))throw Error('INSERT_DAILY_SNAPSHOT_UNVERIFIED');
 const afterCapture=await capture(afterGrid),after=afterCapture.daily,afterBatch=afterCapture.batch,extra=afterGrid.rowCount===grid.rowCount+2;
 if(extra&&[after.formula[grid.rowCount+1],after.effective[grid.rowCount+1]].some(r=>r!==undefined&&(!Array.isArray(r)||r.length>grid.columnCount||r.some(v=>!blank(v)))))throw Error('INSERT_DAILY_READBACK_UNCERTAIN');
 const insertAfter=extra?{formula:after.formula.slice(0,grid.rowCount+1),effective:after.effective.slice(0,grid.rowCount+1)}:after;
 if(!await verifyInsertedNumberFormats(env,sheet,sheetId,row,policy))throw Error('INSERT_DAILY_FORMAT_UNVERIFIED');
 if(!verifyInsertedDailyTransform(before,insertAfter,grid.rowCount,grid.columnCount,row,publication)||!await matchesCommittedDailyInsert(insertAfter,evidenceCoords,payload,beforeDigest,payloadDigest,publication)||after.formula[row-1]?.[24]!==payload||after.effective[row-1]?.[24]!==payload||(publication?!blank(after.effective[row-1]?.[23]):after.effective[row-1]?.[23]!==key)||!verifyMixedDailyAccounting(after,afterGrid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage,publicationBefore)||!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,after.formula,{entityId:job.entityKey,operationToken:claim,payload})||!await publicationMatches(afterBatch)||publication&&await readContinuousReportHealth(env,reportExpected,reportPublication,policy,afterBatch)!=='OK'||JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,sheet,policy,afterBatch))!==JSON.stringify(legacy)||JSON.stringify(await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy,afterBatch?{snapshot:afterBatch,sheetId:legacy.grid.sheetId}:undefined))!==JSON.stringify(legacyIds)||!await sourceMatches())throw Error('INSERT_DAILY_READBACK_UNCERTAIN');
 const verified=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guarded}`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion,source.digest,claim,...args);
 const preimage=await stableExpensePreimageStatement(env,{book,entity:job.entityKey,projection:'DAILY',sheetId,sheetName:sheet,version:job.entityVersion,sourceDigest:source.digest,row:after.formula[row-1]??[],width:grid.columnCount});if(!preimage||!stable())throw Error('INSERT_DAILY_PREIMAGE_UNVERIFIED');
 if(normalNoticeHandoffEnabled(env)){await finishVerifiedNormalStage(env,[verified,preimage],{job,claim,entity:job.entityKey,projection:'DAILY',kind:'CONFIRM'},lease,source.revision);return;}
 const result=await db.batch([verified,preimage]);if(result.length!==2||result.some(r=>r.success!==true||Number(r.meta?.changes)!==1))throw Error('INSERT_DAILY_VERIFY_UNCERTAIN');
 }finally{if(heldMutation)budget!.releaseMutation();if(heldPost)budget!.releasePost();}
}
