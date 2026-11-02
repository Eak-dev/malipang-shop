import type {LegacyRangeProtection} from "./owner-correction-legacy-report-validation";

/** Narrow read-only ports match batchGetSheetFormulaValues/getSheetProtectedRanges. */
export interface LegacyReportReaderPorts<E> {
  formulas:(env:E,ranges:string[])=>Promise<unknown[][][]>;
  protection:(env:E,title:string)=>Promise<{sheetId:number;ranges:LegacyRangeProtection[]}>;
}
export interface LegacyReportFormulaProtectionRead {
  dailySheetId:number;reportSheetId:number;cleanSheetId:number;
  reportFormulas:string[];cleanFormula:string;
  dailyProtection:LegacyRangeProtection[];reportProtection:LegacyRangeProtection[];cleanProtection:LegacyRangeProtection[];
}
const reportTitle="04_OWNER_MONTH_CLOSE",cleanTitle="97_EXPENSE_CLEAN",dailyTitle="รายวัน";

/**
 * Read-only evidence collector, not a release gate or protection verdict. The
 * caller must independently supply authenticated policy, full row coverage,
 * row identity and provenance to the validator; no defaults connect to live data.
 * Two identical reads detect some drift, but cannot lock against subsequent edits.
 */
export async function readLegacyReportFormulaProtection<E>(env:E,ports:LegacyReportReaderPorts<E>):Promise<LegacyReportFormulaProtectionRead|null>{
  async function read():Promise<LegacyReportFormulaProtectionRead|null>{
    const [formula,daily,report,clean]=await Promise.all([
      ports.formulas(env,[`'${reportTitle}'!C24:C35`,`'${cleanTitle}'!A2`]),
      ports.protection(env,dailyTitle),ports.protection(env,reportTitle),ports.protection(env,cleanTitle)
    ]);
    if(!Array.isArray(formula)||formula.length!==2||!Array.isArray(formula[0])||formula[0].length!==12||!Array.isArray(formula[1])||formula[1].length!==1)return null;
    const reportFormulas:string[]=[];
    for(const row of formula[0]){if(!Array.isArray(row)||row.length!==1||typeof row[0]!=="string"||!row[0].startsWith("="))return null;reportFormulas.push(row[0]);}
    const cleanRow=formula[1][0];if(!Array.isArray(cleanRow)||cleanRow.length!==1||typeof cleanRow[0]!=="string"||!cleanRow[0].startsWith("="))return null;
    const sheets=[daily,report,clean],ids=sheets.map(s=>s?.sheetId);
    if(ids.some(id=>!Number.isSafeInteger(id)||Number(id)<0)||new Set(ids).size!==3||sheets.some(s=>!Array.isArray(s?.ranges)))return null;
    return {dailySheetId:daily.sheetId,reportSheetId:report.sheetId,cleanSheetId:clean.sheetId,reportFormulas,cleanFormula:cleanRow[0],dailyProtection:daily.ranges,reportProtection:report.ranges,cleanProtection:clean.ranges};
  }
  try{
    const first=await read();if(!first)return null;
    const serialized=JSON.stringify(first),second=await read();
    return second&&serialized===JSON.stringify(second)?JSON.parse(serialized) as LegacyReportFormulaProtectionRead:null;
  }catch{return null;}
}
