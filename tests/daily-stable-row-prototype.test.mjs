import test from 'node:test';
import assert from 'node:assert/strict';
import {runStableDailyPrototype} from '../dist/sheets/daily-stable-row-prototype.js';
import {stableDailyExpenseKey} from '../dist/sheets/daily-stable-row-plan.js';
import {expectedHelperFormulae} from '../dist/sheets/daily-stable-row-writes.js';

const blank=()=>Array(25).fill(null);
const header=()=>{const row=blank();row[1]=10;row[3]='รายรับทั้งหมดในบัญชี';return row;};
const total=()=>{const row=blank();row[0]='รวม';row[1]=10;return row;};
const previous=()=>{const row=blank();row[1]=10;row[2]=26;row[3]='Previous';row[7]=930;row[21]='marketing';row[22]='บัญชีร้าน';row[23]=stableDailyExpenseKey('exp_a');const f=expectedHelperFormulae(1,2);for(const [i,k] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])row[i]=f[k];return row;};
const values={postingYear:2026,month:10,day:26,description:'New description',amountColumn:'H',amountBaht:930,category:'marketing',sourceWallet:'บัญชีร้าน'};

function portFor(rows){
  const p={rows,metadata:[],intents:new Map(),dispatch:0,moveBeforeWrite:false};
  p.requireExclusiveWriters=async()=>{};
  p.readSheetYear=async()=>2026;
  p.readFormulaSnapshot=async()=>({sheetId:123,body:p.rows.map(row=>[...row])});
  p.readEffectiveSnapshot=async()=>{let balance=50000;return {sheetId:123,body:p.rows.map(row=>{const out=[...row];out[8]=Number(row[5]||0)+Number(row[6]||0)+Number(row[7]||0);out[9]=balance-out[8];balance=out[9];out[17]=[10,11,12,13,14,15,16].reduce((sum,i)=>sum+Number(row[i]||0),0);out[18]=out[9]-out[17];out[20]=46321;return out;})};};
  p.lookupMetadata=async key=>p.metadata.filter(m=>m.key===key).map(m=>({metadataId:m.id,row:p.rows.indexOf(m.anchor)+1}));
  p.reserveMetadataId=async key=>{if(p.intents.has(key))throw new Error('prior attempt requires review');const id=900+p.metadata.length;p.intents.set(key,{id,state:'IN_FLIGHT'});return id;};
  p.beginMetadataUpdate=async(key,id)=>{if(p.intents.has(key))return false;p.intents.set(key,{id,state:'IN_FLIGHT'});return true;};
  p.lookupMetadataAtRow=async row=>p.metadata.filter(m=>p.rows.indexOf(m.anchor)===row-1).map(m=>({metadataId:m.id,row}));
  p.bindMetadataId=async(key,id)=>{const m=p.metadata.find(x=>x.id===id),intent=p.intents.get(key);if(!m||!intent||intent.id!==id||intent.state!=='IN_FLIGHT'||m.key||p.metadata.some(x=>x.key===key))return false;m.key=key;return true;};
  p.finishMetadataIntent=async(key,id,baseline)=>{const intent=p.intents.get(key);if(!intent||intent.id!==id||intent.state!=='IN_FLIGHT')return false;intent.state='VERIFIED';intent.baseline=baseline;return true;};
  p.writeByMetadata=async range=>{
    p.dispatch++;
    if(p.moveBeforeWrite){[p.rows[1],p.rows[2]]=[p.rows[2],p.rows[1]];const f=expectedHelperFormulae(1,3);for(const [i,k] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])p.rows[2][i]=f[k];}
    const found=p.metadata.find(m=>m.id===range.dataFilter.developerMetadataLookup.metadataId);
    if(!found)throw new Error('missing metadata');
    const row=found.anchor;range.values[0].forEach((value,index)=>{if(value!==null)row[index]=value;});
  };
  p.batchUpdate=async requests=>{
    p.dispatch++;
    for(const request of requests){
      if(request.insertDimension){p.rows.splice(request.insertDimension.range.startIndex,0,blank());continue;}
      if(request.createDeveloperMetadata){const meta=request.createDeveloperMetadata.developerMetadata,index=meta.location.dimensionRange.startIndex;p.metadata.push({key:null,id:meta.metadataId,anchor:p.rows[index]});continue;}
      const update=request.updateCells, row=p.rows[update.range.startRowIndex], start=update.range.startColumnIndex;
      update.rows[0].values.forEach((v,i)=>{const value=v.userEnteredValue;row[start+i]=value?value.stringValue??value.numberValue??value.formulaValue??null:null;});
    }
  };
  return p;
}

