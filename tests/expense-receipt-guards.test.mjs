import test from 'node:test';
import assert from 'node:assert/strict';
import {handleExpenseImage,handleExpensePostback} from '../dist/expense/service.js';
import {expenseSqlite,receipt,imageEvent,receiptReading} from './helpers/expense-sqlite.mjs';
import {createRequire} from 'node:module';
const line=createRequire(import.meta.url)('../dist/line/event-response.js');

const count=(h,table)=>Number(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
const upload=(h,id,doc=receipt(),user='fixture_user',hash=`hash_${id}`)=>handleExpenseImage(h.env,imageEvent(id,user),receiptReading(doc),`fixture/${id}.jpg`,'fixture_trace',hash);
const confirm=(h,id,user='fixture_user')=>handleExpensePostback(h.env,{source:{type:'user',userId:user},postback:{data:`a=expense_confirm&id=${id}`}},{canSubmitExpense:true});

test('SQLite: two message IDs with the same vendor/receipt number and no legal name create one draft',async()=>{
  const h=expenseSqlite();try{
    await upload(h,'image_a');await upload(h,'image_b');
    assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'expense_documents'),1);
    assert.equal(h.queue.length,0);
  }finally{h.close();}
});

test('SQLite: concurrent different-user resubmissions cannot bypass the receipt identity claim',async()=>{
  const h=expenseSqlite();try{
    await Promise.all([upload(h,'image_a',receipt(),'user_a'),upload(h,'image_b',receipt(),'user_b')]);
    assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'expense_documents'),1);
    assert.equal(count(h,'expense_audit_log'),1);
    const row=h.sqlite.prepare('SELECT expense_id,line_user_id FROM expense_events').get();
    await confirm(h,row.expense_id,row.line_user_id);
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
    assert.equal(h.queue.length,1);
  }finally{h.close();}
});

test('SQLite: formatting-only receipt identity changes, image repeats and message retries remain idempotent',async()=>{
  for(const scenario of ['formatting','image','message','legacy']){
    const h=expenseSqlite();try{
      await upload(h,'image_a');
      if(scenario==='legacy')h.sqlite.exec('UPDATE expense_documents SET reference_key=NULL');
      const doc=scenario==='formatting'?receipt({vendor:'  SYNTHETIC   SUPPLIER ',documentNumber:'ＴＥＳＴ-１００'}):receipt();
      await upload(h,scenario==='message'?'image_a':'image_b',doc,'fixture_user',scenario==='image'?'hash_image_a':'new_image_hash');
      assert.equal(count(h,'expense_events'),1,scenario);assert.equal(count(h,'expense_documents'),1,scenario);
      assert.equal(count(h,'expense_audit_log'),1,scenario);assert.equal(h.queue.length,0);
    }finally{h.close();}
  }
});

test('SQLite: near OCR identifiers are held for review, never merged or confirmed twice',async()=>{
  const h=expenseSqlite();try{
    await Promise.all([upload(h,'image_a'),upload(h,'image_b',receipt({documentNumber:'TEST-10O'}))]);
    const rows=h.sqlite.prepare('SELECT expense_id FROM expense_events').all();
    assert.equal(rows.length,2,'preserve separate evidence/drafts; similarity is not a duplicate verdict');
    await Promise.all(rows.map(row=>confirm(h,row.expense_id)));
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_events WHERE status='CONFIRMED'").get().n,0);
    assert.equal(count(h,'expense_documents'),2);assert.equal(count(h,'sync_jobs'),0);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,0);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
});

test('SQLite: a later near-match cannot add a financial effect after the original is confirmed or undone',async()=>{
  for(const undo of [false,true]){
    const h=expenseSqlite();try{
      await upload(h,'image_a');const first=h.sqlite.prepare('SELECT expense_id FROM expense_events').get().expense_id;
      await confirm(h,first);
      if(undo)await handleExpensePostback(h.env,{source:{type:'user',userId:'fixture_user'},postback:{data:`a=expense_undo&id=${first}`}},{canSubmitExpense:true});
      const before=count(h,'sync_jobs');
      await upload(h,'image_b',receipt({documentNumber:'TEST-10O'}));
      const second=h.sqlite.prepare('SELECT expense_id FROM expense_events WHERE expense_id<>?').get(first).expense_id;
      await confirm(h,second);
      assert.equal(h.sqlite.prepare('SELECT status FROM expense_events WHERE expense_id=?').get(second).status,'WAITING_CONFIRM');
      assert.equal(count(h,'sync_jobs'),before);assert.equal(count(h,'expense_documents'),2);
    }finally{h.close();}
  }
});

