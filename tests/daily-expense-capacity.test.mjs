import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';

const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js');
const {DailySheetCapacityDeferredError,writeConfirmedExpenseToDaily}=require('../dist/sheets/daily-expense.js');
const googleAuth=require('../dist/sheets/google-auth.js');
const syncModule=require('../dist/sheets/sync.js');
const worker=require('../dist/index.js').default;
const migrationNames=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
const copy=value=>JSON.parse(JSON.stringify(value));

class Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){return this.db.prepare(this.sql).get(...this.args)??null;}
  async all(){return{results:this.db.prepare(this.sql).all(...this.args)};}
  async run(){const result=this.db.prepare(this.sql).run(...this.args);return{meta:{changes:Number(result.changes)}};}
}

function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const name of migrationNames)db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const prior=Array(23).fill('');prior[1]=10;prior[2]=1;prior[3]='existing expense';prior[6]=20;prior[8]='=G2*2';prior[17]='=G2+1';prior[21]='ingredients';
  const body=[['',10,'','รายรับทั้งหมดในบัญชี'],prior,['รวม',10,'','']];
  const headers=[Array(23).fill(''),Array(23).fill(''),Array(23).fill('')];
  const env={DB:{prepare(sql){return new Statement(db,sql);}},SHEET_EXPENSE_DAILY:'รายวัน',EXTERNAL_API_TIMEOUT_MS:'15000'};
  const record={expenseId:'exp_fixture_new',transactionDate:'2026-10-05',description:'new expense',amountBaht:30,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients'};
  return{db,body,headers,env,record,close(){db.close();}};
}

function columnIndex(name){let n=0;for(const letter of name)n=n*26+letter.charCodeAt(0)-64;return n-1;}
function applyRange(body,range,values){
  const match=/!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/.exec(range);assert.ok(match,range);
  const row=Number(match[2])-1,start=columnIndex(match[1]),end=columnIndex(match[3]||match[1]);
  for(let column=start;column<=end;column++)body[row][column]=values?values[column-start]:'';
}
function applyExpansion(body,requests,{ignoreClears=false}={}){
  for(const request of requests){
    if(request.insertDimension){const index=request.insertDimension.range.startIndex;body.splice(index,0,Array(23).fill(''));}
    if(request.copyPaste){const source=request.copyPaste.source.startRowIndex,destination=request.copyPaste.destination.startRowIndex;body[destination]=[...body[source]];}
    if(request.repeatCell&&!ignoreClears){const{startRowIndex,startColumnIndex,endColumnIndex}=request.repeatCell.range;for(let column=startColumnIndex;column<endColumnIndex;column++)body[startRowIndex][column]='';}
    if(request.updateCells){const index=request.updateCells.start.rowIndex;body[index][0]=request.updateCells.rows[0].values[0].userEnteredValue.stringValue;}
  }
}
async function withClient(fixture,mutation,run){
  const original={batchGetSheetValues:client.batchGetSheetValues,batchUpdateSpreadsheet:client.batchUpdateSpreadsheet,batchClearValues:client.batchClearValues,batchWriteValues:client.batchWriteValues,getSheetId:client.getSheetId};
  client.batchGetSheetValues=async()=>[copy(fixture.body),copy(fixture.headers)];
  client.getSheetId=async()=>123;
  client.batchUpdateSpreadsheet=async(_env,requests,beforeDispatch)=>{if(beforeDispatch)await beforeDispatch();await mutation(requests);};
  client.batchClearValues=async(_env,ranges)=>{for(const range of ranges)applyRange(fixture.body,range,null);};
  client.batchWriteValues=async(_env,data)=>{for(const write of data)applyRange(fixture.body,write.range,write.values[0]);};
  try{return await run();}finally{Object.assign(client,original);}
}

test('one full October block needs exactly one capacity mutation and preserves its total/formulas',async()=>{
  const h=fixture();let expansions=0;
  try{
    await withClient(h,async requests=>{expansions++;applyExpansion(h.body,requests);},async()=>{
      const placed=await writeConfirmedExpenseToDaily(h.env,h.record);
      assert.equal(placed.row,3);
    });
    assert.equal(expansions,1,'the copied prior input must not force an unbounded expansion loop');
    assert.equal(h.body[1][3],'existing expense');
    assert.equal(h.body[2][3],'new expense');
    assert.equal(h.body[2][8],'=G2*2');
    assert.equal(h.body[3][0],'รวม');
    assert.equal(h.db.prepare("SELECT state FROM daily_sheet_capacity_expansions WHERE month=10").get().state,'COMPLETED');
    assert.equal(h.db.prepare("SELECT row_number FROM sheet_row_index WHERE sheet_name='รายวัน' AND entity_key=?").get(h.record.expenseId).row_number,3);
  }finally{h.close();}
});

