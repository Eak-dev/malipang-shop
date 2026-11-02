import {matchLegacyOwnerProvenance,type LegacyD1Expense,type LegacyDailyIndex,type LegacyDailyMarker,type LegacyOwnerAudit,type LegacyOwnerRole,type LegacyPostingResolver} from "./owner-correction-legacy-provenance";
import type {OwnerCorrectionSheetRow} from "./owner-correction-identity";

export interface LegacyRoleHistoryProof {evidenceId:string;coveredFrom:string;coveredThrough:string;roleHistoryDigest:string}
export interface LegacyD1DiagnosticSheet {
  sheetId:number;lastRow:number;rows:OwnerCorrectionSheetRow[];markers:LegacyDailyMarker[];
  coverage:{rows:"ALL_DAILY_ROWS";markers:"ALL_DOCUMENT_MARKERS"};
}
interface StoredRole extends LegacyOwnerRole {assignmentId:string;status:string}
interface D1Read {expenses:LegacyD1Expense[];audits:LegacyOwnerAudit[];roles:StoredRole[];indexes:LegacyDailyIndex[]}

const queries=[
  "SELECT COUNT(*) AS n FROM expense_events",
  "SELECT expense_id AS expenseId,status,version,updated_at AS updatedAt,approved_at AS approvedAt,reviewed_by_employee_id AS reviewedBy,description,category,amount_satang AS amountSatang,transaction_date AS transactionDate,payment_key AS paymentKey,source_wallet AS sourceWallet FROM expense_events ORDER BY expense_id LIMIT ?",
  "SELECT COUNT(*) AS n FROM expense_audit_log",
  "SELECT audit_id AS auditId,expense_id AS expenseId,actor_employee_id AS actorEmployeeId,action,created_at AS createdAt,after_json AS afterJson FROM expense_audit_log ORDER BY audit_id LIMIT ?",
  "SELECT COUNT(*) AS n FROM staff_roles",
  "SELECT role_assignment_id AS assignmentId,employee_id AS employeeId,role,scope,status,effective_from AS effectiveFrom,effective_to AS effectiveTo FROM staff_roles ORDER BY role_assignment_id LIMIT ?",
  "SELECT COUNT(*) AS n FROM sheet_row_index WHERE sheet_name=?",
  "SELECT entity_key AS entityKey,row_number AS rowNumber FROM sheet_row_index WHERE sheet_name=? ORDER BY entity_key LIMIT ?"
] as const;
const timestamp=(s:unknown):s is string=>typeof s==="string"&&s.length>0&&Number.isFinite(Date.parse(s));

/**
 * Read-only diagnostic input collector. Every query is a fixed SELECT. Caller
 * must provide a trustworthy, independently authenticated history proof and a
 * verifier; no default verifier exists. Counts and two equal reads detect some
 * truncation or drift but do not lock D1, Sheets, or a later use of this result.
 */
export async function readLegacyD1Diagnostic(db:D1Database,sheetName:string,limit:number):Promise<D1Read|null>{
  if(!db||sheetName!=="รายวัน"||!Number.isSafeInteger(limit)||limit<1||limit>50000)return null;
  async function read():Promise<D1Read|null>{
    const stmts=queries.map((sql,i)=>{const stmt=db.prepare(sql);return i===7?stmt.bind(sheetName,limit+1):i===6?stmt.bind(sheetName):i%2===1?stmt.bind(limit+1):stmt;});
    const results=await db.batch<Record<string,unknown>>(stmts);
    if(!Array.isArray(results)||results.length!==queries.length||results.some(r=>!r||r.success!==true||!Array.isArray(r.results)))return null;
    for(let i=0;i<8;i+=2){const countRows=results[i]!.results!,data=results[i+1]!.results!;if(countRows.length!==1||!Number.isSafeInteger(countRows[0]?.n)||Number(countRows[0]!.n)<0||Number(countRows[0]!.n)>limit||Number(countRows[0]!.n)!==data.length)return null;}
    const rawAudits=results[3]!.results!;
    // Legacy rows may lack an actor or JSON; preserve that as missing evidence.
    const audits=rawAudits.map(a=>({...a,actorEmployeeId:a.actorEmployeeId??"",afterJson:a.afterJson??""}));
    return {expenses:results[1]!.results as unknown as LegacyD1Expense[],audits:audits as unknown as LegacyOwnerAudit[],roles:results[5]!.results as unknown as StoredRole[],indexes:results[7]!.results as unknown as LegacyDailyIndex[]};
  }
  try{const first=await read();if(!first)return null;const baseline=JSON.stringify(first),second=await read();return second&&baseline===JSON.stringify(second)?JSON.parse(baseline) as D1Read:null;}catch{return null;}
}

