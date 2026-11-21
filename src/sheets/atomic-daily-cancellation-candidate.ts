import {normalNoticeHandoffEnabled,finishVerifiedNormalStage} from './continuous-normal-notice-handoff';
import {continuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetGridInfo,getSpreadsheetSheetProperties} from './client';
import {columnName} from './daily-expense';
import {decodeAtomicDailyPayload} from './atomic-daily-template';
import {verifyAtomicDailyAccounting} from './atomic-daily-cell-writer';
import {stableSourceIntegrity} from './stable-source-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {appendDailyRowFormulas} from './append-daily-template';
import {verifyMixedDailyAccounting,type DailyPublicationAccountingEvidence} from './mixed-daily-accounting';
import {pendingDailyCancellations,verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {continuousDailyCutoverIntegrity,continuousAdmissionIntegrity,continuousReportCutoverIntegrity} from './continuous-daily-cutover';
import {dailyCancelMaskedDigest,dailyCancelTombstone} from './continuous-daily-cancel-evidence';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import {readPublicationAccountingEvidence,type PublicationAccountingTarget} from './publication-accounting-evidence';
import {encodePublicationCarrier} from './continuous-publication-template';
import {readContinuousReportHealth} from './continuous-report-health';
import {ReviewRequestBudget} from './review-request-budget';
import {capturePublicationBatchSnapshot,publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';
import {planPublicationSnapshot} from './publication-snapshot-plan';

type Snapshot={formula:unknown[][];effective:unknown[][]};
type Previous={revision:number;preimage_digest:string;preimage_width:number;previous_version:number;source_digest:string;original_token:string};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const affected=new Set([0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23,24]);
async function rowDigest(row:unknown[],width:number):Promise<string>{
 if(row.length>width||row.some(v=>v!==undefined&&v!==null&&typeof v!=='string'&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v))))throw Error('ATOMIC_CANCEL_PREIMAGE_UNVERIFIED');
 const bytes=new TextEncoder().encode(JSON.stringify(Array.from({length:width},(_,i)=>blank(row[i])?null:row[i])));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
function unchangedExceptCancellation(before:Snapshot,after:Snapshot,rowCount:number,columnCount:number,target:number,year:number,month:number,publication=false):boolean{
 for(let r=0;r<rowCount;r++)for(let c=0;c<columnCount;c++){
  if(!(r===target-1&&c===24)&&!same(before.formula[r]?.[c],after.formula[r]?.[c]))return false;
  if(r===target-1&&(affected.has(c)||publication&&c===25))continue;
  // Only later rows in this month may recalculate their running balances;
  // the accounting checker independently verifies these effective values.
  if(r>=target&&[9,18].includes(c)&&after.effective[r]?.[0]===year&&after.effective[r]?.[1]===month)continue;
  if(!same(before.effective[r]?.[c],after.effective[r]?.[c]))return false;
 }
 return true;
}

/** Gated DAILY building block. It does not cancel RAW/detail,
 * release REVIEW, repair a legacy row, or prove an external writer is fenced.
 * Call only after independently proving all earlier provider requests have
 * settled and external writers cannot restore the carrier during this call.
 * Any previous cancellation intent (including VERIFIED) is held for separate
 * reconciliation; it is NEVER replayed here. Unknown write outcomes remain
 * IN_FLIGHT under the surrounding workbook review fence. */
export async function cancelAtomicDailyCandidateUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,sheet:string,sheetId:number,publication?:PublicationAccountingTarget,budget?:ReviewRequestBudget):Promise<void>{
 // Configuration labels alone are insufficient: require the exact active
 // D1 cutover and both verified report-migration stages before any write.
 const target=await assertContinuousDailyActivated(env);if(!target||target.sheet!==sheet||target.sheetId!==sheetId)throw Error('ATOMIC_CANCEL_DISABLED_OR_INVALID');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.SHEET_EXPENSE_DAILY,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE,env.STABLE_PHASE1_ENABLED]);
 const initial=scope(),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(env.STABLE_PHASE1_ENABLED!=='true'||env.CONTINUOUS_DAILY_ENABLED!=='true'||env.CONTINUOUS_DAILY_SHEET!==sheet||env.CONTINUOUS_DAILY_SHEET_ID!==String(sheetId)||!book||!lease||!/^[A-Za-z0-9-]{8,128}$/.test(claim)||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!Number.isSafeInteger(sheetId)||sheetId<0)throw Error('ATOMIC_CANCEL_DISABLED_OR_INVALID');
 const publicationIdentity=publication?JSON.stringify(publication):undefined;
 let publicationValue:string|undefined;
 if(publication){publicationValue=encodePublicationCarrier(publication.expected);const reserved=[sheet,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET,'V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL','97_EXPENSE_CLEAN'];if(publication.expected.expenseId!==job.entityKey||publication.expected.version!==job.entityVersion||publication.expected.state!=='REVOKED'||reserved.includes(publication.sheet)||publication.sheetId===sheetId||String(publication.sheetId)===env.CONTINUOUS_RAW_SHEET_ID||String(publication.sheetId)===env.CONTINUOUS_DETAIL_SHEET_ID)throw Error('ATOMIC_CANCEL_PUBLICATION_TARGET');}
 const stable=()=>env.DB===db&&scope()===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion])&&(!publication||JSON.stringify(publication)===publicationIdentity);
 const retained=`(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='stable_expense_cancellation_writes' AND name IN ('stable_expense_cancel_preimage_required','stable_expense_cancel_no_delete','stable_expense_cancel_no_replace','stable_expense_cancel_transition')) OR (tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_update','atomic_daily_marker_no_delete','atomic_daily_marker_no_replace')) OR (tbl_name='stable_daily_cancellation_metadata' AND name IN ('stable_daily_cancel_meta_bound','stable_daily_cancel_meta_no_update','stable_daily_cancel_meta_no_delete','stable_daily_cancel_meta_no_replace')) OR (tbl_name='continuous_daily_cancel_evidence' AND name IN ('continuous_daily_cancel_evidence_source','continuous_daily_cancel_evidence_no_update','continuous_daily_cancel_evidence_no_delete','continuous_daily_cancel_evidence_no_replace'))))=19`;
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND ${continuousReportCutoverIntegrity} AND ${retained} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.version=? AND e.status='CANCELLED' AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|') AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND (c.entity_id=? OR substr(c.entity_id,1,length(?)+1)=?||'|') AND c.state<>'VERIFIED' AND NOT(c.entity_id=? AND c.projection='DAILY' AND c.cancellation_version=? AND c.operation_token=?)) AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=? AND c.state='ACTIVE' AND c.continuous_sheet_id=? AND c.continuous_sheet_name=? AND EXISTS(SELECT 1 FROM expense_events target WHERE target.expense_id=? AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses post WHERE post.spreadsheet_id=c.spreadsheet_id AND post.expense_id=target.expense_id) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a JOIN stable_projection_writes prior ON prior.spreadsheet_id=a.spreadsheet_id AND prior.entity_type='EXPENSE' AND prior.entity_id=a.expense_id AND prior.projection='DAILY' AND prior.state='VERIFIED' AND prior.source_version=a.source_version AND prior.source_digest=a.source_digest WHERE a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=target.expense_id AND a.source_version=target.version-1))) AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('DAILY_J','REPORTS','VIEWS') AND a.state='VERIFIED')=3)`;
 const row=await db.prepare(`SELECT r.revision,p.source_version previous_version,p.source_digest,p.operation_token original_token,i.preimage_width,i.preimage_digest FROM stable_projection_writes p JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection CROSS JOIN stable_source_revision r WHERE r.singleton=1 AND p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection='DAILY' AND p.state='VERIFIED' AND p.sheet_id=? AND p.sheet_name=? AND p.source_version=? AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest AND EXISTS(SELECT 1 FROM atomic_daily_marker_reservations m WHERE m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token)`).bind(book,job.entityKey,sheetId,sheet,job.entityVersion-1).first<Previous>();
 if(!row||!Number.isSafeInteger(row.revision)||!Number.isSafeInteger(row.preimage_width)||!/^[0-9a-f]{64}$/.test(row.preimage_digest)||row.previous_version!==job.entityVersion-1||!stable())throw Error('ATOMIC_CANCEL_PREIMAGE_UNVERIFIED');
 const cancelledSource=await readCancelledExpenseSource(env,job,claim,lease);
 if(!cancelledSource||cancelledSource.revision!==row.revision||publication&&publication.sourceDigest!==cancelledSource.digest||!stable())throw Error('ATOMIC_CANCEL_SOURCE_UNVERIFIED');
 const args:unknown[]=[row.revision,book,claim,job.entityKey,job.entityVersion,lease,book,job.entityKey,job.entityKey,job.entityKey,book,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityVersion,claim,book,sheetId,sheet,job.entityKey];
 const publicationGuard=publication?` AND EXISTS(SELECT 1 FROM continuous_publication_markers p JOIN continuous_publication_intents i ON i.transition_id=p.transition_id AND i.spreadsheet_id=p.spreadsheet_id AND i.entity_id=p.entity_id AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.row_number=p.row_number AND i.source_version=p.version AND i.after_value=p.marker AND i.kind='REVOKE' AND i.state='VERIFIED' WHERE p.spreadsheet_id=? AND p.entity_id=? AND p.sheet_id=? AND p.sheet_name=? AND p.row_number=? AND p.version=? AND p.state='REVOKED' AND p.marker=? AND i.source_digest=?) AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents pending WHERE pending.spreadsheet_id=? AND pending.entity_id=? AND pending.state IN ('IN_FLIGHT','REVIEW'))`:'';
 const guarded=guard+publicationGuard;
 if(publication)args.push(book,job.entityKey,publication.sheetId,publication.sheet,publication.row,job.entityVersion,publicationValue,cancelledSource.digest,book,job.entityKey);
 const sourceValid=async()=>{const ok=await db.prepare(`SELECT 1 AS ok WHERE ${guarded}`).bind(...args).first<{ok:number}>();return stable()&&ok?.ok===1&&await stableWorkbookClaimOwned(env,claim,budget)&&stable();};
 if(!await sourceValid())throw Error('ATOMIC_CANCEL_SOURCE_UNVERIFIED');
 const prior=await db.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY'").bind(book,job.entityKey).all<{state:string}>();
 if(prior.success!==true||!Array.isArray(prior.results)||prior.results.length)throw Error('ATOMIC_CANCEL_PRIOR_INTENT_REVIEW');
 const policy=budget?{...continuousSheetsReadPolicy,budget}:continuousSheetsReadPolicy;
 if(publication&&(!(budget instanceof ReviewRequestBudget)||env.STABLE_SHEETS_PACING_ENABLED!=='true')||budget&&!publication)throw Error('ATOMIC_CANCEL_BUDGET_INVALID');
 const grid=await getSheetGridInfo(env,sheet,policy);if(!stable()||grid.sheetId!==sheetId||grid.rowCount<4||grid.rowCount>5000||grid.columnCount!==row.preimage_width||grid.columnCount<29||grid.columnCount>100)throw Error('ATOMIC_CANCEL_GRID_UNVERIFIED');
 const range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const snapshot=async(bundle?:PublicationBatchSnapshot):Promise<Snapshot>=>{if(bundle)return{formula:publicationSnapshotRange(bundle,sheetId,1,grid.rowCount,1,grid.columnCount,'FORMULA'),effective:publicationSnapshotRange(bundle,sheetId,1,grid.rowCount,1,grid.columnCount,'EFFECTIVE')};const a=await getSheetGridInfo(env,sheet,policy),f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy),b=await getSheetGridInfo(env,sheet,policy);if(!stable()||JSON.stringify(a)!==JSON.stringify(grid)||JSON.stringify(b)!==JSON.stringify(grid)||f.length!==1||e.length!==1||f[0]!.length>grid.rowCount||e[0]!.length>grid.rowCount||[...f[0]!,...e[0]!].some(r=>!Array.isArray(r)||r.length>grid.columnCount))throw Error('ATOMIC_CANCEL_READ_UNVERIFIED');return{formula:f[0]!,effective:e[0]!};};
 const specs=budget&&publication?await planPublicationSnapshot(env,await getSpreadsheetSheetProperties(env,policy),{sheetId:publication.sheetId,sheetName:publication.sheet,rows:publication.rows}):undefined;
 const takeBundle=async()=>specs&&budget?capturePublicationBatchSnapshot(env,specs,budget):undefined;
 const beforeBundle=await takeBundle(),before=await snapshot(beforeBundle),matches=before.formula.flatMap((r,i)=>decodeAtomicDailyPayload(r[24])?.expenseId===job.entityKey?[i]:[]);
 if(matches.length!==1)throw Error('ATOMIC_CANCEL_IDENTITY_UNVERIFIED');
 // Do not expose the workbook claim token to spreadsheet editors.
 const index=matches[0]!,f=before.formula[index]??[],e=before.effective[index]??[],original=f[24],payload=decodeAtomicDailyPayload(original),tombstone=await dailyCancelTombstone(claim);
 if(!payload||publication&&payload.publicationVersion!==job.entityVersion-1||!publication&&payload.publicationVersion!==undefined)throw Error('ATOMIC_CANCEL_BEFORE_UNVERIFIED');
 const legacy=await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,sheet,policy,beforeBundle);
 const publicationBefore=publication?await readPublicationAccountingEvidence(env,publication,policy,beforeBundle):undefined;
 const evidenceFingerprint=(p:DailyPublicationAccountingEvidence)=>JSON.stringify([p.sheet,p.rows,[...p.markers.entries()].sort(([a],[b])=>a.localeCompare(b))]);
 const publicationMatches=async(bundle?:PublicationBatchSnapshot)=>!publication||!!publicationBefore&&evidenceFingerprint(await readPublicationAccountingEvidence(env,publication,policy,bundle))===evidenceFingerprint(publicationBefore);
 const dynamic=Object.entries(appendDailyRowFormulas(publication)).every(([c,v])=>f[Number(c)]===v);
 if(publication&&!dynamic)throw Error('ATOMIC_CANCEL_PUBLICATION_FORMULA');
 const accounting=(s:Snapshot)=>dynamic?verifyMixedDailyAccounting(s,grid.rowCount,grid.columnCount,payload.postingYear,payload.postingMonth,legacy.coverage,publicationBefore):verifyAtomicDailyAccounting(s,grid.rowCount,payload.postingYear,payload.postingMonth,legacy.coverage);
 const pending=dynamic?await pendingDailyCancellations(env,sheet,sheetId,claim):undefined;
 const cancelling={entityId:job.entityKey,sourceVersion:row.previous_version,cancelVersion:job.entityVersion,operationToken:claim,leaseToken:lease};
 // A recognizable tombstone is not proof of cancellation. Bind each such
 // cell to a VERIFIED journal in this exact sheet; only our in-flight
 // tombstone is admitted for post-write verification.
 const tombstonesVerified=async(s:Snapshot,includeCurrent:boolean)=>{
  const result=await db.prepare(`SELECT c.operation_token FROM stable_expense_cancellation_writes c JOIN stable_expense_projection_preimages p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type=c.entity_type AND p.entity_id=c.entity_id AND p.projection=c.projection WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND c.projection='DAILY' AND c.state='VERIFIED' AND p.sheet_id=? AND p.sheet_name=?`).bind(book,sheetId,sheet).all<{operation_token:string}>();
  if(result.success!==true||!Array.isArray(result.results))return false;
  const expected=await Promise.all(result.results.map(async r=>`MPD1_CANCELLED_${await rowDigest([r.operation_token],1)}`));if(includeCurrent)expected.push(tombstone);
  const actual=s.formula.flatMap(r=>typeof r[24]==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(r[24])?[r[24]]:[]);
  return new Set(expected).size===expected.length&&new Set(actual).size===actual.length&&expected.length===actual.length&&expected.every(v=>actual.includes(v));
 };
 if(typeof original!=='string'||e[24]!==original||(publication?!blank(e[23])||e[25]!=='REVOKED':e[23]!==`MALIPANG_EXPENSE:${job.entityKey}`)||!blank(e[4])||await rowDigest(f,grid.columnCount)!==row.preimage_digest||before.formula.some(r=>r[24]===tombstone)||!await tombstonesVerified(before,false)||!accounting(before)||dynamic&&!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,before.formula,undefined,pending,cancelling)||!await sourceValid())throw Error('ATOMIC_CANCEL_BEFORE_UNVERIFIED');
 const reportExpected=publication?{expenseId:job.entityKey,absent:true as const,absentFromViews:true}:undefined,reportPublication=publication?{dailySheet:sheet}:undefined;
 if(publication&&await readContinuousReportHealth(env,reportExpected,reportPublication,policy,beforeBundle)!=='OK')throw Error('ATOMIC_CANCEL_REPORT_UNVERIFIED');
 const evidenceCoords={sheetId,row:index+1,rowCount:grid.rowCount,columnCount:grid.columnCount,year:payload.postingYear,month:payload.postingMonth},maskedBeforeDigest=await dailyCancelMaskedDigest(before,evidenceCoords,!!publication);
 // Before intent, reserve enough for a second grouped snapshot, two source /
 // notice guards, the POST, and postimage snapshot/guard; each read can also
 // incur an OAuth cache miss. Pacing disables hidden GET retries here.
 const postReserve=13;if(budget&&(budget.remaining<30||!budget.reservePost(postReserve)))throw Error('ATOMIC_CANCEL_BUDGET_POSTIMAGE');
 if(budget&&!budget.reserveMutation()){budget.releasePost();throw Error('ATOMIC_CANCEL_BUDGET_MUTATION');}
 let reserved:Awaited<ReturnType<typeof db.batch>>;try{reserved=await db.batch([
  db.prepare(`INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?, 'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guarded} AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND c.entity_id=? AND c.projection='DAILY')`).bind(book,job.entityKey,job.entityVersion,row.previous_version,row.preimage_digest,claim,...args,book,job.entityKey),
  db.prepare(`INSERT INTO stable_daily_cancellation_metadata(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,sheet_id,sheet_name,posting_year,posting_month,operation_token,created_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guarded}`).bind(book,job.entityKey,job.entityVersion,sheetId,sheet,payload.postingYear,payload.postingMonth,claim,...args),
  db.prepare(`INSERT INTO continuous_daily_cancel_evidence(spreadsheet_id,entity_id,cancellation_version,previous_version,operation_token,sheet_id,sheet_name,target_row,row_count,column_count,posting_year,posting_month,source_revision,source_fingerprint,original_digest,masked_before_digest,tombstone,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guarded}`).bind(book,job.entityKey,job.entityVersion,row.previous_version,claim,sheetId,sheet,index+1,grid.rowCount,grid.columnCount,payload.postingYear,payload.postingMonth,row.revision,cancelledSource.digest,row.preimage_digest,maskedBeforeDigest,tombstone,...args),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(reserved.length!==4||reserved.some(x=>x.success!==true)||Number(reserved[0]!.meta?.changes)!==1||Number(reserved[1]!.meta?.changes)!==1||Number(reserved[2]!.meta?.changes)!==1||!stable())throw Error('ATOMIC_CANCEL_RESERVATION_UNCERTAIN');}catch(error){budget?.releaseMutation();budget?.releasePost();throw error;}
 let reply:unknown;try{reply=await batchUpdateSpreadsheetWithReply(env,[{findReplace:{range:{sheetId,startRowIndex:index,endRowIndex:index+1,startColumnIndex:24,endColumnIndex:25},find:original,replacement:tombstone,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}}],async()=>{const bundle=await takeBundle();if(!await sourceValid()||!await publicationMatches(bundle)||JSON.stringify(await snapshot(bundle))!==JSON.stringify(before)||JSON.stringify(await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,sheet,policy,bundle))!==JSON.stringify(legacy)||publication&&await readContinuousReportHealth(env,reportExpected,reportPublication,policy,bundle)!=='OK'||!await sourceValid())throw Error('ATOMIC_CANCEL_PRE_DISPATCH_CHANGED');},budget);}finally{budget?.releaseMutation();budget?.releasePost();}
 const responses=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined,change=responses?.[0]?.findReplace;
 if(!Array.isArray(responses)||responses.length!==1||!change||change.valuesChanged!==1||change.occurrencesChanged!==1||Number(change.formulasChanged??0)!==0)throw Error('ATOMIC_CANCEL_OUTCOME_UNKNOWN');
 const afterBundle=await takeBundle(),after=await snapshot(afterBundle),result=after.effective[index]??[];
 if(after.formula[index]?.[24]!==tombstone||result[24]!==tombstone||!blank(result[4])||publication&&!blank(result[25])||[...affected].some(c=>c!==24&&!blank(result[c]))||!unchangedExceptCancellation(before,after,grid.rowCount,grid.columnCount,index+1,payload.postingYear,payload.postingMonth,!!publication)||!accounting(after)||!await tombstonesVerified(after,true)||dynamic&&!await verifyDailyCarrierEvidence(env,sheet,sheetId,grid.columnCount,after.formula,undefined,pending,{...cancelling,tombstone})||!await publicationMatches(afterBundle)||publication&&await readContinuousReportHealth(env,reportExpected,reportPublication,policy,afterBundle)!=='OK'||JSON.stringify(await readLegacyDailyCoverage(env,payload.postingYear,payload.postingMonth,sheet,policy,afterBundle))!==JSON.stringify(legacy)||!await sourceValid())throw Error('ATOMIC_CANCEL_READBACK_UNCERTAIN');
 const verifiedStatement=db.prepare(`UPDATE stable_expense_cancellation_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND cancellation_version=? AND previous_version=? AND preimage_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guarded}`).bind(book,job.entityKey,job.entityVersion,row.previous_version,row.preimage_digest,claim,...args);
 if(normalNoticeHandoffEnabled(env)){await finishVerifiedNormalStage(env,[verifiedStatement],{job,claim,entity:job.entityKey,projection:'DAILY',kind:'CANCEL'},lease,cancelledSource.revision);return;}
 const verified=await verifiedStatement.run();
 if(verified.success!==true||Number(verified.meta?.changes)!==1||!stable())throw Error('ATOMIC_CANCEL_VERIFY_UNCERTAIN');
}
