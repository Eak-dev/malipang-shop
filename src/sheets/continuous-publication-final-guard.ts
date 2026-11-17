import type {Env,SheetsSyncJob} from '../types';
import type {StableExpenseSource} from './stable-expense-source';
import {decodePublicationCarrier,type PublicationCarrier} from './continuous-publication-template';
import {readPublicationAccountingEvidence} from './publication-accounting-evidence';
import {verifyStableExpenseProjections} from './stable-expense-final-check';
import {ReviewRequestBudget} from './review-request-budget';
import type {PublicationBatchSnapshot} from './publication-batch-snapshot';
import type {GoogleOAuthLease} from './google-auth';

type Journal=Parameters<typeof verifyStableExpenseProjections>[3];
/** Verify every projection and the reporting views before and after the
 * provider CAS. AFTER permits exactly the one durable PUBLISH intent whose
 * provider postimage has arrived while its D1 commit is still pending. */
export async function verifyPublicationFinalGuard(env:Env,job:SheetsSyncJob,source:StableExpenseSource,journals:Journal,target:{sheetId:number;sheetName:string;rows:number},claim:string,phase:'BEFORE'|'AFTER',after:PublicationCarrier,row:number,budget:ReviewRequestBudget,pending?:{transitionId:string;before:string},snapshot?:PublicationBatchSnapshot,oauthLease?:GoogleOAuthLease):Promise<boolean>{
 if(!(budget instanceof ReviewRequestBudget)||after.expenseId!==job.entityKey||after.version!==job.entityVersion||after.state!=='PUBLISHED'||!claim||!Number.isSafeInteger(row)||row<2||row>target.rows)throw Error('PUBLICATION_FINAL_IDENTITY');
 const before=pending&&decodePublicationCarrier(pending.before);
 if(phase==='BEFORE'&&(!pending||!before||before.state!=='STAGED'))throw Error('PUBLICATION_FINAL_INTENT');
 const expected=phase==='BEFORE'?before!:after;
 const policy={kind:'continuous-expense' as const,budget,...oauthLease?{oauthLease}:{}};
 const evidence=await readPublicationAccountingEvidence(env,{sheet:target.sheetName,sheetId:target.sheetId,rows:target.rows,row,expected,sourceDigest:source.digest,...phase==='AFTER'&&pending?{pendingPublish:{transitionId:pending.transitionId,before:pending.before,claim}}:{}},policy,snapshot);
 await verifyStableExpenseProjections(env,job,source,journals,{...evidence,phase:phase==='BEFORE'?'STAGED':'PUBLISHED'},policy,snapshot);
 return true;
}
