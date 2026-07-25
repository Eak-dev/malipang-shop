import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupExpiredEvidence} from '../dist/evidence/retention.js';

test('evidence retention is inert while feature flag is disabled',async()=>{
  const env={
    EVIDENCE_RETENTION_ENABLED:'false',
    DB:{prepare(){throw new Error('DB must not be touched while disabled');}},
    EVIDENCE:{async delete(){throw new Error('R2 must not be touched while disabled');}}
  };
  assert.deepEqual(await cleanupExpiredEvidence(env,Date.UTC(2026,6,25)),{enabled:false,attendanceDeleted:0,expenseDeleted:0,errors:0});
});

test('enabled retention deletes bounded D1 candidates and marks audit timestamps',async()=>{
  const deleted=[],updates=[],selectBinds=[];
  const env={
    EVIDENCE_RETENTION_ENABLED:'true',
    EVIDENCE_RETENTION_DAYS:'90',
    EVIDENCE_SHORT_RETENTION_DAYS:'7',
    EVIDENCE_RETENTION_BATCH_SIZE:'50',
    EVIDENCE:{async delete(key){deleted.push(key);}},
    DB:{prepare(sql){
      let args=[];
      return{
        bind(...next){args=next;return this;},
        async all(){
          selectBinds.push({sql,args});
          if(sql.includes('FROM attendance_events'))return{results:[{id:'att_1',key:'attendance/old.jpg'}]};
          if(sql.includes('FROM expense_documents'))return{results:[{id:'doc_1',key:'expense/old.jpg'}]};
          return{results:[]};
        },
        async run(){updates.push({sql,args});return{meta:{changes:1}};}
      };
    }}
  };
  const now=Date.UTC(2026,6,25,12,0,0);
  const result=await cleanupExpiredEvidence(env,now);
  assert.deepEqual(result,{enabled:true,attendanceDeleted:1,expenseDeleted:1,errors:0});
  assert.deepEqual(deleted,['attendance/old.jpg','expense/old.jpg']);
  assert.equal(selectBinds.length,2);
  assert.equal(selectBinds[0].args.at(-1),50);
  assert.equal(selectBinds[1].args.at(-1),50);
  assert.equal(updates.some(item=>item.sql.includes('UPDATE attendance_events SET evidence_deleted_at')),true);
  assert.equal(updates.some(item=>item.sql.includes('UPDATE expense_documents SET evidence_deleted_at')),true);
});

test('failed R2 deletion is recorded as an error and is not marked deleted',async()=>{
  const updates=[];
  const env={
    EVIDENCE_RETENTION_ENABLED:'true',
    EVIDENCE_RETENTION_DAYS:'90',
    EVIDENCE_SHORT_RETENTION_DAYS:'7',
    EVIDENCE_RETENTION_BATCH_SIZE:'10',
    EVIDENCE:{async delete(){throw new Error('temporary R2 failure');}},
    DB:{prepare(sql){let args=[];return{bind(...next){args=next;return this;},async all(){if(sql.includes('FROM attendance_events'))return{results:[{id:'att_1',key:'attendance/old.jpg'}]};if(sql.includes('FROM expense_documents'))return{results:[]};return{results:[]};},async run(){updates.push({sql,args});return{meta:{changes:1}};}};}}
  };
  const result=await cleanupExpiredEvidence(env,Date.UTC(2026,6,25,12,0,0));
  assert.deepEqual(result,{enabled:true,attendanceDeleted:0,expenseDeleted:0,errors:1});
  assert.equal(updates.some(item=>item.sql.includes('UPDATE attendance_events SET evidence_deleted_at')),false);
});
