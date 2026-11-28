// Local-only synthetic launcher. Never imports credentials or contacts a provider.
// Uses the same mock transport and coordinator as the subprocess crash fixture;
// it is not a production CLI, a Worker integration test, or an external fence.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

if(process.argv.length!==2)throw Error('LOCAL_MOCK_ARGUMENTS_FORBIDDEN');
const dir=mkdtempSync(join(tmpdir(),'malipang-serial-local-'));
try{
 const path=join(dir,'state.sqlite'),child=fileURLToPath(new URL('./serial-runner-kill-child.mjs',import.meta.url));
 // The child constructs its own synthetic env and uses an injected transport;
 // no caller URL, credentials, signing key, or coordinator is accepted.
 const result=spawnSync(process.execPath,[child,path,'mocknormal','first'],{encoding:'utf8',timeout:15000,env:{}});
 if(result.error||result.status!==0)throw Error('LOCAL_MOCK_RUN_FAILED');
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const actions=db.prepare('SELECT action FROM actions ORDER BY rowid').all().map(x=>x.action);
  for(const action of ['OPEN_INITIAL','HANDOVER_ONE','HOLD_RESERVED','MOCK_TRANSFER','RECORD_VERIFIED','CLOSE_MOCK_PARKED'])if(actions.filter(x=>x===action).length!==1)throw Error('LOCAL_MOCK_EVIDENCE_INVALID');
  const ordered=['OPEN_INITIAL','HANDOVER_ONE','HOLD_RESERVED','MOCK_TRANSFER','FINISH_STATUS','READBACK','RECORD_VERIFIED','CLOSE_MOCK_PARKED'];
  let previous=-1;for(const action of ordered){const index=actions.indexOf(action);if(index<=previous)throw Error('LOCAL_MOCK_EVIDENCE_INVALID');previous=index;}
  const round=db.prepare('SELECT * FROM rounds').get(),members=round?JSON.parse(round.members):[],root=db.prepare("SELECT * FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER'").all(),edges=db.prepare("SELECT * FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").all(),handoffs=db.prepare('SELECT * FROM mock_handoffs').all(),receipts=db.prepare('SELECT * FROM mock_receipts').all();
  if(round?.state!=='CLOSED'||members.length!==2||root.length!==1||edges.length!==1||handoffs.length!==1||receipts.length!==1||root[0].entity_key!==members[0]||edges[0].entity_key!==members[1]||handoffs[0].round_id!==round.round_id||handoffs[0].job_id!==members[0]||handoffs[0].next_id!==members[1]||receipts[0].round_id!==round.round_id||receipts[0].job_id!==members[1]||JSON.parse(root[0].after_json).roundId!==round.round_id||JSON.parse(edges[0].after_json).roundId!==round.round_id||!actions.includes('SUCCESS:PILOT_MOCK_ROUND_RECORDED'))throw Error('LOCAL_MOCK_EVIDENCE_INVALID');
  process.stdout.write(JSON.stringify({outcome:'LOCAL_MOCK_ROUND_RECORDED',evidence:'SYNTHETIC_ONLY'})+'\n');
 }finally{db.close();}
}finally{rmSync(dir,{recursive:true,force:true});}
