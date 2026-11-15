/** Local fixtures only: seed readiness stages through their triggers. */
export function cutoverReadySql(claim){
 if(!/^[A-Za-z0-9_-]+$/.test(claim))throw Error('invalid fixture claim');
 const digest='a'.repeat(64);
 return ['VIEWS','DAILY_J','REPORTS'].map(stage=>`INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book','${stage}','${claim}','${digest}','[{}]',1,'IN_FLIGHT','now','now'); UPDATE continuous_report_cutover_attempts SET state='VERIFIED' WHERE spreadsheet_id='book' AND stage='${stage}';`).join(' ');
}
