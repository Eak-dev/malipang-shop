import type {Env} from '../types';
// Presence is a fail-closed installation check, not protection against a
// privileged database operator replacing trigger definitions.
export const dailyResolutionIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('daily_resolution_no_delete','daily_resolution_no_update','daily_resolution_no_replace','daily_resolution_validate','daily_resolution_apply'))=5";
export function requireDailyResolutionIntegrity(env:Env):string{return env.DAILY_REVIEWED_RELEASE_ENABLED==='true'?`AND ${dailyResolutionIntegrity}`:'';}
export function unresolvedNotice(env:Env,alias:string):string{return env.DAILY_REVIEWED_RELEASE_ENABLED==='true'?`AND NOT EXISTS(SELECT 1 FROM daily_reviewed_resolutions done WHERE done.spreadsheet_id=${alias}.spreadsheet_id AND done.sheet_name=${alias}.sheet_name AND done.window_token=${alias}.window_token AND done.notice_token=${alias}.operation_token)`:'';}
export function unresolvedRowEvidence(env:Env,alias:string):string{return env.DAILY_REVIEWED_RELEASE_ENABLED==='true'?`AND NOT EXISTS(SELECT 1 FROM daily_reviewed_resolutions done WHERE done.spreadsheet_id=${alias}.spreadsheet_id AND done.sheet_name=${alias}.sheet_name AND done.window_token=${alias}.window_token AND done.mutation_token=${alias}.mutation_operation_token)`:'';}