/** No live verifier or Sheets reader is wired to this diagnostic. */
export async function diagnoseLegacyD1Provenance(input:{db:D1Database;sheet:LegacyD1DiagnosticSheet;sheetName:string;limit:number;proof:LegacyRoleHistoryProof|null;digest:(v:string)=>Promise<string>;verifyProof:(proof:LegacyRoleHistoryProof,roles:ReadonlyArray<StoredRole>)=>Promise<boolean>;posting:LegacyPostingResolver}):Promise<{ok:false;reason:string}|{ok:true;result:ReturnType<typeof matchLegacyOwnerProvenance>}>{
  try{
    const {sheet,proof}=input;
    if(!sheet||sheet.coverage?.rows!=="ALL_DAILY_ROWS"||sheet.coverage?.markers!=="ALL_DOCUMENT_MARKERS"||!proof||typeof proof.evidenceId!=="string"||!proof.evidenceId.trim()||!timestamp(proof.coveredFrom)||!timestamp(proof.coveredThrough)||Date.parse(proof.coveredFrom)>Date.parse(proof.coveredThrough)||!/^[a-f0-9]{64}$/.test(proof.roleHistoryDigest)||typeof input.verifyProof!=="function"||typeof input.digest!=="function")return {ok:false,reason:"ROLE_HISTORY_PROOF_REQUIRED"};
    const data=await readLegacyD1Diagnostic(input.db,input.sheetName,input.limit);if(!data)return {ok:false,reason:"D1_READ_INCOMPLETE_OR_UNSTABLE"};
    const ids=new Set<string>();
    for(const r of data.roles){if(!r||typeof r.assignmentId!=="string"||!r.assignmentId||ids.has(r.assignmentId)||typeof r.employeeId!=="string"||!r.employeeId||typeof r.role!=="string"||!r.role||typeof r.scope!=="string"||!r.scope||!timestamp(r.effectiveFrom)||(r.status!=="ACTIVE"&&r.status!=="INACTIVE")||(r.status==="ACTIVE"&&r.effectiveTo!==null)||(r.status==="INACTIVE"&&(!timestamp(r.effectiveTo)||Date.parse(r.effectiveTo)<=Date.parse(r.effectiveFrom))))return {ok:false,reason:"ROLE_HISTORY_INCOMPLETE"};ids.add(r.assignmentId);}
    for(let i=0;i<data.roles.length;i++)for(let j=i+1;j<data.roles.length;j++){const a=data.roles[i]!,b=data.roles[j]!;if(a.employeeId===b.employeeId&&Date.parse(a.effectiveFrom)<(b.effectiveTo===null?Infinity:Date.parse(b.effectiveTo))&&Date.parse(b.effectiveFrom)<(a.effectiveTo===null?Infinity:Date.parse(a.effectiveTo)))return {ok:false,reason:"ROLE_HISTORY_AMBIGUOUS"};}
    if(await input.digest(JSON.stringify(data.roles))!==proof.roleHistoryDigest||await input.verifyProof(proof,JSON.parse(JSON.stringify(data.roles)) as StoredRole[])!==true)return {ok:false,reason:"ROLE_HISTORY_UNVERIFIED"};
    const relevant=new Set(data.expenses.map(e=>e.expenseId));
    for(const audit of data.audits){if((audit.action==="CONFIRM"||audit.action==="EDIT")&&relevant.has(audit.expenseId)&&(!timestamp(audit.createdAt)||Date.parse(audit.createdAt)<Date.parse(proof.coveredFrom)||Date.parse(audit.createdAt)>Date.parse(proof.coveredThrough)))return {ok:false,reason:"ROLE_HISTORY_OUTSIDE_COVERAGE"};}
    const result=matchLegacyOwnerProvenance({sheetId:sheet.sheetId,lastRow:sheet.lastRow,expenses:data.expenses,rows:sheet.rows,markers:sheet.markers,indexes:data.indexes,audits:data.audits,roles:data.roles,coverage:{expenses:"ALL_RELEVANT",rows:"ALL_DAILY_ROWS",markers:"ALL_DOCUMENT_MARKERS",indexes:"ALL_DAILY_INDEXES",audits:"ALL_EXPENSE_AUDITS",roles:"ALL_ROLE_HISTORY"}},input.posting);
    return result.valid?{ok:true,result}:{ok:false,reason:result.reason};
  }catch{return {ok:false,reason:"DIAGNOSTIC_UNAVAILABLE"};}
}
