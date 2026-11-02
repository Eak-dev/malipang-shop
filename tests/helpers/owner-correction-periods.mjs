import {correctionAccountingPeriods,correctionPeriodHeaderDigest} from '../../dist/expense/owner-correction-period-math.js';
export const syntheticCorrectionHeaders=()=>[[],[],[]];
export const syntheticCorrectionHeaderDigest='5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2';
export function syntheticCorrectionReport(snapshot,postingDate=snapshot.transactionDate){
  const amount=snapshot.amountSatang/100,categories=Array(12).fill(0),groups={rent:0,staff:1,ingredients:2,fillings:3,packaging:4,utilities:5,gas:6,transport:7,equipment:8,marketing:9,general:10,bank_fee:snapshot.transactionDate<'2026-08-01'?11:10,cleaning:11};categories[groups[snapshot.category]]=amount;
  const flow=Array.from({length:61},(_,i)=>{const date=new Date(Date.UTC(2026,10,1)+i*86400000).toISOString().slice(0,10),dailyAmount=date===postingDate?amount:0,cleanAmount=date===snapshot.transactionDate?amount:0,difference=dailyAmount-cleanAmount,dailyCount=date===postingDate?1:0,cleanCount=date===snapshot.transactionDate?1:0,status=dailyCount===0&&cleanCount===0?'ยังไม่พบรายการ / ยังไม่ยืนยัน':Math.abs(difference)>0.005?'ยอดไม่ตรง — ตรวจรายการ':dailyCount!==cleanCount?'ยอดรวมตรง จำนวนแถวต่าง — ตรวจ':'ยอดรวมตรง — ยังต้องตรวจรายการ';return{date,dailyAmount,cleanAmount,difference,status,dailyCount,cleanCount};});
  return{month:snapshot.transactionDate.slice(0,7),expenseId:snapshot.expenseId,date:snapshot.transactionDate,postingDate,description:snapshot.description,amountSatang:snapshot.amountSatang,paymentKey:snapshot.paymentKey,wallet:snapshot.sourceWallet,category:snapshot.category,total:amount,categories,bankTotal:snapshot.sourceWallet==='SHOP_BANK'?amount:0,otherRowsDigest:'a'.repeat(64),targetEvidenceDigest:'b'.repeat(64),formulaDigest:'a0527cc06ec7543c6cdf87beff0fea5ed6d2ceeeaee966036e9ca10b86201f75',flowFormulaDigest:'5e49405e4b8d63dc3470610e5c941c5fc105969991b3be85e684bc4e23fe9043',flowAlert:'synthetic',flow};
}
/** Local-only fixture: model explicit owner decisions, never used against production. */
export async function grantSyntheticOpenPeriods(h,id,headers=syntheticCorrectionHeaders()){
  const draft=h.sqlite.prepare('SELECT before_json,after_json,owner_employee_id FROM expense_owner_corrections WHERE correction_id=?').get(id);
  const before=JSON.parse(draft.before_json),after=JSON.parse(draft.after_json),digest=await correctionPeriodHeaderDigest(headers);
  for(const period of correctionAccountingPeriods(before,after,headers))h.sqlite.prepare(`INSERT INTO expense_owner_correction_period_decisions(correction_id,period,header_digest,decision,actor_employee_id,created_at) VALUES(?,?,?,'OPEN',?,'2026-10-28T10:00:00.000Z')`).run(id,period,digest,draft.owner_employee_id);
}
export function grantSyntheticReportView(h,id,before){
  const period=before.transactionDate.slice(0,7),view={correctionId:id,sheetId:50,metadataId:51,title:`__MP_REPORT_${id}_${period.replace('-','')}`,period};
  h.sqlite.prepare(`INSERT INTO expense_owner_correction_report_views(correction_id,expense_id,expense_version,period,sheet_id,sheet_title,metadata_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'ACTIVE','now','now')`).run(id,before.expenseId,before.version,period,view.sheetId,view.title,view.metadataId);
  return view;
}
