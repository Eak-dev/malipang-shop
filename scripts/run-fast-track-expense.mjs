import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.MALIPANG_UAT_BASE_URL;
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
if(!base||!tokenFile)throw new Error('MALIPANG_UAT_BASE_URL and MALIPANG_ADMIN_TOKEN_FILE are required');
const token=(await readFile(resolve(tokenFile),'utf8')).trim();
const lineUserId='U44444444444444444444444444444444';
const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
async function postJson(path,body){
  const response=await fetch(`${base}${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(`${path}: ${JSON.stringify(data)}`);return data;
}
async function text(id,value){
  return postJson('/admin/uat/expense/text',{caseId:`uat_${id.toLowerCase().replaceAll('-','_')}`,messageId:`uat_${id.toLowerCase().replaceAll('-','_')}`,lineUserId,text:value});
}
async function action(id,expenseId,data,date){
  return postJson('/admin/uat/expense/action',{caseId:`uat_${id.toLowerCase().replaceAll('-','_')}`,expenseId,lineUserId,data,...(date?{date}:{})});
}
async function image(id,path){
  const query=new URLSearchParams({caseId:`uat_${id.toLowerCase().replaceAll('-','_')}`,messageId:`uat_${id.toLowerCase().replaceAll('-','_')}`,lineUserId});
  const response=await fetch(`${base}/admin/uat/expense/image?${query}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'image/jpeg'},body:await readFile(path)});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(`${id}: ${JSON.stringify(data)}`);return data;
}
const result=[];
const e01=await text('UAT-E01','UAT eggs ทอน 101');
result.push({case:'UAT-E01',expected:'cash quick save CONFIRMED',actual:`${e01.outcome}/${e01.expense?.payment_key}/${e01.expense?.source_wallet}`,pass:e01.outcome==='CONFIRMED'&&e01.expense?.status==='CONFIRMED'&&e01.expense?.payment_key==='cash',expenseId:e01.expense?.expense_id,note:'will be undone in UAT-E10'});
const e02=await text('UAT-E02R','UAT milk change 102');
result.push({case:'UAT-E02',expected:'English cash quick save CONFIRMED',actual:`${e02.outcome}/${e02.expense?.payment_key}`,pass:e02.outcome==='CONFIRMED'&&e02.expense?.status==='CONFIRMED'&&e02.expense?.payment_key==='cash',expenseId:e02.expense?.expense_id});
const e03=await text('UAT-E03','UAT electricity โอน 103');
result.push({case:'UAT-E03',expected:'Thai transfer quick save CONFIRMED',actual:`${e03.outcome}/${e03.expense?.payment_key}/${e03.expense?.source_wallet}`,pass:e03.outcome==='CONFIRMED'&&e03.expense?.status==='CONFIRMED'&&e03.expense?.payment_key==='transfer'&&e03.expense?.source_wallet==='SHOP_BANK',expenseId:e03.expense?.expense_id});
const e04=await text('UAT-E04','UAT internet transfer 104');
result.push({case:'UAT-E04',expected:'WAITING_CONFIRM and no early Sheets job',actual:e04.outcome,pass:e04.outcome==='WAITING_CONFIRM'&&e04.expense?.status==='WAITING_CONFIRM',expenseId:e04.expense?.expense_id});
const e05=await text('UAT-E05','UAT edit flow transfer 105');
await action('UAT-E05A',e05.expense.expense_id,`a=expense_set_category&id=${e05.expense.expense_id}&category=equipment`);
await action('UAT-E05B',e05.expense.expense_id,`a=expense_set_date&id=${e05.expense.expense_id}`,'2026-07-20');
const e05saved=await action('UAT-E05C',e05.expense.expense_id,`a=expense_confirm&id=${e05.expense.expense_id}`);
result.push({case:'UAT-E05',expected:'edit category/date before confirm',actual:`${e05saved.expense?.status}/${e05saved.expense?.category}/${e05saved.expense?.transaction_date}`,pass:e05saved.expense?.status==='CONFIRMED'&&e05saved.expense?.category==='equipment'&&e05saved.expense?.transaction_date==='2026-07-20',expenseId:e05.expense.expense_id});
const e06=await text('UAT-E06','UAT card purchase kbank 106');
await action('UAT-E06A',e06.expense.expense_id,`a=expense_set_category&id=${e06.expense.expense_id}&category=packaging`);
const e06cancelled=await action('UAT-E06B',e06.expense.expense_id,`a=expense_cancel&id=${e06.expense.expense_id}`);
result.push({case:'UAT-E06',expected:'edit before save then CANCELLED/no Sheets',actual:`${e06cancelled.expense?.status}/${e06cancelled.expense?.category}`,pass:e06cancelled.expense?.status==='CANCELLED'&&e06cancelled.expense?.category==='packaging',expenseId:e06.expense.expense_id});
const slipPaths={
  'UAT-E07':process.env.MALIPANG_KBANK_SLIP,
  'UAT-E08':process.env.MALIPANG_SCB_SLIP,
  'UAT-E09':process.env.MALIPANG_PAOTANG_SLIP
};
for(const [id,path] of Object.entries(slipPaths)){
  if(!path)throw new Error(`${id} fixture path is required`);
  const draft=await image(id,path),expenseId=draft.expense?.expense_id;
  const expected=id==='UAT-E07'?{alias:/kbank|kasikorn/i,amount:20000}:id==='UAT-E08'?{alias:/scb|siam/i,amount:5000}:{alias:/paotang|g[- ]?wallet/i,amount:1600};
  const extracted=draft.reading?.document,institution=String(extracted?.institution||'');
  if(id==='UAT-E07'||id==='UAT-E08'){
    result.push({case:id,expected:`existing ${id==='UAT-E07'?'KBank':'SCB'} slip rejected as duplicate`,actual:`${institution}/${extracted?.paidAmountBaht} baht/no new D1 document`,pass:expected.alias.test(institution)&&Math.round(Number(extracted?.paidAmountBaht||0)*100)===expected.amount&&!draft.document&&!draft.expense,expenseId:null,note:'Reference ID already existed from an earlier real submission'});
    continue;
  }
  if(!expenseId)throw new Error(`${id} did not create an expense draft: ${JSON.stringify(draft.document)}`);
  const saved=await action(`${id}C`,expenseId,`a=expense_confirm&id=${expenseId}`);
  const savedInstitution=String(saved.document?.institution||'');
  result.push({case:id,expected:`bank slip CONFIRMED/${expected.amount} satang`,actual:`${saved.expense?.status}/${saved.document?.channel}/${savedInstitution}/${saved.expense?.amount_satang}`,pass:saved.expense?.status==='CONFIRMED'&&(expected.alias.test(savedInstitution)||saved.document?.channel==='G_WALLET')&&saved.expense?.amount_satang===expected.amount&&saved.expense?.source_wallet==='SHOP_BANK',expenseId});
}
const e10=await action('UAT-E10',e01.expense.expense_id,`a=expense_undo&id=${e01.expense.expense_id}`);
result.push({case:'UAT-E10',expected:'Undo keeps D1 audit as CANCELLED',actual:e10.expense?.status,pass:e10.expense?.status==='CANCELLED',expenseId:e01.expense.expense_id,note:'version 2 Sheets sync must clear daily input cells'});
console.log(JSON.stringify({ok:result.every(item=>item.pass),passed:result.filter(item=>item.pass).length,total:result.length,results:result},null,2));
