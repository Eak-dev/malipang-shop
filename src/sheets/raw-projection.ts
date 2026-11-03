/** Shared RAW value layout. Kept independent of row addressing and I/O. */
export const RAW_PROJECTION_HEADERS={
  EXPENSE:['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID'],
  PERSONAL_USE:['Personal_Use_ID','Transaction_Type','Transaction_Date','Description','Amount_Baht','Source_Wallet','Status','Message_ID','Trace_ID','Submitted_By','Branch_ID','Approved_At','Created_At','Updated_At','Version']
} as const;
const baht=(value:unknown)=>Number(value||0)/100;
export function buildExpenseRawSheetValues(expense:Record<string,unknown>,document:Record<string,unknown>|null):unknown[]{
  return[expense.expense_id,expense.transaction_date,expense.description,baht(expense.amount_satang),expense.payment_key,expense.source_wallet,expense.category,expense.status,expense.message_id,expense.trace_id,expense.submitted_by_employee_id,expense.branch_id,document?.document_id,document?.document_type,document?.vendor_name,document?.document_number,document?.order_id];
}
export function buildPersonalUseRawSheetValues(item:Record<string,unknown>):unknown[]{
  return[item.personal_use_id,item.transaction_type,item.transaction_date,item.description,baht(item.amount_satang),item.source_wallet,item.status,item.message_id,item.trace_id,item.submitted_by_employee_id,item.branch_id,item.approved_at,item.created_at,item.updated_at,item.version];
}