test('an ambiguous late insert retains the month fence and marker recovery never inserts twice',async()=>{
  const h=fixture();let delayedWrite,expansions=0;
  try{
    await withClient(h,async requests=>{
      expansions++;
      if(expansions===1){delayedWrite=()=>applyExpansion(h.body,requests);throw new client.SheetsMutationOutcomeUnknownError(new Error('network disconnect'));}
      applyExpansion(h.body,requests);
    },async()=>{
      await assert.rejects(writeConfirmedExpenseToDaily(h.env,h.record),error=>error instanceof DailySheetCapacityDeferredError&&error.delaySeconds>=900);
      assert.equal(h.db.prepare("SELECT COUNT(*) n FROM daily_sheet_capacity_locks WHERE month=10").get().n,1);
      await assert.rejects(writeConfirmedExpenseToDaily(h.env,h.record),error=>error instanceof DailySheetCapacityDeferredError&&error.message.includes('LOCK_BUSY'));
      assert.equal(expansions,1,'the retry must not dispatch a second insert while the first can still arrive');
      delayedWrite();
      h.db.prepare("UPDATE daily_sheet_capacity_locks SET locked_at='2000-01-01T00:00:00.000Z' WHERE month=10").run();
      const placed=await writeConfirmedExpenseToDaily(h.env,h.record);
      assert.equal(placed.row,3);
    });
    assert.equal(expansions,1);
    assert.equal(h.body[2][3],'new expense');
    assert.equal(h.body[3][0],'รวม');
  }finally{h.close();}
});

test('a MAPPED expansion with an already cleared marker completes without inserting twice',async()=>{
  const h=fixture();let expansions=0;
  try{
    h.body.splice(2,0,[...h.body[1]]);
    h.db.prepare("INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES('รายวัน',10,3,'__CAPACITY_MARKER__','MAPPED','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')").run();
    await withClient(h,async requests=>{expansions++;applyExpansion(h.body,requests);},async()=>{
      await assert.rejects(writeConfirmedExpenseToDaily(h.env,h.record),/produced no writable row/);
      assert.equal(h.db.prepare("SELECT state FROM daily_sheet_capacity_expansions WHERE month=10").get().state,'COMPLETED');
      assert.equal(expansions,0);
      const placed=await writeConfirmedExpenseToDaily(h.env,h.record);
      assert.equal(placed.row,4);
    });
    assert.equal(expansions,1);
    assert.equal(h.body[3][3],'new expense');
  }finally{h.close();}
});

test('a malformed expansion fails closed after one mutation rather than exhausting Worker subrequests',async()=>{
  const h=fixture();let expansions=0;
  try{
    await withClient(h,async requests=>{expansions++;applyExpansion(h.body,requests,{ignoreClears:true});},async()=>{
      await assert.rejects(writeConfirmedExpenseToDaily(h.env,h.record),/produced no writable row/);
    });
    assert.equal(expansions,1);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sheet_row_index WHERE entity_key=?").get(h.record.expenseId).n,0);
  }finally{h.close();}
});

test('the local Worker subrequest ceiling is not mistaken for an accepted Sheets write',async()=>{
  const originalFetch=globalThis.fetch,originalAuth=googleAuth.getGoogleAccessToken;
  googleAuth.getGoogleAccessToken=async()=>'fixture-token';
  globalThis.fetch=async()=>{throw new Error('Too many subrequests by single Worker invocation.');};
  try{
    await assert.rejects(client.batchUpdateSpreadsheet({GOOGLE_SPREADSHEET_ID:'fixture',EXTERNAL_API_TIMEOUT_MS:'15000'},[{repeatCell:{}}]),error=>error.message.includes('Too many subrequests')&&!(error instanceof client.SheetsMutationOutcomeUnknownError));
  }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalAuth;}
});

test('capacity deferral replaces the queue delivery without spending DLQ retry budget',async()=>{
  const originalSync=syncModule.syncJob,queued=[],events=[];
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture_new',entityVersion:1,traceId:'trace_fixture'};
  syncModule.syncJob=async()=>{throw new DailySheetCapacityDeferredError('DAILY_CAPACITY_LOCK_BUSY',30);};
  try{
    await worker.queue({queue:'malipang-jobs',messages:[{body:job,attempts:5,ack(){events.push('ack');},retry(){events.push('retry');}}]},
      {JOB_QUEUE:{async send(body,options){queued.push({body,options});}}},{});
    assert.deepEqual(events,['ack']);
    assert.deepEqual(queued,[{body:job,options:{delaySeconds:30}}]);
  }finally{syncModule.syncJob=originalSync;}
});
