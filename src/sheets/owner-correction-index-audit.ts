/** This is an offline diagnostic only. A match does not authorize a Sheets write. */
export interface DailyIndexAuditInput {
  sheetName:string;
  sheetId:number;
  /** The complete authoritative set of expense IDs relevant to this sheet. */
  expenseIds:string[];
  /** Every sheet_row_index entry for sheetName, including reservations and unknown keys. */
  mappings:Array<{entityKey:string;rowNumber:number}>;
  /** All document-visible malipang_expense_daily metadata across the entire document. */
  metadata:Array<{metadataId:number;metadataKey:string;metadataValue:string;sheetId:number;rowIndex:number}>;
  coverage:{expenses:"ALL_RELEVANT_EXPENSE_IDS";mappings:"ALL_SHEET_MAPPINGS";metadata:"ALL_DOCUMENT_DAILY_METADATA"};
}

export type DailyIndexAuditStatus="MATCH"|"MOVED"|"MISSING"|"DUPLICATE"|"COLLISION";
export interface DailyIndexAuditEntry {
  expenseId:string;
  status:DailyIndexAuditStatus;
  reasons:string[];
  mappedRows:number[];
  metadataIds:number[];
  metadataRows:number[];
}
export type DailyIndexAuditResult=
  |{valid:false;reason:"INCOMPLETE_COVERAGE"|"INVALID_INPUT"}
  |{valid:true;entries:DailyIndexAuditEntry[];unclassifiedMappings:Array<{entityKey:string;rowNumber:number}>};

/**
 * The coverage declaration is a caller assertion, not proof. Results are a
 * point-in-time comparison and say nothing about values, formulas, human
 * edits, in-flight requests, metadata visibility in other projects, or safe
 * write access. Unknown mappings, including legacy item rows and reservation
 * keys, are returned explicitly and are considered collision occupants.
 */
export function auditDailyExpenseIndex(input:DailyIndexAuditInput):DailyIndexAuditResult {
  if(!input||input.coverage?.expenses!=="ALL_RELEVANT_EXPENSE_IDS"||input.coverage?.mappings!=="ALL_SHEET_MAPPINGS"||input.coverage?.metadata!=="ALL_DOCUMENT_DAILY_METADATA")return {valid:false,reason:"INCOMPLETE_COVERAGE"};
  const {sheetName,sheetId,expenseIds,mappings,metadata}=input;
  const keyOk=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.trim()===value;
  if(!keyOk(sheetName)||!Number.isSafeInteger(sheetId)||sheetId<0||!Array.isArray(expenseIds)||!Array.isArray(mappings)||!Array.isArray(metadata)||expenseIds.some(id=>!keyOk(id))||new Set(expenseIds).size!==expenseIds.length||mappings.some(row=>!row||!keyOk(row.entityKey)||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1)||metadata.some(row=>!row||!Number.isSafeInteger(row.metadataId)||row.metadataId<1||row.metadataKey!=="malipang_expense_daily"||!keyOk(row.metadataValue)||!Number.isSafeInteger(row.sheetId)||row.sheetId<0||!Number.isSafeInteger(row.rowIndex)||row.rowIndex<0))return {valid:false,reason:"INVALID_INPUT"};
  const ids=new Set([...expenseIds,...metadata.map(row=>row.metadataValue)]);
  const entries=[...ids].sort().map(expenseId=>{
    const map=mappings.filter(row=>row.entityKey===expenseId),markers=metadata.filter(row=>row.metadataValue===expenseId);
    const mappedRows=map.map(row=>row.rowNumber).sort((a,b)=>a-b),metadataIds=markers.map(row=>row.metadataId).sort((a,b)=>a-b),metadataRows=markers.filter(row=>row.sheetId===sheetId).map(row=>row.rowIndex+1).sort((a,b)=>a-b);
    const reasons:string[]=[];
    if(map.length>1)reasons.push("DUPLICATE_MAPPING");
    if(markers.length>1)reasons.push("DUPLICATE_EXPENSE_METADATA");
    if(markers.some(marker=>metadata.filter(other=>other.metadataId===marker.metadataId).length>1))reasons.push("DUPLICATE_METADATA_ID");
    const duplicate=reasons.length>0;
    if(markers.some(marker=>marker.sheetId!==sheetId))reasons.push("WRONG_SHEET");
    if(map.some(row=>mappings.some(other=>other!==row&&other.rowNumber===row.rowNumber)))reasons.push("MAPPING_ROW_OCCUPIED");
    if(map.some(row=>metadata.some(marker=>marker.sheetId===sheetId&&marker.rowIndex+1===row.rowNumber&&marker.metadataValue!==expenseId)))reasons.push("MAPPED_ROW_OTHER_METADATA");
    if(markers.some(marker=>marker.sheetId===sheetId&&metadata.some(other=>other!==marker&&other.sheetId===sheetId&&other.rowIndex===marker.rowIndex&&other.metadataValue!==expenseId)))reasons.push("METADATA_ROW_OTHER_METADATA");
    if(markers.some(marker=>marker.sheetId===sheetId&&mappings.some(row=>row.rowNumber===marker.rowIndex+1&&row.entityKey!==expenseId)))reasons.push("METADATA_ROW_OTHER_MAPPING");
    const collision=reasons.length>(duplicate?reasons.filter(reason=>reason.startsWith("DUPLICATE_")).length:0);
    if(!map.length)reasons.push("MAPPING_MISSING");
    if(!markers.length)reasons.push("METADATA_MISSING");
    const status:DailyIndexAuditStatus=duplicate?"DUPLICATE":collision?"COLLISION":!map.length||!markers.length?"MISSING":mappedRows[0]===metadataRows[0]?"MATCH":"MOVED";
    if(status==="MOVED")reasons.push("ROW_NUMBER_CHANGED");
    return {expenseId,status,reasons,mappedRows,metadataIds,metadataRows};
  });
  return {valid:true,entries,unclassifiedMappings:mappings.filter(row=>!ids.has(row.entityKey)).map(row=>({...row})).sort((a,b)=>a.entityKey.localeCompare(b.entityKey)||a.rowNumber-b.rowNumber)};
}
