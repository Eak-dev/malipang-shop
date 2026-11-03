import type {Env} from '../types';
import {auditLegacyExpenseRawEnrollment,type LegacyRawEnrollmentObservation} from './legacy-raw-enrollment-audit';
import {rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';
import {planDailyLegacyCandidates,type DailyLegacyObserved,type DailyLegacySource} from './daily-legacy-enrollment-candidates';
import type {LedgerUatAppendSnapshot} from './ledger-uat-append-planner';

/** Preflight only. This never attaches identity and is not a replacement for
 * complete D1/RAW/Sheet inventories, a durable journal, system-writer drain,
 * exclusive cooperative edit window or a fresh provider preimage check. */
export type DailyLegacyAutoPreflight={expenseId:string;status:'PREFLIGHT_ELIGIBLE'|'HOLD_DAILY'|'HOLD_RAW'|'HOLD_SOURCE'|'HOLD_PERSONAL_CONFLICT'|'HOLD_OTHER_SOURCE_CONFLICT';observedRow?:number;rawObservation?:LegacyRawEnrollmentObservation};
export async function preflightDailyLegacyAutoEnrollment(env:Env,sources:readonly RawSourceProof[],raw:LedgerUatAppendSnapshot,observed:readonly DailyLegacyObserved[],headers:unknown[][],sheetYear:number):Promise<DailyLegacyAutoPreflight[]>{
 if(env.RUNTIME_MODE!=='production'||env.DAILY_LEGACY_ENROLLMENT_PREFLIGHT_ENABLED!=='true'||!Array.isArray(sources)||sources.length>500)throw Error('DAILY_LEGACY_PREFLIGHT_DISABLED');
 const records:DailyLegacySource[]=sources.map(s=>{const v=s.values,amount=v[3];if(s.kind!=='EXPENSE'||v.length!==17||v[0]!==s.entityId||typeof v[1]!=='string'||typeof v[2]!=='string'||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0||!Number.isSafeInteger(Math.round(amount*100))||Math.abs(amount*100-Math.round(amount*100))>0.00001||typeof v[4]!=='string'||typeof v[5]!=='string'||typeof v[6]!=='string'||v[7]!=='CONFIRMED')throw Error('DAILY_LEGACY_INVENTORY_UNVERIFIED');return{expenseId:s.entityId,transactionDate:v[1],description:v[2],amountSatang:Math.round(amount*100),paymentKey:v[4],sourceWallet:v[5],category:v[6],version:s.version};});
 const candidates=planDailyLegacyCandidates(records,observed,headers,sheetYear),results:DailyLegacyAutoPreflight[]=[];
 for(let i=0;i<sources.length;i++){const source=sources[i]!,candidate=candidates[i]!;if(candidate.status!=='REVIEW_PAIR'){results.push({expenseId:source.entityId,status:'HOLD_DAILY'});continue;}if(!await rawSourceStillMatches(env,source)){results.push({expenseId:source.entityId,status:'HOLD_SOURCE'});continue;}const audit=await auditLegacyExpenseRawEnrollment(env,source,raw);if(audit.observation!=='SINGLE_MATCH'){results.push({expenseId:source.entityId,status:'HOLD_RAW',rawObservation:audit.observation});continue;}if(!await rawSourceStillMatches(env,source)){results.push({expenseId:source.entityId,status:'HOLD_SOURCE'});continue;}results.push({expenseId:source.entityId,status:'PREFLIGHT_ELIGIBLE',observedRow:candidate.observedRow!});}
 return results;
}
