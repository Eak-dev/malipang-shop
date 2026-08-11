import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecoveryPlan,CPF_DOCUMENT_NUMBER} from '../scripts/cpf-bounded-recovery.mjs';
import {purchaseExpenseDraft,sellerDocumentCases,toSatang} from '../dist/expense/document.js';
import {documentWithReviewState,purchaseReviewState,unresolvedReviewFields} from '../dist/expense/review-state.js';

const runtime={purchaseExpenseDraft,sellerDocumentCases,toSatang,documentWithReviewState,purchaseReviewState,unresolvedReviewFields};
function normalized(overrides={}){return{documentType:'TAX_INVOICE',vendor:'CPF Global Food Solution PCL',legalVendorName:'CPF Global Food Solution Public Company Limited',documentNumber:CPF_DOCUMENT_NUMBER,orderId:'',documentDate:'2026-08-11',paymentDate:'2026-08-11',paymentTime:'09:30',currency:'THB',subtotalBaht:1425,shippingBaht:0,discountBaht:297,subsidyBaht:0,vatBaht:0,grossAmountBaht:1425,finalPaidAmountBaht:1128,paymentMethod:'Transfer',sourceWalletCandidate:'SHOP_BANK',suggestedDescription:'CPF ingredients',suggestedCategory:'ingredients',confidence:.96,needsReview:false,reviewReasons:[],items:[{sellerKey:'CPF Global Food Solution PCL',productCode:'CPF-1',description:'Food ingredient A',quantity:7,unit:'pack',unitPriceBaht:85,discountBaht:0,lineTotalBaht:595,vatBaht:0,confidence:.96,needsReview:false},{sellerKey:'MaliPang / ship-to customer',productCode:'CPF-2',description:'Food ingredient B',quantity:10,unit:'pack',unitPriceBaht:83,discountBaht:0,lineTotalBaht:830,vatBaht:0,confidence:.96,needsReview:false}],...overrides};}
function snapshot(overrides={}){const doc=normalized(overrides.normalized||{});return{document:{document_id:'doc_cpf',message_id:'msg_cpf',line_user_id:'masked-user',document_type:'TAX_INVOICE',status:'WAITING_REVIEW',expense_id:null,vendor_name:doc.vendor,legal_vendor_name:doc.legalVendorName,document_number:CPF_DOCUMENT_NUMBER,final_paid_satang:112800,gross_amount_satang:142500,normalized_json:JSON.stringify(doc),submitted_by_employee_id:'OWN001',branch_id:'B001',...overrides.document},itemStats:{item_count:2,item_total_satang:142500,linked_item_count:0,...overrides.itemStats},caseStats:{case_count:2,confirmed_case_count:0,linked_case_count:0,...overrides.caseStats},existing:{expense_count:0,amount_date_candidate_count:0,link_count:0,linked_case_count:0,sync_count:0,...overrides.existing}};}
const ids={now:'2026-08-11T10:00:00.000Z',expenseId:'exp_recovered',caseId:'case_recovered',linkId:'link_recovered',auditId:'audit_recovered',traceId:'trace_recovered'};

test('valid retained CPF document creates one auditable WAITING_CONFIRM recovery plan',()=>{
  const plan=buildRecoveryPlan(snapshot(),runtime,ids);
  assert.equal(plan.statements.length,7);
  assert.equal(plan.draft.amountSatang,112800);
  assert.equal(plan.summary.canonical_seller_case_count,1);
  assert.equal(plan.summary.auto_finalized,false);
  assert.equal(plan.summary.sheets_sync_created,false);
  assert.equal(plan.statements[0].params[0],'exp_recovered');
  assert.match(plan.statements[0].sql,/WHERE EXISTS/);
  assert.match(plan.statements[0].sql,/COUNT\(\*\).*expense_document_items/);
  assert.match(plan.statements[0].sql,/NOT EXISTS\(SELECT 1 FROM expense_document_links/);
  assert.equal(plan.statements[2].params[1],'CPF Global Food Solution Public Company Limited');
  assert.match(plan.statements[4].sql,/ON CONFLICT\(document_id,seller_key\)/);
  for(const statement of plan.statements)assert.equal((statement.sql.match(/\?/g)||[]).length,statement.params.length);
});

test('recovery blocks if an Expense or Sheet sync already exists',()=>{
  assert.throws(()=>buildRecoveryPlan(snapshot({existing:{expense_count:1}}),runtime,ids),/existing Expense count mismatch/);
  assert.throws(()=>buildRecoveryPlan(snapshot({existing:{amount_date_candidate_count:1}}),runtime,ids),/same-date amount candidate count mismatch/);
  assert.throws(()=>buildRecoveryPlan(snapshot({existing:{sync_count:1}}),runtime,ids),/existing Sheet sync count mismatch/);
});

test('recovery blocks ambiguous accounting amounts and item totals',()=>{
  assert.throws(()=>buildRecoveryPlan(snapshot({document:{final_paid_satang:142500}}),runtime,ids),/final paid amount mismatch/);
  assert.throws(()=>buildRecoveryPlan(snapshot({itemStats:{item_total_satang:112800}}),runtime,ids),/retained item total mismatch/);
});

test('recovery blocks linked, finalized or non-CPF documents',()=>{
  assert.throws(()=>buildRecoveryPlan(snapshot({document:{expense_id:'exp_existing'}}),runtime,ids),/already has an Expense link/);
  assert.throws(()=>buildRecoveryPlan(snapshot({document:{status:'CONFIRMED'}}),runtime,ids),/retained document status mismatch/);
  assert.throws(()=>buildRecoveryPlan(snapshot({document:{vendor_name:'Other',legal_vendor_name:'Other'}}),runtime,ids),/Retained vendor is not CPF/);
});

test('recovery blocks if updated release still produces multiple seller cases',()=>{
  const unsafeRuntime={...runtime,sellerDocumentCases:()=>[{sellerKey:'A'},{sellerKey:'B'}]};
  assert.throws(()=>buildRecoveryPlan(snapshot(),unsafeRuntime,ids),/canonical seller case count mismatch/);
});
