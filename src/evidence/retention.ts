import { safeRecordMetric } from "../db/repositories";
import { isTrue,numberEnv } from "../shared/env";
import type { Env } from "../types";

export interface EvidenceRetentionResult{
  enabled:boolean;
  scanned:number;
  newlyIndexed:number;
  newlyEligible:number;
  errors:number;
}

const DAY_MS=86_400_000;
const PREFIXES=["attendance/","expense/"] as const;
function cutoffIso(nowMs:number,days:number):string{return new Date(nowMs-days*DAY_MS).toISOString();}
function evidenceType(prefix:string):string{return prefix.startsWith("attendance")?"attendance":"expense";}

async function scanPrefix(env:Env,prefix:string,limit:number,nowIso:string):Promise<{scanned:number;newlyIndexed:number}>{
  const state=await env.DB.prepare(`SELECT cursor FROM evidence_scan_state WHERE prefix=?`).bind(prefix).first<{cursor:string|null}>();
  const listed=await env.EVIDENCE.list({prefix,limit,...(state?.cursor?{cursor:state.cursor}:{})});
  let newlyIndexed=0;
  for(const object of listed.objects){
    const createdAt=object.uploaded.toISOString();
    const result=await env.DB.prepare(`INSERT OR IGNORE INTO evidence_objects(object_key,evidence_type,status,created_at,retention_eligible_at,updated_at) VALUES(?,?,'STORED',?,NULL,?)`).bind(object.key,evidenceType(prefix),createdAt,nowIso).run();
    newlyIndexed+=Number(result.meta.changes||0);
  }
  const nextCursor=listed.truncated?String(listed.cursor||""):null;
  await env.DB.prepare(`INSERT INTO evidence_scan_state(prefix,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(prefix) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`).bind(prefix,nextCursor,nowIso).run();
  return{scanned:listed.objects.length,newlyIndexed};
}

async function markEligible(env:Env,normalCutoff:string,shortCutoff:string,nowIso:string):Promise<number>{
  const attendance=await env.DB.prepare(`UPDATE evidence_objects SET status='RETENTION_ELIGIBLE',retention_eligible_at=?,updated_at=? WHERE status='STORED' AND evidence_type='attendance' AND created_at<=?`).bind(nowIso,nowIso,normalCutoff).run();
  const expense=await env.DB.prepare(`UPDATE evidence_objects SET status='RETENTION_ELIGIBLE',retention_eligible_at=?,updated_at=? WHERE status='STORED' AND evidence_type='expense' AND ((created_at<=? AND EXISTS(SELECT 1 FROM expense_documents d WHERE d.image_key=evidence_objects.object_key AND d.status='CANCELLED')) OR (created_at<=? AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE d.image_key=evidence_objects.object_key AND d.status='CANCELLED')))`).bind(nowIso,nowIso,shortCutoff,normalCutoff).run();
  return Number(attendance.meta.changes||0)+Number(expense.meta.changes||0);
}

export async function auditEvidenceRetention(env:Env,nowMs=Date.now()):Promise<EvidenceRetentionResult>{
  if(!isTrue(env.EVIDENCE_RETENTION_ENABLED))return{enabled:false,scanned:0,newlyIndexed:0,newlyEligible:0,errors:0};
  const started=Date.now(),normalDays=Math.max(1,Math.floor(numberEnv(env.EVIDENCE_RETENTION_DAYS,90))),shortDays=Math.max(1,Math.floor(numberEnv(env.EVIDENCE_SHORT_RETENTION_DAYS,7))),batchSize=Math.min(1000,Math.max(1,Math.floor(numberEnv(env.EVIDENCE_RETENTION_BATCH_SIZE,100)))),normalCutoff=cutoffIso(nowMs,normalDays),shortCutoff=cutoffIso(nowMs,shortDays),nowIso=new Date(nowMs).toISOString();
  let scanned=0,newlyIndexed=0,newlyEligible=0,errors=0;
  for(const prefix of PREFIXES){
    try{const result=await scanPrefix(env,prefix,batchSize,nowIso);scanned+=result.scanned;newlyIndexed+=result.newlyIndexed;}
    catch(error){errors++;console.error("evidence-retention-scan",prefix,error);}
  }
  try{newlyEligible=await markEligible(env,normalCutoff,shortCutoff,nowIso);}catch(error){errors++;console.error("evidence-retention-mark",error);}
  await safeRecordMetric(env,`evidence_retention_${nowIso.slice(0,10)}`,"evidence_retention_audit_ms",Date.now()-started,{scanned:String(scanned),newlyIndexed:String(newlyIndexed),newlyEligible:String(newlyEligible),errors:String(errors),normalDays:String(normalDays),shortDays:String(shortDays)});
  return{enabled:true,scanned,newlyIndexed,newlyEligible,errors};
}
