import { safeRecordMetric } from "../db/repositories";
import { isTrue,numberEnv } from "../shared/env";
import type { Env } from "../types";

interface RetentionCandidate{source:"attendance"|"expense";id:string;key:string;}
export interface EvidenceRetentionResult{enabled:boolean;attendanceDeleted:number;expenseDeleted:number;errors:number;}

const DAY_MS=86_400_000;
function cutoffIso(nowMs:number,days:number):string{return new Date(nowMs-days*DAY_MS).toISOString();}

async function candidates(env:Env,normalCutoff:string,shortCutoff:string,limitPerType:number):Promise<RetentionCandidate[]> {
  const [attendance,expense]=await Promise.all([
    env.DB.prepare(`SELECT event_id id,image_key key FROM attendance_events WHERE evidence_deleted_at IS NULL AND image_key IS NOT NULL AND image_key<>'' AND created_at<=? ORDER BY created_at LIMIT ?`).bind(normalCutoff,limitPerType).all<{id:string;key:string}>(),
    env.DB.prepare(`SELECT document_id id,image_key key FROM expense_documents WHERE evidence_deleted_at IS NULL AND image_key IS NOT NULL AND image_key<>'' AND (((status='CANCELLED') AND COALESCE(updated_at,created_at)<=?) OR ((status<>'CANCELLED') AND created_at<=?)) ORDER BY created_at LIMIT ?`).bind(shortCutoff,normalCutoff,limitPerType).all<{id:string;key:string}>()
  ]);
  return[
    ...(attendance.results||[]).map(row=>({source:"attendance" as const,id:String(row.id),key:String(row.key)})),
    ...(expense.results||[]).map(row=>({source:"expense" as const,id:String(row.id),key:String(row.key)}))
  ];
}

async function markDeleted(env:Env,candidate:RetentionCandidate,deletedAt:string):Promise<void>{
  if(candidate.source==="attendance"){
    await env.DB.prepare(`UPDATE attendance_events SET evidence_deleted_at=? WHERE event_id=? AND evidence_deleted_at IS NULL`).bind(deletedAt,candidate.id).run();
    return;
  }
  await env.DB.prepare(`UPDATE expense_documents SET evidence_deleted_at=? WHERE document_id=? AND evidence_deleted_at IS NULL`).bind(deletedAt,candidate.id).run();
}

export async function cleanupExpiredEvidence(env:Env,nowMs=Date.now()):Promise<EvidenceRetentionResult>{
  if(!isTrue(env.EVIDENCE_RETENTION_ENABLED))return{enabled:false,attendanceDeleted:0,expenseDeleted:0,errors:0};
  const normalDays=Math.max(1,Math.floor(numberEnv(env.EVIDENCE_RETENTION_DAYS,90))),shortDays=Math.max(1,Math.floor(numberEnv(env.EVIDENCE_SHORT_RETENTION_DAYS,7))),limitPerType=Math.min(100,Math.max(1,Math.floor(numberEnv(env.EVIDENCE_RETENTION_BATCH_SIZE,50)))),normalCutoff=cutoffIso(nowMs,normalDays),shortCutoff=cutoffIso(nowMs,shortDays),rows=await candidates(env,normalCutoff,shortCutoff,limitPerType),deletedAt=new Date(nowMs).toISOString();
  let attendanceDeleted=0,expenseDeleted=0,errors=0;
  for(const row of rows){
    try{
      await env.EVIDENCE.delete(row.key);
      await markDeleted(env,row,deletedAt);
      if(row.source==="attendance")attendanceDeleted++;else expenseDeleted++;
    }catch(error){errors++;console.error("evidence-retention",row.source,row.id,error);}
  }
  await safeRecordMetric(env,`evidence_retention_${deletedAt.slice(0,10)}`,"evidence_retention_ms",0,{attendanceDeleted:String(attendanceDeleted),expenseDeleted:String(expenseDeleted),errors:String(errors),normalDays:String(normalDays),shortDays:String(shortDays)});
  return{enabled:true,attendanceDeleted,expenseDeleted,errors};
}
