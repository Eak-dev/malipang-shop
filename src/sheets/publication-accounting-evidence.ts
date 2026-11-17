import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,continuousSheetsReadPolicy,getSheetGridInfo,type ContinuousSheetsReadPolicy} from './client';
import {decodePublicationCarrier,encodePublicationCarrier,publicationTransition,verifyPublicationColumn,type PublicationCarrier} from './continuous-publication-template';
import type {DailyPublicationAccountingEvidence} from './mixed-daily-accounting';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';

export type PublicationAccountingTarget={sheet:string;sheetId:number;rows:number;row:number;expected:PublicationCarrier;sourceDigest:string;pendingPublish?:{transitionId:string;claim:string;before:string}};
type MarkerRow={entity_id:string;sheet_id:number;sheet_name:string;row_number:number;version:number;state:string;marker:string;source_digest:string};

/** Independently authenticate the full marker column against all immutable
 * VERIFIED D1 intents. An absent/duplicate/malformed provider marker or a D1
 * mismatch is not evidence of absence. This does not grant a write claim or
 * fence a human/old writer; the caller must also hold its workbook claim. */
export async function readPublicationAccountingEvidence(env:Env,target:PublicationAccountingTarget,policy:ContinuousSheetsReadPolicy=continuousSheetsReadPolicy,snapshot?:PublicationBatchSnapshot):Promise<DailyPublicationAccountingEvidence>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,expected=encodePublicationCarrier(target.expected);
 if(!book||!target.sheet||target.sheet!==target.sheet.trim()||target.sheet.length>80||!Number.isSafeInteger(target.sheetId)||target.sheetId<0||!Number.isSafeInteger(target.rows)||target.rows<2||target.rows>5000||!Number.isSafeInteger(target.row)||target.row<2||target.row>target.rows||!/^[0-9a-f]{64}$/.test(target.sourceDigest))throw Error('PUBLICATION_ACCOUNTING_TARGET');
 const stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book;
 const pending=target.pendingPublish;
 let pendingState:'IN_FLIGHT'|'VERIFIED'|undefined;
 if(pending){
  const before=decodePublicationCarrier(pending.before);
  if(!before||target.expected.state!=='PUBLISHED'||before.state!=='STAGED'||!pending.transitionId||!pending.claim)throw Error('PUBLICATION_ACCOUNTING_PENDING');
  try{publicationTransition(before,target.expected);}catch{throw Error('PUBLICATION_ACCOUNTING_PENDING');}
  const intent=await db.prepare("SELECT state FROM continuous_publication_intents WHERE transition_id=? AND spreadsheet_id=? AND entity_id=? AND sheet_id=? AND sheet_name=? AND row_number=? AND kind='PUBLISH' AND source_version=? AND source_digest=? AND claim_token=? AND before_value=? AND after_value=? AND state IN ('IN_FLIGHT','VERIFIED')").bind(pending.transitionId,book,target.expected.expenseId,target.sheetId,target.sheet,target.row,target.expected.version,target.sourceDigest,pending.claim,pending.before,expected).first<{state:'IN_FLIGHT'|'VERIFIED'}>();
  if(!stable()||!intent)throw Error('PUBLICATION_ACCOUNTING_PENDING');pendingState=intent.state;
 }
 const entry=snapshot?.metadata.find(x=>x.title===target.sheet),before=entry?{sheetId:entry.sheetId,rowCount:entry.rowCount,columnCount:entry.columnCount}:snapshot?null:await getSheetGridInfo(env,target.sheet,policy);
 if(!before)throw Error('PUBLICATION_ACCOUNTING_GRID');
 if(!stable()||before.sheetId!==target.sheetId||before.rowCount!==target.rows||before.columnCount<1||before.columnCount>100)throw Error('PUBLICATION_ACCOUNTING_GRID');
 const range=`'${target.sheet.replace(/'/g,"''")}'!A1:A${target.rows}`;
 const formula=snapshot?[publicationSnapshotRange(snapshot,target.sheetId,1,target.rows,1,1,'FORMULA')]:await batchGetSheetFormulaValues(env,[range],policy),effective=snapshot?[publicationSnapshotRange(snapshot,target.sheetId,1,target.rows,1,1,'EFFECTIVE')]:await batchGetSheetEffectiveSerialValues(env,[range],policy),after=snapshot?before:await getSheetGridInfo(env,target.sheet,policy);
 if(!stable()||JSON.stringify(before)!==JSON.stringify(after)||formula.length!==1||effective.length!==1||!verifyPublicationColumn(formula[0]!,effective[0]!,target.rows,target.expected,target.row))throw Error('PUBLICATION_ACCOUNTING_COLUMN');
 const query=await db.prepare(`SELECT p.entity_id,p.sheet_id,p.sheet_name,p.row_number,p.version,p.state,p.marker,i.source_digest FROM continuous_publication_markers p LEFT JOIN continuous_publication_intents i ON i.transition_id=p.transition_id AND i.spreadsheet_id=p.spreadsheet_id AND i.entity_id=p.entity_id AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.row_number=p.row_number AND i.source_version=p.version AND i.after_value=p.marker AND i.state='VERIFIED' WHERE p.spreadsheet_id=?`).bind(book).all<MarkerRow>();
 if(!stable()||query.success!==true||!Array.isArray(query.results)||query.results.length>target.rows-1)throw Error('PUBLICATION_ACCOUNTING_JOURNAL');
 const markers=new Map<string,{state:'STAGED'|'PUBLISHED'|'REVOKED';version:number}>(),seenRows=new Set<number>();
 for(const row of query.results){
  const carrier=decodePublicationCarrier(row.marker);
  const transitioning=!!pending&&row.entity_id===target.expected.expenseId&&row.marker===pending.before;
  if(pending&&row.entity_id===target.expected.expenseId&&(transitioning?pendingState!=='IN_FLIGHT':pendingState!=='VERIFIED'))throw Error('PUBLICATION_ACCOUNTING_PENDING');
  if(!carrier||typeof row.source_digest!=='string'||!/^[0-9a-f]{64}$/.test(row.source_digest)||markers.has(row.entity_id)||seenRows.has(row.row_number)||row.sheet_id!==target.sheetId||row.sheet_name!==target.sheet||row.entity_id!==carrier.expenseId||row.version!==carrier.version||row.state!==carrier.state||!Number.isSafeInteger(row.row_number)||row.row_number<2||row.row_number>target.rows||formula[0]![row.row_number-1]?.[0]!== (transitioning?expected:row.marker))throw Error('PUBLICATION_ACCOUNTING_JOURNAL');
  if(row.entity_id===target.expected.expenseId&&(row.row_number!==target.row||!transitioning&&row.marker!==expected||row.source_digest!==target.sourceDigest))throw Error('PUBLICATION_ACCOUNTING_JOURNAL');
  const visible=transitioning?target.expected:carrier;markers.set(row.entity_id,{state:visible.state,version:visible.version});seenRows.add(row.row_number);
 }
 for(let i=1;i<target.rows;i++)if(decodePublicationCarrier(formula[0]![i]?.[0])&&!seenRows.has(i+1))throw Error('PUBLICATION_ACCOUNTING_ORPHAN');
 if(!markers.has(target.expected.expenseId))throw Error('PUBLICATION_ACCOUNTING_JOURNAL');
 return{sheet:target.sheet,rows:target.rows,markers};
}
