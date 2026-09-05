import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePersonalUseText} from '../dist/personal-use/text-parser.js';
import {handlePersonalUsePostback,handlePersonalUseText} from '../dist/personal-use/service.js';
import {buildPersonalUseRawSheetValues} from '../dist/sheets/sync.js';
import {OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS,planOwnerMonthClosePersonalUseWrites} from '../dist/sheets/owner-month-close.js';

const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:'B001',employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{canSubmitExpense:true}};
function harness(){
  const state={items:new Map(),queue:[],audits:[],batches:[]};
  const DB={prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},async first(){
    if(sql.includes('WHERE personal_use_id='))return state.items.get(this.args[0])||null;
    if(sql.includes('WHERE message_id='))return [...state.items.values()].find(row=>row.message_id===this.args[0]&&row.line_user_id===this.args[1])||null;
    return null;
  },async run(){
    if(sql.includes('INSERT INTO owner_personal_transactions')){const [id,messageId,lineUserId,type,description,amount,sourceWallet,date,trace,submitted,branch,created,updated]=this.args;if([...state.items.values()].some(row=>row.message_id===messageId))return{meta:{changes:0}};state.items.set(id,{personal_use_id:id,message_id:messageId,line_user_id:lineUserId,transaction_type:type,description,amount_satang:amount,source_wallet:sourceWallet,transaction_date:date,status:'WAITING_CONFIRM',trace_id:trace,submitted_by_employee_id:submitted,branch_id:branch,created_at:created,updated_at:updated,version:1});return{meta:{changes:1}};}
    if(sql.includes("SET status='CONFIRMED'")){const row=state.items.get(this.args[3]);if(!row||row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};row.status='CONFIRMED';return{meta:{changes:1}};}
    if(sql.includes("SET status='CANCELLED'")&&sql.includes("status='WAITING_CONFIRM'")){const row=state.items.get(this.args[1]);if(!row||row.status!=='WAITING_CONFIRM')return{meta:{changes:0}};row.status='CANCELLED';return{meta:{changes:1}};}
    if(sql.includes("SET status='CANCELLED'")&&sql.includes("status='CONFIRMED'")){const row=state.items.get(this.args[1]);if(!row||row.status!=='CONFIRMED')return{meta:{changes:0}};row.status='CANCELLED';row.version+=1;return{meta:{changes:1}};}
    if(sql.includes('owner_personal_transaction_audit')&&sql.includes('SELECT')){if(!state.items.has(this.args.at(-1)))return{meta:{changes:0}};state.audits.push(this.args);return{meta:{changes:1}};}
    if(sql.includes('owner_personal_transaction_audit'))state.audits.push(this.args);
    return{meta:{changes:1}};
  }};},async batch(statements){state.batches.push(statements.map(statement=>statement.sql));const results=[];for(const statement of statements)results.push(await statement.run());return results;}};
  const env={DB,JOB_QUEUE:{async sendBatch(items){state.queue.push(...items);}},SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const text=(messageId,text)=>({source:{type:'user',userId:'U_OWNER'},message:{id:messageId,type:'text',text}});
  const postback=data=>({source:{type:'user',userId:'U_OWNER'},postback:{data}});
  return{state,env,text,postback};
}

test('strict personal-use text requires type, amount, source wallet and description',()=>{
  const parsed=parsePersonalUseText('ส่วนตัว | 40,000 | KBank ร้าน | จ่ายบัตรเครดิต',new Date('2026-09-01T01:00:00Z'));
  assert.deepEqual(parsed,{transactionType:'PERSONAL_USE',amountSatang:4000000,sourceWallet:'SHOP_BANK',description:'จ่ายบัตรเครดิต',transactionDate:'2026-09-01'});
  assert.equal(parsePersonalUseText('ส่วนตัว 40000'),null);
  assert.equal(parsePersonalUseText('ส่วนตัว | 40000 | บัญชีส่วนตัว | ค่าใช้ส่วนตัว'),null);
  assert.equal(parsePersonalUseText('ส่วนตัว | 40000 | KBank ร้าน | ค่าใช้ส่วนตัว | 2026-02-30'),null);
});

