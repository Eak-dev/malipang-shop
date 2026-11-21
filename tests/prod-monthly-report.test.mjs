import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateInputs,verifyBackupEvidence,runMonthlyReport} from '../scripts/prod-monthly-report.mjs';
const sha='a'.repeat(40),candidate='b'.repeat(64),version='01234567-89ab-cdef-0123-456789abcdef',env={EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',MONTHLY_PHASE:'APPEND_ONE',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),BACKUP_RUN_ID:'123',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true',CLOUDFLARE_ACCOUNT_ID:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',MALIPANG_ADMIN_TOKEN:'synthetic',MALIPANG_WORKER_URL:'https://worker.invalid/',GITHUB_TOKEN:'synthetic'};
const run={path:'.github/workflows/prod-ops-readonly.yml',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:sha,created_at:'2026-11-21T10:08:00.000Z'},job={id:1234,name:'ops',status:'completed',conclusion:'success',steps:[{name:'Backup and migration rehearsal',conclusion:'success'}]},log=['export','backup_upload','backup_checksum','restore','integrity_before','foreign_keys_before','preexisting_rows_unchanged','integrity_after','foreign_keys_after','smoke_all'].map(x=>`- ${x}: PASS`).join('\n');
test('requires pinned main and current operational fence for a single write',()=>{
 assert.deepEqual(validateInputs(env),{phase:'APPEND_ONE',base:'https://worker.invalid'});
 for(const bad of [{GITHUB_REF:'refs/heads/other'},{GITHUB_RUN_ATTEMPT:'2'},{EXTERNAL_WRITERS_FENCED:'false'},{OWNER_SUPERVISING:'false'},{BACKUP_RUN_ID:''},{MALIPANG_WORKER_URL:'https://worker.invalid/path'}])assert.throws(()=>validateInputs({...env,...bad}),/MONTHLY_/);
 assert.equal(validateInputs({...env,MONTHLY_PHASE:'PREVIEW',BACKUP_RUN_ID:'',EXTERNAL_WRITERS_FENCED:'false',OWNER_SUPERVISING:'false'}).phase,'PREVIEW');
});
test('backup guard verifies successful private upload, restore and integrity',()=>{
 assert.equal(verifyBackupEvidence(run,job,log,sha),true);assert.equal(verifyBackupEvidence(run,job,log.replace('- backup_upload: PASS','- backup_upload: SKIPPED'),sha),false);assert.equal(verifyBackupEvidence({...run,created_at:'2026-11-21T10:07:19.000Z'},job,log,sha),false);assert.equal(verifyBackupEvidence({...run,head_sha:'d'.repeat(40)},job,log,sha),false);assert.equal(verifyBackupEvidence(run,{...job,steps:[]},log,sha),false);
});
test('full workflow previews and appends at most once, preserving unknown outcomes',async()=>{
 for(const mode of ['ok','empty','bad-preview','lost-append','bad-backup']){
  const calls=[],fetchStub=async (url,options={})=>{
   url=String(url);calls.push({url,options});
   if(url.endsWith('/runs/123'))return Response.json(run);
   if(url.endsWith('/runs/123/jobs?per_page=100'))return Response.json({jobs:[job]});
   if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://logs.invalid/log'}});
   if(url==='https://logs.invalid/log'){assert.equal(options.headers,undefined);return new Response(mode==='bad-backup'?'':log);}
   if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
   if(url==='https://worker.invalid/admin/stable-sync/monthly-report'){
    const body=JSON.parse(options.body);assert.equal(options.redirect,'error');
    if(body.action==='PREVIEW')return Response.json({action:'PREVIEW',servedVersion:version,status:'READY',ready:mode==='empty'?0:1,held:0,stale:0,unassignedDate:0,heldReasons:{},...(mode==='bad-preview'?{candidate:'bad'}:mode==='empty'?{}:{candidate})});
    assert.deepEqual(body,{action:'APPEND_ONE',candidate});if(mode==='lost-append')throw Error('lost');return Response.json({action:'APPEND_ONE',servedVersion:version,status:'DONE'});
   }throw Error('unexpected');
  };
  if(['bad-preview','lost-append','bad-backup'].includes(mode))await assert.rejects(runMonthlyReport(env,fetchStub),/MONTHLY_/);else await runMonthlyReport(env,fetchStub);
  const actions=calls.filter(x=>x.url.includes('/admin/stable-sync/monthly-report')).map(x=>JSON.parse(x.options.body).action);
  assert.deepEqual(actions,mode==='bad-backup'?[]:mode==='empty'||mode==='bad-preview'?['PREVIEW']:['PREVIEW','APPEND_ONE']);
 }
});
test('workflow is protected and serial',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/prod-monthly-report.yml',import.meta.url),'utf8');assert.match(workflow,/environment: production/);assert.match(workflow,/group: malipang-release-control/);assert.doesNotMatch(workflow,/candidate_hash/);
});
test('held PREVIEW logs only allowlisted diagnostics and never dispatches a write',async()=>{
 const cases=[
  [{stage:'GRID',cause:'HTTP',httpStatus:403},'MONTHLY_PREVIEW_HELD_STAGE=GRID CAUSE=HTTP HTTP_STATUS=403'],
  [{stage:'GRID',cause:'BODY_TOO_LARGE'},'MONTHLY_PREVIEW_HELD_STAGE=GRID CAUSE=BODY_TOO_LARGE'],
  [{stage:'GRID',cause:'HTTP',httpStatus:400,operation:'GRID_FULL_INITIAL',detail:'INVALID_FIELD',field:'commentAnchors'},'MONTHLY_PREVIEW_HELD_STAGE=GRID CAUSE=HTTP HTTP_STATUS=400 OPERATION=GRID_FULL_INITIAL DETAIL=INVALID_FIELD FIELD=commentAnchors'],
  [{stage:'NOTICE',cause:'CHECK_FAILED'},'MONTHLY_PREVIEW_HELD_STAGE=NOTICE CAUSE=CHECK_FAILED'],
  [{stage:'GRID',cause:'HTTP',httpStatus:403,body:'private data'},null],
  [{stage:'private data',cause:'EXCEPTION'},null],
  [{stage:'GRID',cause:'HTTP',httpStatus:400,operation:'private data',detail:'UNKNOWN'},null],
  [{stage:'GRID',cause:'HTTP',httpStatus:400,operation:'GRID_FULL_INITIAL',detail:'INVALID_FIELD',field:'privateData'},null],
  [{stage:'GRID',cause:'HTTP',httpStatus:999},null]
 ];
 for(const [diagnostic,expected] of cases){
  const actions=[],lines=[],saved=console.log;console.log=(...args)=>lines.push(args.join(' '));
  try{const fetchStub=async(url,options={})=>{
   url=String(url);if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
   if(url==='https://worker.invalid/admin/stable-sync/monthly-report'){const body=JSON.parse(options.body);actions.push(body.action);return Response.json({action:'PREVIEW',servedVersion:version,status:'HELD',diagnostic},{status:409});}
   throw Error('unexpected');
  };
  await assert.rejects(runMonthlyReport({...env,MONTHLY_PHASE:'PREVIEW'},fetchStub),/MONTHLY_PREVIEW_UNVERIFIED/);
  assert.deepEqual(actions,['PREVIEW']);assert.deepEqual(lines,expected?[expected]:[]);assert.doesNotMatch(lines.join(' '),/private data/);
  }finally{console.log=saved;}
 }
});
test('APPEND_ONE stops before dispatch when its fresh PREVIEW is held',async()=>{
 const actions=[],lines=[],saved=console.log;console.log=(...args)=>lines.push(args.join(' '));
 try{
  const fetchStub=async(url,options={})=>{url=String(url);
   if(url.endsWith('/runs/123'))return Response.json(run);
   if(url.endsWith('/runs/123/jobs?per_page=100'))return Response.json({jobs:[job]});
   if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://logs.invalid/log'}});
   if(url==='https://logs.invalid/log')return new Response(log);
   if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
   if(url==='https://worker.invalid/admin/stable-sync/monthly-report'){const body=JSON.parse(options.body);actions.push(body.action);return Response.json({action:'PREVIEW',servedVersion:version,status:'HELD',diagnostic:{stage:'GRID',cause:'CHECK_FAILED'}},{status:409});}
   throw Error('unexpected');
  };
  await assert.rejects(runMonthlyReport(env,fetchStub),/MONTHLY_PREVIEW_UNVERIFIED/);
  assert.deepEqual(actions,['PREVIEW']);assert.deepEqual(lines,['MONTHLY_PREVIEW_HELD_STAGE=GRID CAUSE=CHECK_FAILED']);
 }finally{console.log=saved;}
});
