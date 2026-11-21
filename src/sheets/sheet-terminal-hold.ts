import type {Env,SheetsSyncJob} from '../types';

export type SheetTerminalIdentity=Pick<SheetsSyncJob,'entityType'|'entityKey'|'entityVersion'>;
export const STABLE_TERMINAL_HOLD='STABLE_TERMINAL_HOLD';
/** Read-only fast check; the lease/workbook D1 CAS remains authoritative. */
export async function hasTerminalSheetHold(env:Env,job:SheetTerminalIdentity):Promise<boolean>{
 const row=await env.DB.prepare("SELECT 1 AS present FROM failed_jobs WHERE queue_name='malipang-jobs' AND job_key=? AND status='OPEN' AND error='DEAD_LETTER_MAX_RETRIES' LIMIT 1").bind(`${job.entityType}:${job.entityKey}:${job.entityVersion}`).first<{present:number}>();
 if(row==null)return false;
 if(row.present!==1)throw Error('STABLE_TERMINAL_LOOKUP_UNKNOWN');
 return true;
}