test('owner confirmation writes a separate personal-use ledger and enqueues only PERSONAL_USE sync',async()=>{
  const h=harness(),outcome=await handlePersonalUseText(h.env,h.text('msg_personal_1','ส่วนตัว | 40,000 | KBank ร้าน | จ่ายบัตรเครดิต'),'trace_personal',owner);
  assert.equal(outcome,'WAITING_CONFIRM');
  assert.equal(h.state.items.size,1);assert.equal(h.state.queue.length,0);
  assert.equal(h.state.batches[0].length,2);assert.match(h.state.batches[0][1],/CREATE_DRAFT/);
  const id=[...h.state.items.keys()][0];
  await handlePersonalUsePostback(h.env,h.postback(`a=personal_use_confirm&id=${id}`),owner);
  assert.equal(h.state.items.get(id).status,'CONFIRMED');
  assert.equal(h.state.queue.length,1);assert.equal(h.state.queue[0].body.entityType,'PERSONAL_USE');
  assert.equal(h.state.queue[0].body.entityVersion,1);
});

test('repeated confirmation is idempotent and owner undo creates the version-2 sheet update',async()=>{
  const h=harness();
  await handlePersonalUseText(h.env,h.text('msg_personal_undo','ส่วนตัว | 750 | KBank ร้าน | ใช้ส่วนตัว'),'trace_undo',owner);
  const id=[...h.state.items.keys()][0],confirm=h.postback(`a=personal_use_confirm&id=${id}`);
  await handlePersonalUsePostback(h.env,confirm,owner);
  await handlePersonalUsePostback(h.env,confirm,owner);
  assert.equal(h.state.queue.length,1);
  await handlePersonalUsePostback(h.env,h.postback(`a=personal_use_undo&id=${id}`),owner);
  assert.equal(h.state.items.get(id).status,'CANCELLED');
  assert.equal(h.state.items.get(id).version,2);
  assert.equal(h.state.queue.length,2);
  assert.equal(h.state.queue[1].body.entityVersion,2);
});

test('repeated LINE message keeps one draft and one create audit',async()=>{
  const h=harness(),message=h.text('msg_personal_duplicate','ส่วนตัว | 750 | KBank ร้าน | ใช้ส่วนตัว');
  await handlePersonalUseText(h.env,message,'trace_first',owner);
  await handlePersonalUseText(h.env,message,'trace_retry',owner);
  assert.equal(h.state.items.size,1);assert.equal(h.state.audits.length,1);
});

test('return money uses the opposite transaction type and does not touch expense mapping',async()=>{
  const h=harness();await handlePersonalUseText(h.env,h.text('msg_return_1','คืนเงินส่วนตัว | 5000 | เงินสดหน้าร้าน | คืนเงินเข้าร้าน'),'trace_return',owner);
  const row=[...h.state.items.values()][0];assert.equal(row.transaction_type,'PERSONAL_RETURN');assert.equal(row.source_wallet,'CASH_DRAWER');
  assert.deepEqual(buildPersonalUseRawSheetValues({...row,approved_at:'2026-09-01T01:00:00Z'}).slice(0,7),[row.personal_use_id,'PERSONAL_RETURN',row.transaction_date,'คืนเงินเข้าร้าน',5000,'CASH_DRAWER','WAITING_CONFIRM']);
});

test('non-owner cannot create a personal-use ledger entry',async()=>{
  const h=harness(),employee={...owner,role:'EMPLOYEE'};const outcome=await handlePersonalUseText(h.env,h.text('msg_not_owner','ส่วนตัว | 100 | KBank ร้าน | test'),'trace_no',employee);
  assert.equal(outcome,'REJECTED');assert.equal(h.state.items.size,0);
});

test('owner month close formulas are confirmed-only, idempotent and conflict-safe',()=>{
  const blank=OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.map(()=>[]),writes=planOwnerMonthClosePersonalUseWrites(blank);
  assert.deepEqual(writes,OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS);
  assert.equal(planOwnerMonthClosePersonalUseWrites(OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.map(cell=>[cell.value])).length,0);
  for(const cell of OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.filter(cell=>cell.range.startsWith('L')&&cell.value.includes('V52_PERSONAL_USE_RAW'))){
    assert.match(cell.value,/"CONFIRMED"/);assert.doesNotMatch(cell.value,/V52_EXPENSE_RAW/);
  }
  const conflict=OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.map(cell=>[cell.value]);conflict[1]=['=MANUAL_FORMULA()'];
  assert.throws(()=>planOwnerMonthClosePersonalUseWrites(conflict),/LAYOUT_CONFLICT:L6/);
});
