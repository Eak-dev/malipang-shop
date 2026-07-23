import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.MALIPANG_UAT_BASE_URL,tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
if(!base||!tokenFile)throw new Error('MALIPANG_UAT_BASE_URL and MALIPANG_ADMIN_TOKEN_FILE are required');
const token=(await readFile(resolve(tokenFile),'utf8')).trim(),lineUserId='U44444444444444444444444444444444';
const cases=[
  ['uat_cleanup_e02r','exp_8553815a-c51e-4f92-b93f-f65cd4c1b976','expense_undo'],
  ['uat_cleanup_e03','exp_2ed13e90-8c4f-4796-8a40-eed8be3ab85e','expense_undo'],
  ['uat_cleanup_e05','exp_a74943cc-344c-442c-919b-c378994d1d30','expense_undo'],
  ['uat_cleanup_e09','exp_7b3272ff-fd08-481e-bb7b-1bbfc415b3ec','expense_undo'],
  ['uat_cleanup_e02_old','exp_daf1fd2b-66e8-481a-b251-3589aca17c8f','expense_cancel'],
  ['uat_cleanup_e04','exp_08a1ef77-a0ad-4e34-a415-8cc43f32e47a','expense_cancel']
];
const results=[];
for(const [caseId,expenseId,action] of cases){
  const response=await fetch(`${base}/admin/uat/expense/action`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({caseId,expenseId,lineUserId,data:`a=${action}&id=${expenseId}`})});
  const body=await response.json();results.push({caseId,expenseId,status:body.expense?.status||body.error||`HTTP ${response.status}`,ok:response.ok&&body.ok});
}
console.log(JSON.stringify({ok:results.every(item=>item.ok&&item.status==='CANCELLED'),results},null,2));
