import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureOwnerCorrectionReport,ownerCorrectionReportMatches} from '../dist/sheets/owner-correction-report-snapshot.js';

const knownFormula='5aa6fbf7b33d26783d2ff0fc58fa385131bc110f5b961416a08d9fe4afb3d203';
const knownFlow='7477383cebb25e383af88b6bb10564bbde0c79a1c898baccf8acc83c588b445f';
const before={expenseId:'exp_synthetic_report',status:'CONFIRMED',transactionDate:'2026-10-28',description:'Driver',amountSatang:200000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'};
const serial=iso=>(Date.parse(`${iso}T00:00:00Z`)-Date.UTC(1899,11,30))/86400000;
function fixture(snapshot=before){
  const categories=Array(12).fill(0),group={general:10,transport:7,cleaning:11,bank_fee:snapshot.transactionDate<'2026-08-01'?11:10}[snapshot.category];categories[group]=snapshot.amountSatang/100;
  const legacy=snapshot.transactionDate<'2026-08-01',clean=[[serial(snapshot.transactionDate),legacy?'LEGACY|8':snapshot.expenseId,snapshot.description,snapshot.amountSatang/100,legacy?(snapshot.sourceWallet==='SHOP_BANK'?'บัญชีร้าน':'ทอน/หน้าร้าน'):snapshot.sourceWallet,snapshot.category,legacy?'LEGACY':'V52_CONFIRMED']];
  const raw=[[snapshot.expenseId,snapshot.transactionDate,snapshot.description,snapshot.amountSatang/100,snapshot.paymentKey,snapshot.sourceWallet,snapshot.category,'CONFIRMED']];
  const daily=Array.from({length:12},()=>[]);daily[4]=[2026];const dailyRow=Array(23).fill(null),amount=snapshot.amountSatang/100,dayNumber=Number(snapshot.transactionDate.slice(-2)),monthNumber=Number(snapshot.transactionDate.slice(5,7)),amountColumn=snapshot.paymentKey==='cash'?6:7;
  Object.assign(dailyRow,{1:monthNumber,2:dayNumber,3:snapshot.description,[amountColumn]:amount,8:amount,17:0,20:serial(snapshot.transactionDate),21:snapshot.category,22:snapshot.sourceWallet==='SHOP_BANK'?'บัญชีร้าน':'ทอน/หน้าร้าน'});daily[7]=dailyRow;
  const flow=Array.from({length:61},(_,i)=>{const date=new Date(Date.UTC(2026,10,1)+i*86400000).toISOString().slice(0,10),active=date===snapshot.transactionDate,n=active?amount:0,count=active?1:0;return [serial(date),n,n,0,active?'ยอดรวมตรง — ยังต้องตรวจรายการ':'ยังไม่พบรายการ / ยังไม่ยืนยัน',count,count];});
  const values=[[[serial(`${snapshot.transactionDate.slice(0,7)}-01`)]],[[amount]],categories.map(n=>[n]),[[legacy?'รอตรวจข้อมูลระบบเดิม':snapshot.sourceWallet==='SHOP_BANK'?amount:0]],clean,raw,[],[['alert']],flow,daily];
  const formulas=[[['formula_0']],Array.from({length:12},(_,i)=>[`formula_${i+1}`]),[['formula_13']],[['formula_14']],[['flow_0']],[['flow_1']],Array.from({length:61},(_,i)=>Array.from({length:6},(_,j)=>`flow_${i}_${j}`)),structuredClone(daily)];
  const ports={formulas:async()=>structuredClone(formulas),values:async()=>structuredClone(values),metadata:async()=>({metadataId:42,metadataKey:'malipang_expense_daily',metadataValue:snapshot.expenseId,sheetId:1,rowIndex:7}),sheetId:async()=>1,digest:async value=>Array.isArray(value)&&typeof value[0]==='string'&&value.length===15?knownFormula:Array.isArray(value)&&value.length===368?knownFlow:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
  return {env:{SHEET_EXPENSE_DAILY:'รายวัน',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ'},values,formulas,ports};
}
test('read-only report snapshot requires the expected formula, current data and stable complete reads',async()=>{
  const f=fixture(),snapshot=await captureOwnerCorrectionReport(f.env,before,42,f.ports);assert.ok(snapshot);assert.equal(snapshot.month,'2026-10');assert.equal(snapshot.category,'general');
  f.values[5].push([...f.values[5][0]]);assert.equal(await captureOwnerCorrectionReport(f.env,before,42,f.ports),null);f.values[5].pop();
  f.values[6].push(['item',before.expenseId]);assert.equal(await captureOwnerCorrectionReport(f.env,before,42,f.ports),null);f.values[6].pop();
  f.formulas[0][0][0]=`formula mentions ${before.expenseId}`;assert.equal(await captureOwnerCorrectionReport(f.env,before,42,f.ports),null);f.formulas[0][0][0]='formula_0';
  let calls=0;f.ports.values=async()=>++calls===1?structuredClone(f.values):[];assert.equal(await captureOwnerCorrectionReport(f.env,before,42,f.ports),null);
});
test('report comparison verifies totals, category allocation, wallet and all other rows',async()=>{
  const old=fixture(),changed=fixture({...before,category:'transport'}),a=await captureOwnerCorrectionReport(old.env,before,42,old.ports),b=await captureOwnerCorrectionReport(changed.env,{...before,category:'transport'},42,changed.ports);
  assert.equal(ownerCorrectionReportMatches(a,b),true);
  assert.equal(ownerCorrectionReportMatches(a,{...b,total:b.total+1}),false);assert.equal(ownerCorrectionReportMatches(a,{...b,bankTotal:0}),false);
  assert.equal(ownerCorrectionReportMatches(a,{...b,categories:a.categories}),false);assert.equal(ownerCorrectionReportMatches(a,{...b,otherRowsDigest:'0'.repeat(64)}),false);
  assert.equal(ownerCorrectionReportMatches(a,{...b,date:'2026-11-01'}),false);
  changed.values[5][0][16]='different-order';const altered=await captureOwnerCorrectionReport(changed.env,{...before,category:'transport'},42,changed.ports);assert.equal(ownerCorrectionReportMatches(a,altered),false);
});
test('report comparison validates amount and funding changes without guessing category',async()=>{
  const old=fixture(),next=fixture({...before,amountSatang:210000,sourceWallet:'CASH_DRAWER',paymentKey:'cash'}),a=await captureOwnerCorrectionReport(old.env,before,42,old.ports),b=await captureOwnerCorrectionReport(next.env,{...before,amountSatang:210000,sourceWallet:'CASH_DRAWER',paymentKey:'cash'},42,next.ports);
  assert.equal(ownerCorrectionReportMatches(a,b),true);assert.equal(ownerCorrectionReportMatches(a,{...b,category:'unclassified'}),false);
});
test('cleaning and legacy bank fees are verified in the report remainder',async()=>{
  for(const [date,category] of [['2026-10-28','cleaning'],['2026-07-15','bank_fee']]){
    const old={...before,transactionDate:date},next={...old,category},a=fixture(old),b=fixture(next),beforeReport=await captureOwnerCorrectionReport(a.env,old,42,a.ports),afterReport=await captureOwnerCorrectionReport(b.env,next,42,b.ports);
    assert.equal(ownerCorrectionReportMatches(beforeReport,afterReport),true);
  }
});

test('daily totals may recalculate but other inputs and formula definitions may not change',async()=>{
  const changed={...before,amountSatang:210000},old=fixture(),next=fixture(changed);
  old.values[9][10]=Array(8).fill(null);old.values[9][10][7]=2000;next.values[9][10]=Array(8).fill(null);next.values[9][10][7]=2100;
  old.formulas[7][10]=Array(8).fill(null);next.formulas[7][10]=Array(8).fill(null);old.formulas[7][10][7]='=SUM(H5:H9)';next.formulas[7][10][7]='=SUM(H5:H9)';
  const a=await captureOwnerCorrectionReport(old.env,before,42,old.ports),b=await captureOwnerCorrectionReport(next.env,changed,42,next.ports);assert.equal(ownerCorrectionReportMatches(a,b),true);
  next.formulas[7][10][7]='=SUM(H4:H9)';const altered=await captureOwnerCorrectionReport(next.env,changed,42,next.ports);assert.equal(ownerCorrectionReportMatches(a,altered),false);
});
test('report snapshots verify both August raw rows and uniquely identified legacy rows',async()=>{
  const august={...before,transactionDate:'2026-08-15'},legacy={...before,transactionDate:'2026-07-15'},a=fixture(august),b=fixture(legacy);
  assert.ok(await captureOwnerCorrectionReport(a.env,august,42,a.ports));const prior=await captureOwnerCorrectionReport(b.env,legacy,42,b.ports);assert.equal(prior.bankTotal,null);assert.equal(prior.bankStatus,'รอตรวจข้อมูลระบบเดิม');
  const next=fixture({...legacy,category:'transport'}),updated=await captureOwnerCorrectionReport(next.env,{...legacy,category:'transport'},42,next.ports);assert.equal(ownerCorrectionReportMatches(prior,updated),true);
  const changed=fixture({...legacy,amountSatang:210000}),amount=await captureOwnerCorrectionReport(changed.env,{...legacy,amountSatang:210000},42,changed.ports);assert.equal(ownerCorrectionReportMatches(prior,amount),false);
  b.values[4][0][5]='fillings';assert.equal(await captureOwnerCorrectionReport(b.env,legacy,42,b.ports),null);
});
test('a private month view uses the same report formulas without changing the visible month',async()=>{
  const f=fixture(),view={correctionId:'owner_correction_synthetic_123',sheetId:50,metadataId:51,title:'__MP_REPORT_owner_correction_synthetic_123_202610',period:'2026-10'},source=f.ports.formulas;let requested=[];
  f.ports.formulas=async(env,ranges)=>{requested=ranges;const base=await source(env,ranges);return [...base,...structuredClone(base.slice(0,3))]};
  assert.ok(await captureOwnerCorrectionReport(f.env,before,42,f.ports,view));assert.ok(requested.some(range=>range.includes(view.title)));
  f.ports.formulas=async(env,ranges)=>{const base=await source(env,ranges),copy=structuredClone(base.slice(0,3));copy[0][0][0]='changed formula';return [...base,...copy]};
  assert.equal(await captureOwnerCorrectionReport(f.env,before,42,f.ports,view),null);
});

test('the flow check must reflect amount changes on both daily and clean rows',async()=>{
  const initial={...before,transactionDate:'2026-11-01'},updated={...initial,amountSatang:210000},old=fixture(initial),next=fixture(updated),a=await captureOwnerCorrectionReport(old.env,initial,42,old.ports),b=await captureOwnerCorrectionReport(next.env,updated,42,next.ports);
  assert.equal(ownerCorrectionReportMatches(a,b),true);
  const stale=structuredClone(b);stale.flow[0].cleanAmount=a.flow[0].cleanAmount;assert.equal(ownerCorrectionReportMatches(a,stale),false);
  const wrongStatus=structuredClone(b);wrongStatus.flow[0].status='ยอดรวมตรง';assert.equal(ownerCorrectionReportMatches(a,wrongStatus),false);
});

test('one verified receipt line keeps its original evidence while its category changes',async()=>{
  const changed={...before,category:'transport'},old=fixture(),next=fixture(changed);
  const detail=(snapshot)=>{const row=Array(17).fill(null);Object.assign(row,{0:'item_qa',1:snapshot.expenseId,2:'doc_qa',4:'vendor',6:'synthetic item',11:2000,13:snapshot.amountSatang/100,14:snapshot.category,16:'CONFIRMED'});return row;};
  old.values[6].push(detail(before));next.values[6].push(detail(changed));
  const a=await captureOwnerCorrectionReport(old.env,before,42,old.ports),b=await captureOwnerCorrectionReport(next.env,changed,42,next.ports);assert.equal(ownerCorrectionReportMatches(a,b),true);
  next.values[6][0][6]='evidence changed';const altered=await captureOwnerCorrectionReport(next.env,changed,42,next.ports);assert.equal(ownerCorrectionReportMatches(a,altered),false);
  next.values[6].push(detail(changed));assert.equal(await captureOwnerCorrectionReport(next.env,changed,42,next.ports),null);
});
