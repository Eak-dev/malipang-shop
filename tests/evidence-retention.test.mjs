import test from 'node:test';
import assert from 'node:assert/strict';
import {auditEvidenceRetention} from '../dist/evidence/retention.js';

test('evidence retention audit is inert while feature flag is disabled',async()=>{
  const env={
    EVIDENCE_RETENTION_ENABLED:'false',
    DB:{prepare(){throw new Error('DB must not be touched while disabled');}},
    EVIDENCE:{async list(){throw new Error('R2 must not be touched while disabled');},async delete(){throw new Error('R2 evidence must never be deleted');}}
  };
  assert.deepEqual(await auditEvidenceRetention(env,Date.UTC(2026,6,25)),{enabled:false,scanned:0,newlyIndexed:0,newlyEligible:0,errors:0});
});

test('enabled audit inventories R2 objects including unlinked uploads and never deletes evidence',async()=>{
  const inserts=[],updates=[],lists=[];
  const objectsByPrefix={
    'attendance/':[{key:'attendance/old.jpg',uploaded:new Date('2026-01-01T00:00:00Z')}],
    'expense/':[{key:'expense/orphan.jpg',uploaded:new Date('2026-01-02T00:00:00Z')}]
  };
  const env={
    EVIDENCE_RETENTION_ENABLED:'true',
    EVIDENCE_RETENTION_DAYS:'90',
    EVIDENCE_SHORT_RETENTION_DAYS:'7',
    EVIDENCE_RETENTION_BATCH_SIZE:'50',
    EVIDENCE:{
      async list(options){lists.push(options);return{objects:objectsByPrefix[options.prefix]||[],truncated:false};},
      async delete(){throw new Error('R2 evidence must never be deleted');}
    },
    DB:{prepare(sql){
      let args=[];
      return{
        bind(...next){args=next;return this;},
        async first(){if(sql.includes('evidence_scan_state'))return null;return null;},
        async run(){
          if(sql.includes('INSERT OR IGNORE INTO evidence_objects')){inserts.push({sql,args});return{meta:{changes:1}};}
          if(sql.includes("evidence_type='attendance'")){updates.push({sql,args});return{meta:{changes:1}};}
          if(sql.includes("evidence_type='expense'")){updates.push({sql,args});return{meta:{changes:1}};}
          return{meta:{changes:1}};
        }
      };
    }}
  };
  const result=await auditEvidenceRetention(env,Date.UTC(2026,6,25,12,0,0));
  assert.deepEqual(result,{enabled:true,scanned:2,newlyIndexed:2,newlyEligible:2,errors:0});
  assert.equal(inserts.some(item=>item.args[0]==='expense/orphan.jpg'),true,'orphaned R2 uploads must be inventoried even without an expense_documents row');
  assert.deepEqual(lists.map(item=>item.prefix),['attendance/','expense/']);
  assert.equal(lists.every(item=>item.limit===50),true);
  assert.equal(updates.length,2);
});

test('truncated R2 scan persists cursor so later runs can reach more objects',async()=>{
  const scanStateWrites=[];
  const env={
    EVIDENCE_RETENTION_ENABLED:'true',
    EVIDENCE_RETENTION_DAYS:'90',
    EVIDENCE_SHORT_RETENTION_DAYS:'7',
    EVIDENCE_RETENTION_BATCH_SIZE:'1',
    EVIDENCE:{
      async list(options){return options.prefix==='attendance/'?{objects:[{key:'attendance/a.jpg',uploaded:new Date('2026-07-25T00:00:00Z')}],truncated:true,cursor:'next-attendance'}:{objects:[],truncated:false};},
      async delete(){throw new Error('R2 evidence must never be deleted');}
    },
    DB:{prepare(sql){let args=[];return{bind(...next){args=next;return this;},async first(){return null;},async run(){if(sql.includes('INSERT INTO evidence_scan_state'))scanStateWrites.push(args);return{meta:{changes:sql.includes('UPDATE evidence_objects')?0:1}};}};}}
  };
  const result=await auditEvidenceRetention(env,Date.UTC(2026,6,25,12,0,0));
  assert.equal(result.scanned,1);
  const attendanceState=scanStateWrites.find(args=>args[0]==='attendance/');
  assert.equal(attendanceState[1],'next-attendance');
});