test('prototype is disabled by default and always disabled in production',async()=>{
  const p=portFor([header(),blank(),total()]);
  assert.deepEqual(await runStableDailyPrototype('production',true,p,{expenseId:'exp_a',postingMonth:10,allowCreate:true},values),{status:'REVIEW',reason:'PROTOTYPE_DISABLED'});
  assert.deepEqual(await runStableDailyPrototype('shadow',false,p,{expenseId:'exp_a',postingMonth:10,allowCreate:true},values),{status:'REVIEW',reason:'PROTOTYPE_DISABLED'});
  assert.equal(p.dispatch,0);
});

test('shadow append writes one row, ID and missing formulas after the last entry',async()=>{
  const p=portFor([header(),previous(),blank(),total()]);
  assert.deepEqual(await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values),{status:'VERIFIED'});
  assert.equal(p.rows[2][23],stableDailyExpenseKey('exp_new'));
  assert.equal(p.rows[2][8],'=SUM(F3:H3)');assert.equal(p.dispatch,1);
});

test('metadata update follows a whole-row move after the last lookup',async()=>{
  const a=previous(),other=blank();other[1]=10;other[2]=7;other[3]='Other';other[7]=1;
  const p=portFor([header(),a,other,total()]);p.metadata=[{key:a[23],id:742,anchor:a}];p.moveBeforeWrite=true;
  assert.deepEqual(await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_a',postingMonth:10,allowCreate:false,expectedPrevious:[...a]},values),{status:'VERIFIED'});
  assert.equal(p.rows[2][3],'New description');assert.equal(p.rows[1][3],'Other');
});

test('duplicate ID and unverified subtotal stop before dispatch',async()=>{
  const a=previous(),p=portFor([header(),a,[...a],total()]);
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_a',postingMonth:10,allowCreate:false,expectedPrevious:[...a]},values)).reason,'DUPLICATE_STABLE_ID');
  const q=portFor([header(),previous(),total()]);
  assert.equal((await runStableDailyPrototype('shadow',true,q,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values)).reason,'SUBTOTAL_PREIMAGE_UNVERIFIED');
  assert.equal(p.dispatch+q.dispatch,0);
});

test('unknown dispatch outcome is held and not retried',async()=>{
  const p=portFor([header(),blank(),total()]);let calls=0;p.batchUpdate=async()=>{calls++;throw new Error('connection lost');};
  assert.deepEqual(await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values),{status:'OUTCOME_UNKNOWN'});
  assert.equal(calls,1);
  assert.equal(p.intents.get(stableDailyExpenseKey('exp_new')).state,'IN_FLIGHT');
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values)).reason,'METADATA_RESERVATION_UNAVAILABLE');
  assert.equal(calls,1,'missing metadata after uncertain dispatch must not cause retry');
});

test('if a row is deleted after a lost response its missing metadata cannot trigger retry',async()=>{
  const p=portFor([header(),blank(),total()]),original=p.batchUpdate;let calls=0;
  p.batchUpdate=async requests=>{calls++;await original(requests);p.rows[1]=blank();p.metadata=[];throw new Error('response lost after commit and deletion');};
  assert.deepEqual(await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values),{status:'OUTCOME_UNKNOWN'});
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values)).reason,'METADATA_RESERVATION_UNAVAILABLE');
  assert.equal(calls,1);
});

