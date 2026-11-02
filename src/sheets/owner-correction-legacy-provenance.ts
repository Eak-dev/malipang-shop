import {matchesOwnerCorrectionIdentity,type OwnerCorrectionIdentity,type OwnerCorrectionSheetRow} from "./owner-correction-identity";
import {isIsoDate} from "../shared/time";
import type {LegacyApprovedRow} from "./owner-correction-legacy-report-validation";

export interface LegacyD1Expense {expenseId:string;status:string;version:number;updatedAt:string;approvedAt:string|null;reviewedBy:string|null;description:string;category:string;amountSatang:number;transactionDate:string;paymentKey:string;sourceWallet:string}
export interface LegacyOwnerAudit {auditId:string;expenseId:string;actorEmployeeId:string;action:string;createdAt:string;afterJson:string}
export interface LegacyOwnerRole {employeeId:string;role:string;scope:string;effectiveFrom:string;effectiveTo:string|null}
export interface LegacyDailyMarker {metadataId:number;metadataKey:string;metadataValue:string;sheetId:number;rowIndex:number}
export interface LegacyDailyIndex {entityKey:string;rowNumber:number}
export interface LegacyProvenanceInput {
  sheetId:number;lastRow:number;expenses:LegacyD1Expense[];rows:OwnerCorrectionSheetRow[];markers:LegacyDailyMarker[];indexes:LegacyDailyIndex[];audits:LegacyOwnerAudit[];roles:LegacyOwnerRole[];
  /** Assertions by the caller, not proof of complete extraction or consistency. */
  coverage:{expenses:"ALL_RELEVANT";rows:"ALL_DAILY_ROWS";markers:"ALL_DOCUMENT_MARKERS";indexes:"ALL_DAILY_INDEXES";audits:"ALL_EXPENSE_AUDITS";roles:"ALL_ROLE_HISTORY"};
}
export type LegacyPostingResolver=(expense:LegacyD1Expense)=>{postingYear:number;postingMonth:number;postingDay:number;amountColumn:number;wallet:string}|null;
export interface LegacyProvenanceDecision {expenseId:string;rowNumber:number|null;status:"MATCHED_OWNER_AUDIT"|"REVIEW";reasons:string[];approvedRow:LegacyApprovedRow|null}

function validTimestamp(value:unknown):value is string{return typeof value==="string"&&value.length>0&&Number.isFinite(Date.parse(value));}
function auditMatches(expense:LegacyD1Expense,audit:LegacyOwnerAudit,roles:LegacyOwnerRole[]):boolean {
  if(audit.expenseId!==expense.expenseId||!audit.auditId||!audit.actorEmployeeId||!validTimestamp(audit.createdAt)||audit.createdAt!==expense.updatedAt)return false;
  const at=Date.parse(audit.createdAt),ownerRoles=roles.filter(r=>r.employeeId===audit.actorEmployeeId&&r.role==="OWNER"&&r.scope==="ORGANIZATION"&&validTimestamp(r.effectiveFrom)&&Date.parse(r.effectiveFrom)<=at&&(r.effectiveTo===null||(validTimestamp(r.effectiveTo)&&Date.parse(r.effectiveTo)>at)));
  if(ownerRoles.length!==1)return false;
  let after:unknown;try{after=JSON.parse(audit.afterJson);}catch{return false;}
  if(!after||typeof after!=="object"||Array.isArray(after))return false;
  const a=after as Record<string,unknown>;if(a.version!==expense.version||a.status!=="CONFIRMED")return false;
  if(audit.action==="CONFIRM")return expense.approvedAt===audit.createdAt&&expense.reviewedBy===audit.actorEmployeeId;
  return audit.action==="EDIT"&&a.expenseId===expense.expenseId&&a.description===expense.description&&a.category===expense.category&&a.amountSatang===expense.amountSatang&&a.transactionDate===expense.transactionDate&&a.paymentKey===expense.paymentKey&&a.sourceWallet===expense.sourceWallet;
}

/**
 * Offline, fail-closed comparison. Neither the coverage declaration nor the
 * supplied role history and posting resolver authenticate their own inputs.
 * A match assumes intact D1 transaction/audit invariants and is not a release
 * authorization. Any later change requires re-reading and rechecking.
 */
