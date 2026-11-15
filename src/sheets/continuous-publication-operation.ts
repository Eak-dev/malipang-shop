import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetGridInfo,getSpreadsheetSheetProperties} from './client';
import {decodePublicationCarrier,encodePublicationCarrier,publicationTransition,verifyPublicationColumn,type PublicationCarrier} from './continuous-publication-template';
import {createPublicationAdapter} from './continuous-publication-adapter';
import {executePublicationIntent,validPublicationBefore,type PublicationIntent} from './continuous-publication-executor';
import {readStableExpenseSource} from './stable-expense-source';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {ReviewRequestBudget} from './review-request-budget';
import {capturePublicationBatchSnapshot,publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {createGoogleOAuthLease,type GoogleOAuthLease} from './google-auth';

type Target={sheetId:number;sheetName:string;rows:number};
type Current={marker:string;sheet_id:number;sheet_name:string;row_number:number;version:number;state:string;source_digest:string;intent_state:string};
type Input={job:SheetsSyncJob;lease:string;claim:string;sourceRevision:number;sourceDigest:string;detailCount:number;target:Target;budget:ReviewRequestBudget;verifyTarget:()=>Promise<boolean>;verifyProjections:(phase:'BEFORE'|'AFTER',after:PublicationCarrier,row:number,pending?:{transitionId:string;before:string},snapshot?:PublicationBatchSnapshot,oauthLease?:GoogleOAuthLease)=>Promise<boolean>;atomicHandoff?:(prefix:D1PreparedStatement[],transitionId:string)=>Promise<boolean>;verifyHandoff?:(transitionId:string)=>Promise<boolean>};
const nonce=()=>crypto.randomUUID().replaceAll('-','').toLowerCase();

/** Execute at most one conditional marker transition under the existing
 * claim. Not routed or enabled. No missing/ambiguous intent is replayed. */
export async function publicationOperationUnderClaim(env:Env,kind:'STAGE'|'PUBLISH'|'REVOKE',input:Input):Promise<PublicationCarrier>{
 const {job,lease,claim,target,sourceRevision,sourceDigest,detailCount,budget}=input,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||!claim||!lease||!(budget instanceof ReviewRequestBudget)||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<(kind==='REVOKE'?2:1)||!Number.isSafeInteger(target.sheetId)||target.sheetId<0||!target.sheetName||!Number.isSafeInteger(target.rows)||target.rows<2||target.rows>5000||!Number.isSafeInteger(sourceRevision)||sourceRevision<0||!/^[0-9a-f]{64}$/.test(sourceDigest)||!Number.isSafeInteger(detailCount)||detailCount<0||detailCount>500||typeof input.verifyTarget!=='function'||typeof input.verifyProjections!=='function')throw Error('PUBLICATION_OPERATION_INVALID');
 if(env.STABLE_SHEETS_PACING_ENABLED!=='true')throw Error('PUBLICATION_PACING_REQUIRED');
 const oauthLease=await createGoogleOAuthLease(env,budget,60000),policy={...continuousSheetsReadPolicy,budget,oauthLease};
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]),initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 const guard=async()=>{
  const source=kind==='REVOKE'?await readCancelledExpenseSource(env,job,claim,lease):await readStableExpenseSource(env,job,lease,claim);
  return stable()&&!!source&&source.revision===sourceRevision&&source.digest===sourceDigest&&await input.verifyTarget()&&await stableWorkbookClaimOwned(env,claim,budget,oauthLease)&&stable();
 };
 if(!await guard())throw Error('PUBLICATION_OPERATION_GUARD');
 const [current,pending]=await Promise.all([
  db.prepare("SELECT m.marker,m.sheet_id,m.sheet_name,m.row_number,m.version,m.state,i.source_digest,i.state AS intent_state FROM continuous_publication_markers m JOIN continuous_publication_intents i ON i.transition_id=m.transition_id WHERE m.spreadsheet_id=? AND m.entity_id=?").bind(book,job.entityKey).first<Current>(),
  db.prepare("SELECT 1 AS found FROM continuous_publication_intents WHERE spreadsheet_id=? AND entity_id=? AND state IN ('IN_FLIGHT','REVIEW')").bind(book,job.entityKey).first<{found:number}>()
 ]);
 if(!stable()||pending)throw Error('PUBLICATION_PRIOR_UNRESOLVED');
 let initialSnapshot:PublicationBatchSnapshot|undefined,captureForGuard:(()=>Promise<PublicationBatchSnapshot>)|undefined,formula:unknown[][][],effective:unknown[][][];
 if(kind==='PUBLISH'){
  const specs=await planPublicationSnapshot(env,await getSpreadsheetSheetProperties(env,policy),target);captureForGuard=()=>capturePublicationBatchSnapshot(env,specs,budget,oauthLease);initialSnapshot=await captureForGuard();
  formula=[publicationSnapshotRange(initialSnapshot,target.sheetId,1,target.rows,1,1,'FORMULA')];effective=[publicationSnapshotRange(initialSnapshot,target.sheetId,1,target.rows,1,1,'EFFECTIVE')];
 }else{
  const grid=await getSheetGridInfo(env,target.sheetName,policy);if(!stable()||grid.sheetId!==target.sheetId||grid.rowCount!==target.rows||grid.columnCount<1||grid.columnCount>100)throw Error('PUBLICATION_TARGET_UNVERIFIED');
  const range=`'${target.sheetName.replace(/'/g,"''")}'!A1:A${target.rows}`;formula=await batchGetSheetFormulaValues(env,[range],policy);effective=await batchGetSheetEffectiveSerialValues(env,[range],policy);const latest=await getSheetGridInfo(env,target.sheetName,policy);
  if(!stable()||formula.length!==1||effective.length!==1||JSON.stringify(grid)!==JSON.stringify(latest))throw Error('PUBLICATION_READ_UNVERIFIED');
 }
 const prior=current&&decodePublicationCarrier(current.marker);
 if(current&&(!prior||current.intent_state!=='VERIFIED'||current.sheet_id!==target.sheetId||current.sheet_name!==target.sheetName||current.version!==prior.version||current.state!==prior.state||!verifyPublicationColumn(formula[0]!,effective[0]!,target.rows,prior,current.row_number)))throw Error('PUBLICATION_CURRENT_UNVERIFIED');
 // Re-entry observes a previously verified exact marker; it never sends the
 // same transition again. The last transition's digest must match the source.
 if(prior&&current&&prior.expenseId===job.entityKey&&prior.version===job.entityVersion&&prior.detailCount===detailCount&&current.source_digest===sourceDigest&&((kind==='STAGE'&&['STAGED','PUBLISHED'].includes(prior.state))||(kind==='PUBLISH'&&prior.state==='PUBLISHED')||(kind==='REVOKE'&&prior.state==='REVOKED'))){
  if(!await guard()||kind==='PUBLISH'&&!await input.verifyProjections('AFTER',prior,current.row_number,undefined,initialSnapshot,oauthLease))throw Error('PUBLICATION_EXISTING_UNVERIFIED');return prior;
 }
 let before:string,row:number,after:PublicationCarrier;
 if(kind==='STAGE'){
  if(current)throw Error('PUBLICATION_CURRENT_CONFLICT');
  row=formula[0]!.findIndex((r,i)=>i>0&&typeof r[0]==='string'&&new RegExp(`^PUB0_${i+1}_[0-9a-f]{32}$`).test(r[0]));
  if(row<1)throw Error('PUBLICATION_CAPACITY');row++;before=String(formula[0]![row-1]![0]);
  after={expenseId:job.entityKey,version:job.entityVersion,nonce:nonce(),state:'STAGED',detailCount};
  const provisional:PublicationIntent={sheetId:target.sheetId,row,rows:target.rows,before,after};
  if(!validPublicationBefore({formula:formula[0]!,effective:effective[0]!},provisional))throw Error('PUBLICATION_COLUMN_UNVERIFIED');
 }else{
  if(!prior||!current||prior.expenseId!==job.entityKey||prior.detailCount!==detailCount||kind==='PUBLISH'&&(prior.state!=='STAGED'||prior.version!==job.entityVersion||current.source_digest!==sourceDigest)||kind==='REVOKE'&&(!['STAGED','PUBLISHED'].includes(prior.state)||prior.version!==job.entityVersion-1))throw Error('PUBLICATION_CURRENT_CONFLICT');
  row=current.row_number;before=current.marker;after={...prior,version:job.entityVersion,nonce:nonce(),state:kind==='PUBLISH'?'PUBLISHED':'REVOKED'};publicationTransition(prior,after);
 }
 const intent:PublicationIntent={sheetId:target.sheetId,row,rows:target.rows,before,after};
 const prospectiveFormula=formula[0]!.map(x=>x.slice()),prospectiveEffective=effective[0]!.map(x=>x.slice());prospectiveFormula[row-1]=[encodePublicationCarrier(after)];prospectiveEffective[row-1]=[encodePublicationCarrier(after)];
 if(!verifyPublicationColumn(prospectiveFormula,prospectiveEffective,target.rows,after,row))throw Error('PUBLICATION_NONCE_CONFLICT');
 const transitionId=crypto.randomUUID(),io=createPublicationAdapter(env,{job,lease,claim,transitionId,sheetName:target.sheetName,intent,sourceRevision,sourceDigest,budget,oauthLease,verifyTarget:input.verifyTarget,verifyProjections:(phase,snapshot)=>input.verifyProjections(phase,after,row,{transitionId,before},snapshot,oauthLease),...(captureForGuard&&initialSnapshot?{captureForGuard,initialSnapshot}:{}),...input.atomicHandoff&&input.verifyHandoff?{atomicHandoff:input.atomicHandoff,verifyHandoff:input.verifyHandoff}:{}});
 await executePublicationIntent(intent,io);return after;
}
