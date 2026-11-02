import type {Env} from '../types';
import {configuredDailyInspector,readSignedDailyApproval} from './daily-row-inspection';
import {stageDailyIdentityCandidate,dailyIdentityCandidateStatus} from '../sheets/daily-identity-staging';

/** Adds a provisional evidence record only. It does not authorize release. */
export async function stageDailyIdentityRequest(request:Request,env:Env):Promise<Response>{
  if(env.DAILY_ROW_INSPECTOR_ENABLED!=='true'||env.DAILY_ROW_STAGING_ENABLED!=='true')return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  const signed=await readSignedDailyApproval(request);
  const result=signed?await stageDailyIdentityCandidate(configuredDailyInspector(env),signed.approval,signed.signature):'HELD';
  return Response.json({ok:true,result,releasePermitted:false},{headers:{'cache-control':'no-store'}});
}
/** This route only reads the candidate record for the exact supplied signed
 * evidence; absence does not prove an earlier transaction failed. */
export async function dailyIdentityCandidateStatusRequest(request:Request,env:Env):Promise<Response>{
  if(env.DAILY_ROW_INSPECTOR_ENABLED!=='true'||env.DAILY_ROW_STAGING_ENABLED!=='true')return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  const signed=await readSignedDailyApproval(request);
  const result=signed?await dailyIdentityCandidateStatus(configuredDailyInspector(env),signed.approval,signed.signature):'NOT_OBSERVED';
  return Response.json({ok:true,result,releasePermitted:false},{headers:{'cache-control':'no-store'}});
}
