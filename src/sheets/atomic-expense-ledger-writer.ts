import {continuousSheetsReadPolicy} from './client';
import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {assertContinuousDailyActivated,continuousDailyTarget} from './continuous-daily-route';
import {chooseContinuousDailyCutover,continuousDailyCutoverIntegrity} from './continuous-daily-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {stableExpensePreimageStatement} from './stable-expense-preimage';
import {authenticateCarrierLedgerSnapshot} from './atomic-expense-ledger-auth';
import {decodeLedgerCarrier,encodeLedgerCarrier,ledgerCarrierDisplay,ledgerCarrierFormulas,ledgerCarrierAppendFormulas,ledgerCarrierAppendRequest,rawCarrierHeaders,detailCarrierHeaders,type CarrierLedger,type CarrierLedgerRow} from './atomic-expense-ledger-template';

type Snapshot={formula:unknown[][];effective:unknown[][]};
type Journal={entity_id:string;projection:string;sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string;operation_token:string};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const marker=(value:unknown,row:number):value is string=>typeof value==='string'&&new RegExp(`^MPL1_EMPTY_${row}_[0-9a-f]{32}$`).test(value);
const targetFor=(env:Env,projection:CarrierLedger)=>projection==='EXPENSE_RAW'?[env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID]:[env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID];
const headers=(projection:CarrierLedger)=>projection==='EXPENSE_RAW'?rawCarrierHeaders:detailCarrierHeaders;
export function resolveCarrierLedgerTarget(env:Env,projection:CarrierLedger):{sheet:string;sheetId:number}{
 const daily=continuousDailyTarget(env),[sheet,id]=targetFor(env,projection);
 if(!daily||!sheet||sheet!==sheet.trim()||!id||!/^(0|[1-9]\d*)$/.test(id)||!Number.isSafeInteger(Number(id)))throw Error('LEDGER_CARRIER_DISABLED');
 const reserved=[daily.sheet,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_PERSONAL_USE_RAW,env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG,projection==='EXPENSE_RAW'?env.CONTINUOUS_DETAIL_SHEET:env.CONTINUOUS_RAW_SHEET].filter(Boolean);
 if(reserved.includes(sheet)||Number(id)===daily.sheetId)throw Error('LEDGER_CARRIER_TARGET_ALIAS');return{sheet,sheetId:Number(id)};
}
function validRow(snapshot:Snapshot,row:number,projection:CarrierLedger):CarrierLedgerRow|null{
 const f=snapshot.formula[row-1]??[],e=snapshot.effective[row-1]??[],parsed=decodeLedgerCarrier(f[25]);
 const matches=(formulas:Record<number,string>)=>Object.entries(formulas).every(([c,v])=>f[Number(c)]===v);
 if(!parsed||parsed.projection!==projection||!same(f[25],e[25])||!matches(ledgerCarrierFormulas(projection,row))&&!matches(ledgerCarrierAppendFormulas(projection)))return null;
 const display=ledgerCarrierDisplay(parsed);return display.every((v,i)=>same(v,e[i]))?parsed:null;
}
/** Pure snapshot/identity check used both immediately after write and by a
 * future final verifier. It does not authorize writes or release any hold. */
