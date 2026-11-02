/** READ-ONLY diagnostic, deliberately not wired to a writer. A matching signed
 * row is evidence for human review, not permission to mutate a spreadsheet.
 * This module cannot establish a live exclusive fence, prevent an owner edit,
 * consume a one-time approval, or prove who actually reviewed the row. */
import type {Env} from '../types';
import {observeExistingDailyRow} from './daily-row-observer';
import {verifyEnrollmentApproval,type EnrollmentApproval,type SourceExpense} from './daily-row-enrollment';

/** These must be provisioned as trusted worker configuration, never supplied
 * by an HTTP request. A public key only identifies a holder of a private key;
 * a separate owner-verified registration process must bind it to a reviewer. */
export interface InspectorEnv extends Env {
 DAILY_ROW_REVIEWER_ID:string;
 DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64:string;
 DAILY_ROW_SHEET_ID:string;
 DAILY_ROW_APPROVED_PERIOD:string;
}
async function source(env:InspectorEnv,id:string):Promise<SourceExpense|null>{
 const r=await env.DB.prepare(`SELECT expense_id,version,transaction_date,amount_satang,payment_key,status,source_wallet,category,description,message_id FROM expense_events WHERE expense_id=?`).bind(id).first<Record<string,unknown>>();
 if(!r)return null;
 if(typeof r.expense_id!=='string'||typeof r.version!=='number'||typeof r.transaction_date!=='string'||typeof r.amount_satang!=='number'||typeof r.payment_key!=='string'||typeof r.status!=='string'||typeof r.source_wallet!=='string'||typeof r.category!=='string'||typeof r.description!=='string'||typeof r.message_id!=='string')return null;
 return {expenseId:r.expense_id,expenseVersion:r.version,postingDate:r.transaction_date,amountSatang:r.amount_satang,paymentKey:r.payment_key,expenseStatus:r.status,sourceWallet:r.source_wallet,category:r.category,description:r.description,messageId:r.message_id};
}
async function pinnedKey(encoded:string):Promise<CryptoKey>{
 if(typeof encoded!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw new Error('invalid key');
 const decoded=atob(encoded);if(decoded.length!==32||btoa(decoded)!==encoded)throw new Error('invalid key');
 return crypto.subtle.importKey('raw',Uint8Array.from(decoded,c=>c.charCodeAt(0)),{name:'Ed25519'},false,['verify']);
}
/** One entry per invocation bounds Sheets API calls and makes failures precise.
 * The approval's lease fields are verified as signed, but are NOT live lease
 * checks. This result must never be used to authorize any mutation. */
export async function inspectSignedExistingRow(env:InspectorEnv,a:EnrollmentApproval,signature:Uint8Array):Promise<'CONSISTENT_READ_ONLY'|'HELD'>{try{
 if(!a||!Array.isArray(a.entries)||a.entries.length!==1||typeof env.GOOGLE_SPREADSHEET_ID!=='string'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_DAILY||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL||!env.DAILY_ROW_REVIEWER_ID||a.reviewerId!==env.DAILY_ROW_REVIEWER_ID||!/^\d{4}-(0[1-9]|1[0-2])$/.test(env.DAILY_ROW_APPROVED_PERIOD)||!/^\d+$/.test(env.DAILY_ROW_SHEET_ID))return 'HELD';
 const sheetId=Number(env.DAILY_ROW_SHEET_ID);if(!Number.isSafeInteger(sheetId))return 'HELD';
 const e=a.entries[0];if(!e||typeof e.expenseId!=='string'||!e.expenseId||e.expenseId.length>256)return 'HELD';
 const key=await pinnedKey(env.DAILY_ROW_REVIEWER_ED25519_PUBLIC_KEY_BASE64),before=await source(env,e.expenseId);if(!before)return 'HELD';
 const context={spreadsheetId:env.GOOGLE_SPREADSHEET_ID,sheetId,leaseId:a.leaseId,leaseVersion:a.leaseVersion,nowMs:Date.now(),approvedPeriod:env.DAILY_ROW_APPROVED_PERIOD,sourceExpenses:[before]};
 if(!await verifyEnrollmentApproval(a,signature,key,context))return 'HELD';
 const observation=await observeExistingDailyRow(env,{sheetTitle:env.SHEET_EXPENSE_DAILY,sheetId,rowNumber:e.rowNumber,metadataId:e.metadataId,expenseId:e.expenseId,postingDate:e.postingDate,paymentKey:e.paymentKey,serviceAccount:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,expectedHeaderDigest:e.headerDigest,expectedFormulas:e.formulas,expectedLiterals:e.literals});
 if(!observation)return 'HELD';
 const after=await source(env,e.expenseId);if(!after||JSON.stringify(before)!==JSON.stringify(after))return 'HELD';
 context.nowMs=Date.now();context.sourceExpenses=[after];if(!await verifyEnrollmentApproval(a,signature,key,context))return 'HELD';
 return 'CONSISTENT_READ_ONLY';
 }catch{return 'HELD';}}