test('SQLite: editing the final review field cannot bypass the duplicate check',async()=>{
  for(const [field,action,params] of [
    ['date','expense_set_date',{date:'2026-01-20'}],['description','expense_accept_description'],
    ['category','expense_set_category&category=packaging'],['payment','expense_set_payment&payment=cash&source=SHOP_BANK']
  ]){
    const h=expenseSqlite();try{
      await upload(h,'image_a');await upload(h,'image_b',receipt({documentNumber:'TEST-10O'}));
      const second=h.sqlite.prepare("SELECT expense_id FROM expense_events WHERE message_id='image_b'").get().expense_id;
      h.sqlite.prepare('UPDATE expense_documents SET normalized_json=? WHERE expense_id=?').run(JSON.stringify({expenseReview:{requiredFields:[field],confirmedFields:[]}}),second);
      await handleExpensePostback(h.env,{source:{type:'user',userId:'fixture_user'},postback:{data:`a=${action}&id=${second}`,params}},{canSubmitExpense:true});
      assert.equal(h.sqlite.prepare('SELECT status FROM expense_events WHERE expense_id=?').get(second).status,'WAITING_CONFIRM',field);
      assert.equal(count(h,'sync_jobs'),0,field);assert.equal(h.queue.length,0,field);
    }finally{h.close();}
  }
});

test('SQLite: separate receipt identifiers with the same amounts remain separate purchases',async()=>{
  const h=expenseSqlite();try{
    await upload(h,'image_a');await upload(h,'image_b',receipt({documentNumber:'INDEPENDENT-500'}));
    for(const row of h.sqlite.prepare('SELECT expense_id FROM expense_events').all())await confirm(h,row.expense_id);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_events WHERE status='CONFIRMED'").get().n,2);
    assert.equal(count(h,'sync_jobs'),2);assert.equal(count(h,'expense_document_items'),2);
  }finally{h.close();}
});

test('SQLite: duplicate rejection never discloses another submitter identity or receipt details',async()=>{
  const h=expenseSqlite(),messages=[],original=line.respondTextToLineEvent;
  line.respondTextToLineEvent=async(_env,_event,text)=>{messages.push(text);};
  try{
    await upload(h,'image_a',receipt(),'private_owner_a');
    const doc=h.sqlite.prepare('SELECT document_id,expense_id FROM expense_documents').get();
    await upload(h,'image_b',receipt(),'private_owner_b');
    assert.equal(count(h,'expense_events'),1);
    const output=messages.join('\n');assert.match(output,/Duplicate receipt/);
    for(const sensitive of [doc.document_id,doc.expense_id,'private_owner_a','Synthetic supplier','TEST-100'])assert.ok(!output.includes(sensitive));
  }finally{line.respondTextToLineEvent=original;h.close();}
});

test('SQLite: failed confirmation response or queue delivery cannot lose or repeat the committed expense',async()=>{
  for(const failure of ['line','queue']){
    const h=expenseSqlite(),original=line.respondFlexToLineEvent,originalSend=h.env.JOB_QUEUE.sendBatch;
    try{
      await upload(h,'image_a');const id=h.sqlite.prepare('SELECT expense_id FROM expense_events').get().expense_id;
      if(failure==='line')line.respondFlexToLineEvent=async()=>{throw new Error('fixture LINE response failure');};
      else h.env.JOB_QUEUE.sendBatch=async()=>{throw new Error('fixture queue failure');};
      await assert.rejects(confirm(h,id),/fixture/);
      assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
      assert.equal(count(h,'sync_jobs'),1);assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,1);
      line.respondFlexToLineEvent=original;h.env.JOB_QUEUE.sendBatch=originalSend;
      await confirm(h,id);
      assert.equal(count(h,'sync_jobs'),1);assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,1);
    }finally{line.respondFlexToLineEvent=original;h.close();}
  }
});

test('SQLite: resubmitting an exact Online Order keeps its receipt-review hold and hides Save',async()=>{
  const h=expenseSqlite(),messages=[],original=line.respondFlexToLineEvent;
  line.respondFlexToLineEvent=async(_env,_event,message)=>{messages.push(message);};
  try{
    await upload(h,'image_a');
    const online=receipt({documentType:'ONLINE_ORDER',documentNumber:'TEST-10O',orderId:'SYNTHETIC-ORDER-1'});
    await upload(h,'image_b',online);messages.length=0;
    await upload(h,'image_c',online);
    assert.equal(count(h,'expense_events'),2);assert.equal(count(h,'expense_documents'),2);assert.equal(count(h,'sync_jobs'),0);
    const output=JSON.stringify(messages);assert.match(output,/ต้องตรวจใบเสร็จก่อน/);assert.doesNotMatch(output,/expense_confirm|expense_resolve_payment/);
    assert.match(output,/expense_cancel/);
  }finally{line.respondFlexToLineEvent=original;h.close();}
});