export function verifyCarrierLedgerSnapshot(snapshot:Snapshot,rowCount:number,columnCount:number,projection:CarrierLedger,expected:CarrierLedgerRow):number{
 if(rowCount<2||rowCount>5000||columnCount!==26||snapshot.formula.length>rowCount||snapshot.effective.length>rowCount||headers(projection).some((v,i)=>snapshot.formula[0]?.[i]!==v)||(projection==='EXPENSE_RAW'&&snapshot.formula[0]?.[17]!=='Sales_Addback_Basis'))throw Error('LEDGER_CARRIER_SNAPSHOT');
 let found=0;const identities=new Set<string>(),nonces=new Set<string>();
 for(let i=1;i<rowCount;i++){
  const f=snapshot.formula[i]??[],e=snapshot.effective[i]??[],y=f[25];if(f.length>columnCount||e.length>columnCount)throw Error('LEDGER_CARRIER_SNAPSHOT');
  if(marker(y,i+1)){
   if(e[25]!==y||Object.entries(ledgerCarrierFormulas(projection,i+1)).some(([c,v])=>f[Number(c)]!==v||!blank(e[Number(c)]))||nonces.has(y.slice(-32)))throw Error('LEDGER_CARRIER_MARKER');
   nonces.add(y.slice(-32));continue;
  }
  const parsed=validRow(snapshot,i+1,projection);if(!parsed)throw Error('LEDGER_CARRIER_ROW_UNVERIFIED');
  const id=projection==='EXPENSE_RAW'?parsed.expenseId:parsed.itemId;if(identities.has(id))throw Error('LEDGER_CARRIER_DUPLICATE');identities.add(id);
  if(id===(projection==='EXPENSE_RAW'?expected.expenseId:expected.itemId)){if(encodeLedgerCarrier(parsed)!==encodeLedgerCarrier(expected))throw Error('LEDGER_CARRIER_IDENTITY');found=i+1;}
 }
 return found;
}

/** Gated new-helper-sheet writer. No plain old RAW/detail row is changed.
 * Requires externally verified request settlement and non-cooperating writer
 * exclusion. Uncertain writes retain IN_FLIGHT and the workbook review fence. */
