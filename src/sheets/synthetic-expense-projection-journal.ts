import type {Env,SheetsSyncJob} from '../types';
import {assertStableShadowConfig,assertStableShadowDatabase} from './daily-stable-row-shadow';

export type SyntheticProjection='RAW'|'DAILY'|'DETAIL';
const snapshot=`json_array(e.expense_id,e.version,e.status,e.transaction_date,e.description,e.amount_satang,e.payment_key,e.source_wallet,e.category)`;
const fields=new Set<SyntheticProjection>(['RAW','DAILY','DETAIL']);

/** Shadow-only coordination primitive. VERIFIED means its caller asserted a
 * provider readback, not that this journal independently checked the sheet.
 * Detail documents/items and RAW-specific fields still require independent
 * source proofs by their adapters before any production use. An IN_FLIGHT
 * operation must never be retried solely because a timeout elapsed. */
export class SyntheticExpenseProjectionJournal{
  constructor(private readonly env:Env,private readonly job:SheetsSyncJob,private readonly leaseToken:string){}
  private async check(projection?:SyntheticProjection):Promise<void>{
    if(this.job.kind!=='SHEETS_SYNC'||this.job.entityType!=='EXPENSE'||!Number.isSafeInteger(this.job.entityVersion)||this.job.entityVersion<1||!this.leaseToken||projection&&!fields.has(projection))throw new Error('SYNTHETIC_PROJECTION_INVALID');
    assertStableShadowConfig(this.env,this.job.entityKey);await assertStableShadowDatabase(this.env);
  }
  async begin(projection:SyntheticProjection):Promise<string|null>{
    await this.check(projection);const token=crypto.randomUUID(),now=new Date().toISOString();
    const result=await this.env.DB.prepare(`INSERT INTO synthetic_expense_projection_journal(spreadsheet_id,expense_id,expense_version,projection,state,operation_token,source_snapshot,updated_at)
      SELECT ?,e.expense_id,e.version,?,'IN_FLIGHT',?,${snapshot},? FROM expense_events e
      WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND NOT EXISTS(SELECT 1 FROM synthetic_expense_projection_journal p WHERE p.spreadsheet_id=? AND p.expense_id=e.expense_id AND (p.state IN ('IN_FLIGHT','REVIEW') OR (p.expense_version=e.version AND p.source_snapshot<>${snapshot})))
      ON CONFLICT(spreadsheet_id,expense_id,expense_version,projection) DO NOTHING`).bind(this.env.GOOGLE_SPREADSHEET_ID,projection,token,now,this.job.entityKey,this.job.entityVersion,this.leaseToken,this.env.GOOGLE_SPREADSHEET_ID).run();
    return Number(result.meta.changes||0)===1?token:null;
  }
  async verify(projection:SyntheticProjection,token:string,evidenceDigest:string):Promise<boolean>{
    await this.check(projection);if(!token||!/^[0-9a-f]{64}$/.test(evidenceDigest))throw new Error('SYNTHETIC_PROJECTION_EVIDENCE_INVALID');
    const result=await this.env.DB.prepare(`UPDATE synthetic_expense_projection_journal SET state='VERIFIED',evidence_digest=?,updated_at=?
      WHERE spreadsheet_id=? AND expense_id=? AND expense_version=? AND projection=? AND state='IN_FLIGHT' AND operation_token=?
      AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND ${snapshot}=synthetic_expense_projection_journal.source_snapshot AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND NOT EXISTS(SELECT 1 FROM synthetic_expense_projection_journal p WHERE p.spreadsheet_id=synthetic_expense_projection_journal.spreadsheet_id AND p.expense_id=synthetic_expense_projection_journal.expense_id AND p.state IN ('IN_FLIGHT','REVIEW') AND (p.expense_version<>synthetic_expense_projection_journal.expense_version OR p.projection<>synthetic_expense_projection_journal.projection))`).bind(evidenceDigest,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,projection,token,this.job.entityKey,this.job.entityVersion,this.leaseToken).run();
    return Number(result.meta.changes||0)===1;
  }
  async hold(projection:SyntheticProjection,token:string):Promise<boolean>{
    await this.check(projection);const result=await this.env.DB.prepare(`UPDATE synthetic_expense_projection_journal SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND expense_version=? AND projection=? AND state='IN_FLIGHT' AND operation_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,projection,token).run();return Number(result.meta.changes||0)===1;
  }
  async complete():Promise<boolean>{
    await this.check();const result=await this.env.DB.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
      WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.version=sync_jobs.entity_version AND e.status='CONFIRMED'
        AND (SELECT COUNT(*) FROM synthetic_expense_projection_journal p WHERE p.spreadsheet_id=? AND p.expense_id=e.expense_id AND p.expense_version=e.version AND p.state='VERIFIED' AND p.source_snapshot=${snapshot} AND p.projection IN ('RAW','DAILY','DETAIL'))=3
        AND NOT EXISTS(SELECT 1 FROM synthetic_expense_projection_journal p WHERE p.spreadsheet_id=? AND p.expense_id=e.expense_id AND p.state IN ('IN_FLIGHT','REVIEW')))`).bind(new Date().toISOString(),this.job.entityKey,this.job.entityVersion,this.leaseToken,this.env.GOOGLE_SPREADSHEET_ID,this.env.GOOGLE_SPREADSHEET_ID).run();return Number(result.meta.changes||0)===1;
  }
}
