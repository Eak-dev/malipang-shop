export function buildPersonalUseRawSheetValues(item:Record<string,unknown>):unknown[]{
  const baht=(value:unknown)=>Number(value||0)/100;
  return[item.personal_use_id,item.transaction_type,item.transaction_date,item.description,baht(item.amount_satang),item.source_wallet,item.status,item.message_id,item.trace_id,item.submitted_by_employee_id,item.branch_id,item.approved_at,item.created_at,item.updated_at,item.version];
}
export function buildExpenseRawSheetValues(expense:Record<string,unknown>,document:Record<string,unknown>|null):unknown[]{
  const baht=(value:unknown)=>Number(value||0)/100;
  return[expense.expense_id,expense.transaction_date,expense.description,baht(expense.amount_satang),expense.payment_key,expense.source_wallet,expense.category,expense.status,expense.message_id,expense.trace_id,expense.submitted_by_employee_id,expense.branch_id,document?.document_id,document?.document_type,document?.vendor_name,document?.document_number,document?.order_id];
}
