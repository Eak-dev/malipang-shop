import type {SheetProtectedRange,SheetRowMetadata} from "./client";

export interface CorrectionCellGuard{columnIndex:number;protectedRangeId:number}
export type CorrectionCellGuardInspection={kind:"NONE"|"PARTIAL"|"CONFLICT";guards:CorrectionCellGuard[]}|{kind:"COMPLETE";guards:CorrectionCellGuard[]};
const description=(id:string,col:number)=>`malipang-owner-correction:${id}:${col}`;
const allowed=new Set([1,2,3,5,6,7,10,11,12,13,14,15,16,22]);

/** A cell lock must protect exactly one current row/cell and only the Worker. */
export function inspectOwnerCorrectionCellGuards(input:{correctionId:string;metadata:SheetRowMetadata;columns:number[];ranges:SheetProtectedRange[];serviceAccount:string}):CorrectionCellGuardInspection{
  const {correctionId,metadata,columns,ranges}=input,account=input.serviceAccount.trim().toLowerCase();
  if(!/^owner_correction_[A-Za-z0-9_-]{8,128}$/.test(correctionId)||!account||metadata.metadataKey!=="malipang_expense_daily"||!Number.isSafeInteger(metadata.sheetId)||metadata.sheetId<0||!Number.isSafeInteger(metadata.rowIndex)||metadata.rowIndex<0||!Array.isArray(columns)||!columns.length||new Set(columns).size!==columns.length||columns.some(col=>!allowed.has(col))||!Array.isArray(ranges)||ranges.some(item=>!item.range||item.range.sheetId!==metadata.sheetId))return {kind:"CONFLICT",guards:[]};
  const guards:CorrectionCellGuard[]=[];
  for(const col of columns){
    // A delayed create can land on the old numeric row if someone inserted a
    // row before dispatch. Detect our description anywhere on the sheet so a
    // retry can never create a second guard and leave the wrong row locked.
    const named=ranges.filter(item=>item.description===description(correctionId,col));
    if(named.length>1)return {kind:"CONFLICT",guards};
    const overlaps=ranges.filter(item=>{const r=item.range;if(!r||r.sheetId!==metadata.sheetId)return false;return (r.startRowIndex??0)<=metadata.rowIndex&&(r.endRowIndex??Infinity)>metadata.rowIndex&&(r.startColumnIndex??0)<=col&&(r.endColumnIndex??Infinity)>col;});
    if(named.length===1&&!overlaps.includes(named[0]!))return {kind:"CONFLICT",guards};
    if(overlaps.length>1)return {kind:"CONFLICT",guards};
    if(!overlaps.length)continue;
    const item=overlaps[0]!,r=item.range!,users=item.editors?.users,id=item.protectedRangeId;
    if(item.description!==description(correctionId,col)||r.startRowIndex!==metadata.rowIndex||r.endRowIndex!==metadata.rowIndex+1||r.startColumnIndex!==col||r.endColumnIndex!==col+1||!Number.isSafeInteger(id)||Number(id)<0||item.warningOnly===true||item.requestingUserCanEdit!==true||!Array.isArray(users)||!users.length||!users.every(user=>typeof user==="string"&&user.trim().toLowerCase()===account)||(item.editors?.groups?.length||0)>0||item.editors?.domainUsersCanEdit===true||(item.unprotectedRanges?.length||0)>0)return {kind:"CONFLICT",guards};
    guards.push({columnIndex:col,protectedRangeId:Number(id)});
  }
  if(new Set(guards.map(guard=>guard.protectedRangeId)).size!==guards.length)return {kind:"CONFLICT",guards};
  return {kind:guards.length===columns.length?"COMPLETE":guards.length?"PARTIAL":"NONE",guards};
}

export function buildOwnerCorrectionCellGuards(input:{correctionId:string;metadata:SheetRowMetadata;columns:number[];serviceAccount:string}):unknown[]{
  const state=inspectOwnerCorrectionCellGuards({...input,ranges:[]});if(state.kind!=="NONE")throw new Error("CORRECTION_CELL_GUARD_INVALID");
  return input.columns.map(col=>({addProtectedRange:{protectedRange:{description:description(input.correctionId,col),range:{sheetId:input.metadata.sheetId,startRowIndex:input.metadata.rowIndex,endRowIndex:input.metadata.rowIndex+1,startColumnIndex:col,endColumnIndex:col+1},warningOnly:false,editors:{users:[input.serviceAccount]}}}}));
}
