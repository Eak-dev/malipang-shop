import { authorize } from "../access/authorization";
import type { StaffActor } from "../access/repository";
import type { Env } from "../types";

export interface ExpenseCaseView{
  expenseId:string;branchId:string|null;submittedByEmployeeId:string|null;status:string;transactionDate:string;amountSatang:number;description:string;documentType:string|null;documentId:string|null;
}

function view(row:Record<string,unknown>):ExpenseCaseView{return{expenseId:String(row.expense_id),branchId:row.branch_id==null?null:String(row.branch_id),submittedByEmployeeId:row.submitted_by_employee_id==null?null:String(row.submitted_by_employee_id),status:String(row.status),transactionDate:String(row.transaction_date),amountSatang:Number(row.amount_satang),description:String(row.description),documentType:row.document_type==null?null:String(row.document_type),documentId:row.document_id==null?null:String(row.document_id)};}

/** V2-ready read layer. It deliberately uses the same StaffActor/RBAC model as LINE. */
export async function listExpenseCases(env:Env,actor:StaffActor,input:{fromDate?:string;toDate?:string;limit?:number}={}):Promise<ExpenseCaseView[]>{
  const canBranch=authorize(actor,"expense.branch.read",{branchId:actor.branchId});
  const capability=canBranch?"expense.branch.read":"expense.self.read";
  if(!authorize(actor,capability,canBranch?{branchId:actor.branchId}:{employeeId:actor.employeeId}))throw new Error("FORBIDDEN");
  const predicates:string[]=["1=1"],args:unknown[]=[];
  if(canBranch&&actor.role!=="OWNER"){predicates.push("e.branch_id=?");args.push(actor.branchId);}
  else if(!canBranch){predicates.push("e.submitted_by_employee_id=?");args.push(actor.employeeId);}
  if(input.fromDate){predicates.push("e.transaction_date>=?");args.push(input.fromDate);}
  if(input.toDate){predicates.push("e.transaction_date<=?");args.push(input.toDate);}
  args.push(Math.max(1,Math.min(200,input.limit||100)));
  const result=await env.DB.prepare(`SELECT e.*,d.document_id,d.document_type FROM expense_events e LEFT JOIN expense_documents d ON d.expense_id=e.expense_id WHERE ${predicates.join(" AND ")} ORDER BY e.created_at DESC LIMIT ?`).bind(...args).all<Record<string,unknown>>();
  return(result.results||[]).map(view);
}

export async function getExpenseCase(env:Env,actor:StaffActor,expenseId:string):Promise<ExpenseCaseView|null>{
  const row=await env.DB.prepare(`SELECT e.*,d.document_id,d.document_type FROM expense_events e LEFT JOIN expense_documents d ON d.expense_id=e.expense_id WHERE e.expense_id=? LIMIT 1`).bind(expenseId).first<Record<string,unknown>>();
  if(!row)return null;
  const resource={employeeId:row.submitted_by_employee_id==null?null:String(row.submitted_by_employee_id),branchId:row.branch_id==null?null:String(row.branch_id)};
  if(!authorize(actor,"expense.branch.read",resource)&&!authorize(actor,"expense.self.read",resource))throw new Error("FORBIDDEN");
  return view(row);
}