export async function writeCarrierLedgerUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource,projection:CarrierLedger,itemId?:string):Promise<void>{
 if(!await assertContinuousDailyActivated(env))throw Error('LEDGER_CARRIER_DISABLED');
 const {sheet,sheetId}=resolveCarrierLedgerTarget(env,projection),db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.APP_ENV,env.RUNTIME_MODE]);const initial=scope();
 if(!book||!lease||!claim||env.STABLE_CANCELLATION_PREIMAGE_ENABLED!=='true'||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||source.expense.expense_id!==job.entityKey||source.expense.status!=='CONFIRMED'||source.expense.version!==job.entityVersion)throw Error('LEDGER_CARRIER_INVALID');
 const stable=()=>env.DB===db&&scope()===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const sourceMatches=async()=>{const s=await readStableExpenseSource(env,job,lease,claim),cutover=await chooseContinuousDailyCutover(env,job,source.digest);return !!s&&s.revision===source.revision&&s.digest===source.digest&&s.fingerprint===source.fingerprint&&cutover.status==='CONTINUOUS'&&stable()&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('LEDGER_CARRIER_SOURCE');
 const planned=planStableExpenseProjections(source),entry=projection==='DETAIL'?planned.details.find(x=>x.itemId===itemId):undefined;if(projection==='DETAIL'&&!entry)throw Error('LEDGER_CARRIER_ITEM');
 const entity=projection==='EXPENSE_RAW'?job.entityKey:`${job.entityKey}|${entry!.itemId}`,expected:CarrierLedgerRow={projection,expenseId:job.entityKey,itemId:projection==='DETAIL'?entry!.itemId:'',confirmedVersion:job.entityVersion,status:'CONFIRMED',cancelVersion:null,cancelledAt:'',values:projection==='DETAIL'?entry!.values:planned.raw},payload=encodeLedgerCarrier(expected);
 const grid=await getSheetGridInfo(env,sheet,continuousSheetsReadPolicy);if(!stable()||grid.sheetId!==sheetId||grid.rowCount<2||grid.rowCount>5000||grid.columnCount!==26)throw Error('LEDGER_CARRIER_GRID');
 const snapshot=async(expectedGrid=grid):Promise<Snapshot>=>{const range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(expectedGrid.columnCount)}${expectedGrid.rowCount}`,a=await getSheetGridInfo(env,sheet,continuousSheetsReadPolicy),f=await batchGetSheetFormulaValues(env,[range],continuousSheetsReadPolicy),e=await batchGetSheetEffectiveSerialValues(env,[range],continuousSheetsReadPolicy),b=await getSheetGridInfo(env,sheet,continuousSheetsReadPolicy);if(!stable()||JSON.stringify(a)!==JSON.stringify(expectedGrid)||JSON.stringify(b)!==JSON.stringify(expectedGrid)||f.length!==1||e.length!==1||f[0]!.length>expectedGrid.rowCount||e[0]!.length>expectedGrid.rowCount||[...f[0]!,...e[0]!].some(r=>!Array.isArray(r)||r.length>26))throw Error('LEDGER_CARRIER_READ');return{formula:f[0]!,effective:e[0]!};};
 const before=await snapshot(),found=verifyCarrierLedgerSnapshot(before,grid.rowCount,grid.columnCount,projection,expected);
 await authenticateCarrierLedgerSnapshot(env,before,grid.rowCount,projection,sheet,sheetId);
 const journal=await db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection=?").bind(book,entity,projection).first<Journal>();
 if(journal){if(!found||journal.state!=='VERIFIED'||journal.sheet_id!==sheetId||journal.sheet_name!==sheet||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||!await sourceMatches())throw Error('LEDGER_CARRIER_PRIOR_REVIEW');const evidence=await db.prepare('SELECT 1 AS ok FROM atomic_daily_marker_reservations m JOIN stable_expense_projection_preimages p ON p.spreadsheet_id=m.spreadsheet_id AND p.sheet_id=m.sheet_id AND p.entity_id=m.entity_id AND p.source_version=m.source_version WHERE m.spreadsheet_id=? AND m.sheet_id=? AND m.entity_id=? AND m.source_version=? AND m.operation_token=? AND p.projection=? AND p.sheet_name=? AND p.source_digest=?').bind(book,sheetId,entity,job.entityVersion,journal.operation_token,projection,sheet,source.digest).first<{ok:number}>();if(evidence?.ok!==1)throw Error('LEDGER_CARRIER_PRIOR_REVIEW');return;}
 if(found)throw Error('LEDGER_CARRIER_UNJOURNALED');
 let lastUsed=1;for(let i=1;i<grid.rowCount;i++){const f=before.formula[i]??[],e=before.effective[i]??[],y=f[25];const templates=ledgerCarrierFormulas(projection,i+1),clean=marker(y,i+1)&&e[25]===y&&Array.from({length:25},(_,c)=>c).every(c=>Object.hasOwn(templates,c)||blank(f[c])&&blank(e[c]));if(!clean)lastUsed=i+1;}
 const row=lastUsed+1,appending=row>grid.rowCount;if(appending&&grid.rowCount>=5000)throw Error('LEDGER_CARRIER_CAPACITY');
 const prior=before.formula[row-1]??[],expectedMarker=appending?`MPL1_APPEND_${crypto.randomUUID()}`:prior[25],templates=appending?ledgerCarrierAppendFormulas(projection):ledgerCarrierFormulas(projection,row);
 if(!appending&&(!marker(expectedMarker,row)||before.effective[row-1]?.[25]!==expectedMarker||Object.entries(templates).some(([c,v])=>prior[Number(c)]!==v)||Array.from({length:25},(_,c)=>c).some(c=>!Object.hasOwn(templates,c)&&(!blank(prior[c])||!blank(before.effective[row-1]?.[c])))))throw Error('LEDGER_CARRIER_CAPACITY');
 if(!await sourceMatches())throw Error('LEDGER_CARRIER_SOURCE');
 const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_delete','atomic_daily_marker_no_update','atomic_daily_marker_no_replace')) OR (tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='continuous_report_cutover_attempts' AND name IN ('continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))))=11";
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${integrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.projection='DAILY' AND p.sheet_id=c.continuous_sheet_id AND p.sheet_name=c.continuous_sheet_name WHERE c.spreadsheet_id=? AND c.state='ACTIVE' AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('DAILY_J','REPORTS','VIEWS') AND a.state='VERIFIED')=3 AND p.entity_id=? AND p.state='VERIFIED' AND p.source_version=? AND p.source_digest=? AND c.raw_sheet_id=? AND c.raw_sheet_name=? AND c.detail_sheet_id=? AND c.detail_sheet_name=?)`;
 const args=[source.revision,book,claim,job.entityKey,job.entityVersion,job.entityKey,lease,book,job.entityKey,job.entityVersion,source.digest,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET];
 const reservations=await db.batch([db.prepare(`INSERT INTO atomic_daily_marker_reservations(spreadsheet_id,sheet_id,marker,entity_id,source_version,operation_token,created_at) SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM atomic_daily_marker_reservations WHERE spreadsheet_id=? AND sheet_id=? AND marker=?)`).bind(book,sheetId,expectedMarker,entity,job.entityVersion,claim,...args,book,sheetId,expectedMarker),db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${guard}`).bind(book,entity,projection,sheetId,sheet,job.entityVersion,source.digest,claim,...args),db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")]);
 if(!stable()||reservations.length!==3||reservations.some(r=>r.success!==true)||Number(reservations[0]!.meta?.changes)!==1||Number(reservations[1]!.meta?.changes)!==1)throw Error('LEDGER_CARRIER_RESERVATION_UNCERTAIN');
 const appendCells=appending?ledgerCarrierAppendRequest(projection,sheetId,payload):undefined;
 const conditional={findReplace:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:25,endColumnIndex:26},find:expectedMarker,replacement:payload,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}};
 const reply=await batchUpdateSpreadsheetWithReply(env,[appending?appendCells:conditional],async()=>{if(!await sourceMatches()||JSON.stringify(await snapshot())!==JSON.stringify(before)||!await sourceMatches())throw Error('LEDGER_CARRIER_PRE_DISPATCH_CHANGED');});
 const replies=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined,change=replies?.[0]?.findReplace;
 if(!Array.isArray(replies)||replies.length!==1||!appending&&(!change||change.valuesChanged!==1||change.occurrencesChanged!==1||Number(change.formulasChanged??0)!==0))throw Error('LEDGER_CARRIER_OUTCOME_UNKNOWN');
 const afterGrid=await getSheetGridInfo(env,sheet,continuousSheetsReadPolicy);if(!stable()||afterGrid.sheetId!==sheetId||afterGrid.columnCount!==26||afterGrid.rowCount!==(appending?grid.rowCount+1:grid.rowCount))throw Error('LEDGER_CARRIER_GRID_CHANGED');
 const after=await snapshot(afterGrid);for(let i=0;i<grid.rowCount;i++)for(let c=0;c<26;c++){if(!appending&&i===row-1&&c===25)continue;if(!same(before.formula[i]?.[c],after.formula[i]?.[c]))throw Error('LEDGER_CARRIER_READBACK_UNCERTAIN');if(!appending&&i===row-1&&c<headers(projection).length)continue;if(!same(before.effective[i]?.[c],after.effective[i]?.[c]))throw Error('LEDGER_CARRIER_READBACK_UNCERTAIN');}
 if(projection==='EXPENSE_RAW'&&(!blank(after.formula[row-1]?.[17])||!blank(after.effective[row-1]?.[17]))||verifyCarrierLedgerSnapshot(after,afterGrid.rowCount,afterGrid.columnCount,projection,expected)!==row)throw Error('LEDGER_CARRIER_READBACK_UNCERTAIN');
 await authenticateCarrierLedgerSnapshot(env,after,afterGrid.rowCount,projection,sheet,sheetId,{entityId:entity,version:job.entityVersion,claim,payload,kind:'CONFIRMED'});if(!await sourceMatches())throw Error('LEDGER_CARRIER_READBACK_UNCERTAIN');
 const verified=db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection=? AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guard}`).bind(book,entity,projection,sheetId,sheet,job.entityVersion,source.digest,claim,...args);
 const preimage=await stableExpensePreimageStatement(env,{book,entity,projection,sheetId,sheetName:sheet,version:job.entityVersion,sourceDigest:source.digest,row:after.formula[row-1]??[],width:26});if(!preimage||!stable())throw Error('LEDGER_CARRIER_PREIMAGE_UNVERIFIED');
 const result=await db.batch([verified,preimage]);if(result.length!==2||result.some(r=>r.success!==true||Number(r.meta?.changes)!==1))throw Error('LEDGER_CARRIER_VERIFY_UNCERTAIN');
}
