import type {Env,SheetsSyncJob} from '../types';

const activationSchemaSeen=new WeakSet<object>();

/** A reader-only WIP selector. Persisted intent format takes precedence over
 * the deploy flag, so disabling admissions cannot strand an old intent. */
export async function cancellationProtocol(env:Env,job:SheetsSyncJob):Promise<{financial:boolean;signature:string}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 const stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED===flag&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(!book||job.entityType!=='EXPENSE'||!Number.isSafeInteger(job.entityVersion))return null;
 // Only a positive probe is remembered, per D1 binding object: the additive
 // migration never removes this table, and if it were removed the batch below
 // fails closed. Absence is re-probed every time so a later migration is seen.
 if(!activationSchemaSeen.has(db)){
  const schema=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='continuous_cancel_financial_activation'").first<{ok:number}>();
  if(!stable())return null;
  if(!schema){if(flag==='true')return null;return{financial:false,signature:JSON.stringify(['legacy-schema',flag])};}
  activationSchemaSeen.add(db);
 }
 const rows=await db.batch([
  db.prepare("SELECT transition_id,financial_journal_revision FROM continuous_publication_intents WHERE spreadsheet_id=? AND entity_id=? AND source_version=? AND kind='REVOKE' AND state IN ('IN_FLIGHT','REVIEW','VERIFIED') ORDER BY transition_id").bind(book,job.entityKey,job.entityVersion),
  db.prepare('SELECT singleton FROM continuous_cancel_financial_activation WHERE singleton=1')
 ]);
 if(!stable()||rows.length!==2||rows.some(x=>x.success!==true||!Array.isArray(x.results))||rows[0]!.results!.length>1||rows[1]!.results!.length>1)return null;
 const item=rows[0]!.results![0] as {transition_id?:unknown;financial_journal_revision?:unknown}|undefined,active=rows[1]!.results!.length===1;
 if(item&&(typeof item.transition_id!=='string'||!item.transition_id||item.financial_journal_revision!==null&&(!Number.isSafeInteger(item.financial_journal_revision)||Number(item.financial_journal_revision)<0)))return null;
 if(!item&&active!==(flag==='true'))return null; // refuse mixed-generation admissions
 const financial=item?item.financial_journal_revision!==null:active;
 if(financial&&!active)return null;
 return{financial,signature:JSON.stringify([flag,active,item?.transition_id??null,item?.financial_journal_revision??null])};
}
