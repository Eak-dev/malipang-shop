import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {correctionPostingDate} from "../expense/owner-correction-period-math";
import {findMonthBlocks} from "./daily-expense";
import {planOwnerCorrectionSheet,type CorrectionSheetPlan} from "./owner-correction-plan";
import type {SheetRowMetadata} from "./client";

/** The trusted template must come from a separately verified daily detail row. */
export interface MoveFormulaTemplate{rowNumber:number;values:unknown[]}
export interface MoveCandidateInput{
  before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;sheetId:number;sourceMetadataId:number;
  values:unknown[][];formulas:unknown[][];metadata:SheetRowMetadata[];mappedRows:number[];template:MoveFormulaTemplate;
}

/** Preserve absolute references while comparing formulas at different rows. */
function relativeFormula(value:unknown,rowNumber:number):string|null{
  if(typeof value!=="string"||!value.startsWith("=")||!Number.isSafeInteger(rowNumber)||rowNumber<1)return null;
  let references=0;const normalized=value.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g,(whole,column:string,absolute:string,digits:string)=>{
    if(absolute||Number(digits)!==rowNumber)return whole;references++;return `${column}<ROW>`;
  });
  return references?normalized:null;
}

/**
 * Read-only candidate discovery. Caller must hold the shared write fence,
 * provide complete metadata/index sets and independently re-read the result;
 * this function does not reserve a row or authorize any mutation.
 */
export function findOwnerCorrectionMoveCandidates(input:MoveCandidateInput):CorrectionSheetPlan[]{
  const {before,after,sheetId,sourceMetadataId,values,formulas,metadata,mappedRows,template}=input;
  if(!before||!after||typeof before.expenseId!=="string"||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(sourceMetadataId)||sourceMetadataId<1||!Array.isArray(values)||!Array.isArray(formulas)||!Array.isArray(metadata)||!Array.isArray(mappedRows)||mappedRows.some(row=>!Number.isSafeInteger(row)||row<1)||!template||!Array.isArray(template.values))return [];
  if(new Set(metadata.map(item=>item.metadataId)).size!==metadata.length||metadata.some(item=>!Number.isSafeInteger(item.metadataId)||item.metadataId<1||!Number.isSafeInteger(item.rowIndex)||item.rowIndex<0||!Number.isSafeInteger(item.sheetId)||item.sheetId<0))return [];
  const matches=metadata.filter(item=>item.metadataId===sourceMetadataId&&item.metadataKey==="malipang_expense_daily"&&item.metadataValue===before.expenseId&&item.sheetId===sheetId);
  if(matches.length!==1||metadata.filter(item=>item.metadataKey==="malipang_expense_daily"&&item.metadataValue===before.expenseId).length!==1)return [];
  const source=matches[0]!,sourceRow=source.rowIndex+1,year=Number(values[4]?.[0]);if(!Number.isSafeInteger(year)||year<2000||!values[source.rowIndex])return [];
  if(metadata.some(item=>item.sheetId===sheetId&&item.rowIndex===source.rowIndex&&item.metadataId!==sourceMetadataId&&(item.metadataKey==="malipang_expense_daily"||item.metadataKey==="malipang_correction_reservation")))return [];
  let posting:string;try{posting=correctionPostingDate(after,values.slice(0,3));}catch{return [];}const postingYear=Number(posting.slice(0,4)),postingMonth=Number(posting.slice(5,7));
  if(postingYear!==year)return [];
  const blocks=findMonthBlocks(values),target=blocks.filter(block=>block.month===postingMonth);if(target.length!==1)return [];
  const columns=[8,17,20],expected=columns.map(index=>relativeFormula(template.values[index],template.rowNumber));if(expected.some(value=>value===null))return [];
  const mapped=new Set(mappedRows),out:CorrectionSheetPlan[]=[];
  for(let row=target[0]!.headerRow+1;row<target[0]!.totalRow;row++){
    if(row===sourceRow||mapped.has(row)||metadata.some(item=>item.sheetId===sheetId&&item.rowIndex===row-1))continue;
    const candidate=values[row-1]||[],rowFormulas=formulas[row-1]||[];
    // A formula returning an empty string still owns its cell and must never be overwritten.
    if([0,1,2,3,5,6,7,10,11,12,13,14,15,16,21,22].some(column=>typeof rowFormulas[column]==="string"&&(rowFormulas[column] as string).startsWith("=")))continue;
    if(columns.some((column,index)=>relativeFormula(rowFormulas[column],row)!==expected[index]))continue;
    try{
      const plan=planOwnerCorrectionSheet({before,after,headers:values.slice(0,3),source:{rowNumber:sourceRow,sheetYear:year,metadataExpenseId:source.metadataValue,values:values[source.rowIndex]!},destination:{rowNumber:row,postingYear,postingMonth,values:candidate,hasMetadata:false},blocks});
      if(plan.move)out.push(plan);
    }catch{/* Occupied, mismatched or otherwise unverified rows are skipped. */}
  }
  return out;
}