test('metadata collision after the atomic batch stays held',async()=>{
  const p=portFor([header(),blank(),total()]),original=p.batchUpdate;
  p.batchUpdate=async requests=>{await original(requests);p.metadata.push({key:null,id:901,anchor:p.rows[1]});};
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values)).reason,'POSTIMAGE_METADATA_UNVERIFIED');
  assert.equal(p.intents.get(stableDailyExpenseKey('exp_new')).state,'IN_FLIGHT');
});

test('cross-year posting is held before dispatch',async()=>{
  const p=portFor([header(),blank(),total()]);
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},{...values,postingYear:2027})).reason,'POSTING_YEAR_MISMATCH');
  assert.equal(p.dispatch,0);
});

test('same-version replay never verifies a changed or wrong helper formula',async()=>{
  const a=previous(),p=portFor([header(),a,total()]);p.metadata=[{key:a[23],id:742,anchor:a}];
  const source={...values,description:'Previous'};
  a[8]='=ROW()';
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_a',postingMonth:10,allowCreate:false,expectedPrevious:[...a],verifyOnly:true},source)).reason,'PREIMAGE_HELPER_UNVERIFIED');
  assert.equal(p.dispatch,0);
});

test('same-version replay holds on a wrong effective date even when inputs match',async()=>{
  const a=previous(),p=portFor([header(),a,total()]),original=p.readEffectiveSnapshot;p.metadata=[{key:a[23],id:742,anchor:a}];
  p.readEffectiveSnapshot=async()=>{const result=await original();result.body[1][20]=46322;return result;};
  const source={...values,description:'Previous'};
  assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_a',postingMonth:10,allowCreate:false,expectedPrevious:[...a],verifyOnly:true},source)).reason,'PREIMAGE_HELPER_VALUE_UNVERIFIED');
  assert.equal(p.dispatch,0);
});

test('wrong effective date or Google formula error cannot be verified',async()=>{
  for(const wrong of [46322,'#VALUE!']){
    const p=portFor([header(),blank(),total()]),original=p.readEffectiveSnapshot;
    p.readEffectiveSnapshot=async()=>{const result=await original();if(p.dispatch)result.body[1][20]=wrong;return result;};
    assert.equal((await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values)).reason,'POSTIMAGE_HELPER_VALUE_UNVERIFIED');
  }
});

test('full month creates identity and checks every subtotal formula and value',async()=>{
  const a=previous(),b=previous();b[23]=stableDailyExpenseKey('exp_b');b[7]=100;
  const subtotal=total();for(const [name,index] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]])subtotal[index]=`=SUMIF($B$2:$B$3,$B4,${name}2:${name}3)`;
  subtotal[8]='=SUM(F4:H4)';subtotal[9]='=$E$1-I4';subtotal[17]='=SUM(K4:Q4)';subtotal[18]='=J4-R4';
  const p=portFor([header(),a,b,subtotal]);
  p.readEffectiveSnapshot=async()=>{let balance=50000,sum=0;return{sheetId:123,body:p.rows.map(row=>{const out=[...row];if(row[0]==='รวม'){for(const i of [4,5,6,10,11,12,13,14,15,16,17])out[i]=0;out[7]=sum;out[8]=sum;out[9]=50000-sum;out[18]=out[9];return out;}const amount=typeof row[7]==='number'?row[7]:0;sum+=amount;out[8]=amount;out[9]=balance-amount;balance=out[9];out[17]=0;out[18]=out[9];out[20]=46321;return out;})};};
  assert.deepEqual(await runStableDailyPrototype('shadow',true,p,{expenseId:'exp_new',postingMonth:10,allowCreate:true},values),{status:'VERIFIED'});
  assert.equal(p.rows.length,5);assert.equal(p.rows[3][23],stableDailyExpenseKey('exp_new'));assert.equal(p.rows[4][7],'=SUMIF($B$2:$B$4,$B5,H2:H4)');
});