export function matchLegacyOwnerProvenance(input:LegacyProvenanceInput,posting:LegacyPostingResolver):{valid:false;reason:string}|{valid:true;decisions:LegacyProvenanceDecision[]}{
  const c=input?.coverage;
  if(!c||c.expenses!=="ALL_RELEVANT"||c.rows!=="ALL_DAILY_ROWS"||c.markers!=="ALL_DOCUMENT_MARKERS"||c.indexes!=="ALL_DAILY_INDEXES"||c.audits!=="ALL_EXPENSE_AUDITS"||c.roles!=="ALL_ROLE_HISTORY")return {valid:false,reason:"INCOMPLETE_COVERAGE"};
  const {sheetId,lastRow,expenses,rows,markers,indexes,audits,roles}=input;
  if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(lastRow)||lastRow<5||![expenses,rows,markers,indexes,audits,roles].every(Array.isArray)||typeof posting!=="function"||rows.length!==lastRow-4||rows.some((r,i)=>!r||r.rowNumber!==i+5||!Number.isSafeInteger(r.sheetYear)||!Array.isArray(r.values))||expenses.some(e=>!e||typeof e.expenseId!=="string"||!e.expenseId||typeof e.description!=="string"||!e.description.trim()||typeof e.category!=="string"||!e.category||!Number.isSafeInteger(e.version)||e.version<1||!Number.isSafeInteger(e.amountSatang)||e.amountSatang<1||!isIsoDate(e.transactionDate)||!validTimestamp(e.updatedAt)||typeof e.paymentKey!=="string"||!e.paymentKey||typeof e.sourceWallet!=="string"||!e.sourceWallet)||new Set(expenses.map(e=>e.expenseId)).size!==expenses.length||markers.some(m=>!m||!Number.isSafeInteger(m.metadataId)||m.metadataId<1||m.metadataKey!=="malipang_expense_daily"||typeof m.metadataValue!=="string"||!m.metadataValue||!Number.isSafeInteger(m.sheetId)||m.sheetId<0||!Number.isSafeInteger(m.rowIndex)||m.rowIndex<0)||new Set(markers.map(m=>m.metadataId)).size!==markers.length||indexes.some(i=>!i||typeof i.entityKey!=="string"||!i.entityKey||!Number.isSafeInteger(i.rowNumber)||i.rowNumber<1)||audits.some(a=>!a||typeof a.auditId!=="string"||!a.auditId)||new Set(audits.map(a=>a.auditId)).size!==audits.length||roles.some(r=>!r||typeof r.employeeId!=="string"||!r.employeeId||!validTimestamp(r.effectiveFrom)||(r.effectiveTo!==null&&!validTimestamp(r.effectiveTo))))return {valid:false,reason:"INVALID_INPUT"};
  const candidates=expenses.map(expense=>{
    try{const p=posting(expense);if(!p||typeof p.wallet!=="string"||!p.wallet||!Number.isInteger(p.postingYear)||p.postingYear<2000||p.postingYear>9999||!Number.isInteger(p.postingMonth)||p.postingMonth<1||p.postingMonth>12||!Number.isInteger(p.postingDay)||p.postingDay<1||p.postingDay>31||![5,6,7,10,11,12,13,14,15,16].includes(p.amountColumn))return null;const identity:OwnerCorrectionIdentity={expenseId:expense.expenseId,description:expense.description,amountSatang:expense.amountSatang,postingYear:p.postingYear,postingMonth:p.postingMonth,postingDay:p.postingDay,amountColumn:p.amountColumn};return {expense,p,identity,matches:rows.filter(row=>matchesOwnerCorrectionIdentity(identity,row))};}catch{return null;}
  });
  // An unresolved candidate might collide with any otherwise unique row.
  if(candidates.some(candidate=>candidate===null))return {valid:false,reason:"POSTING_POLICY_UNRESOLVED"};
  const resolved=candidates.filter((candidate):candidate is NonNullable<typeof candidate>=>candidate!==null);
  return {valid:true,decisions:resolved.map(candidate=>{
    const e=candidate.expense,reasons:string[]=[];let row:OwnerCorrectionSheetRow|undefined;
    if(e.status!=="CONFIRMED")reasons.push("NOT_CONFIRMED");
    if(candidate.matches.length!==1)reasons.push(candidate.matches.length?"AMBIGUOUS_ROW":"ROW_NOT_FOUND");
    else {row=candidate.matches[0];if(resolved.filter(other=>other.matches.some(r=>r.rowNumber===row!.rowNumber)).length!==1)reasons.push("ROW_SHARED_BY_EXPENSES");}
    const ownedMarkers=markers.filter(m=>m.metadataValue===e.expenseId),ownedIndexes=indexes.filter(i=>i.entityKey===e.expenseId);
    if(!row||ownedMarkers.length!==1||ownedMarkers[0]!.sheetId!==sheetId||ownedMarkers[0]!.rowIndex!==row.rowNumber-1||markers.filter(m=>m.sheetId===sheetId&&m.rowIndex===row!.rowNumber-1).length!==1)reasons.push("MARKER_MISSING_OR_CONFLICT");
    if(!row||ownedIndexes.length!==1||ownedIndexes[0]!.rowNumber!==row.rowNumber||indexes.filter(i=>i.rowNumber===row!.rowNumber).length!==1)reasons.push("INDEX_MISSING_OR_CONFLICT");
    if(row&&(row.values[21]!==e.category||row.values[22]!==candidate.p.wallet))reasons.push("DAILY_CATEGORY_OR_WALLET_MISMATCH");
    if(row&&(row.values[23]!==e.category||row.values[24]!==e.description))reasons.push("APPROVED_SOURCE_MISMATCH");
    const ownerAudits=audits.filter(a=>auditMatches(e,a,roles));if(ownerAudits.length!==1)reasons.push("OWNER_AUDIT_MISSING_OR_AMBIGUOUS");
    const approvedRow=reasons.length||!row?null:{row:row.rowNumber,identity:e.expenseId,kind:"verified_d1" as const,evidenceId:ownerAudits[0]!.auditId,approvedCategory:e.category,approvedDescription:e.description};
    return {expenseId:e.expenseId,rowNumber:row?.rowNumber??null,status:approvedRow?"MATCHED_OWNER_AUDIT" as const:"REVIEW" as const,reasons,approvedRow};
  })};
}
