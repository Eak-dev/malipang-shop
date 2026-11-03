import type {Env} from '../types';
import type {DailyRecoveryIdentity} from './daily-recovery-identity-reader';
export async function hashRecordedDailyBaseline(value:unknown):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.length>131072)throw Error('DAILY_RECORDED_BASELINE_INVALID');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}
/** A comparison witness, not independent proof of production enrollment. The
 * candidate has no route to create one; an approved writer must establish its
 * provenance and migration/cutover before enabling any provider mutation. */
export async function loadRecordedDailyIdentity(env:Env,expenseId:string,sourceVersion:number):Promise<(DailyRecoveryIdentity&{baselineSha256:string})|null>{
 try{const r=await env.DB.prepare(`SELECT i.metadata_id,i.baseline_json,w.baseline_sha256 FROM daily_stable_row_intents i JOIN daily_recovery_identity_witnesses w ON w.spreadsheet_id=i.spreadsheet_id AND w.expense_id=i.expense_id AND w.metadata_id=i.metadata_id AND w.projected_version=i.projected_version AND w.provenance='PRODUCTION_VERIFIED_WRITER' WHERE i.spreadsheet_id=? AND i.expense_id=? AND i.state='VERIFIED' AND i.projected_version<=?`).bind(env.GOOGLE_SPREADSHEET_ID,expenseId,sourceVersion).first<{metadata_id:number;baseline_json:string;baseline_sha256:string}>();if(!r||typeof r.baseline_json!=='string'||r.baseline_json.length>32768)return null;const baseline=JSON.parse(r.baseline_json) as unknown;if(!Array.isArray(baseline)||baseline.length!==25||await hashRecordedDailyBaseline(baseline)!==r.baseline_sha256)return null;return{expenseId,metadataId:r.metadata_id,baseline,baselineSha256:r.baseline_sha256};}catch{return null;}
}
