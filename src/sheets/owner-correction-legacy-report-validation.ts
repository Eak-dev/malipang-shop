/**
 * Read-only comparison against a separately reviewed, trusted policy and an
 * independently reconciled provenance manifest. This is not a release gate:
 * the caller must securely obtain both inputs, perform complete bounded reads,
 * and stop/recheck on subsequent changes. There is deliberately no live policy.
 */
export interface LegacyRangeProtection {
  range?:{sheetId?:number;startRowIndex?:number;endRowIndex?:number;startColumnIndex?:number;endColumnIndex?:number};
  warningOnly?:boolean;requestingUserCanEdit?:boolean;unprotectedRanges?:unknown[];
  editors?:{users?:string[];groups?:string[];domainUsersCanEdit?:boolean};
}
export interface LegacyReportRow {
  row:number;identity:string|null;hasFinancialData:boolean;
  displayCategory:string;displayDescription:string;approvedCategory:string;approvedDescription:string;
}
export interface LegacyApprovedRow {
  row:number;identity:string;kind:"verified_d1"|"owner_attested";evidenceId:string;
  approvedCategory:string;approvedDescription:string;
}
export interface LegacyReportObservation {
  dailySheetId:number;reportSheetId:number;cleanSheetId:number;lastRow:number;
  reportFormulas:string[];cleanFormula:string;rows:LegacyReportRow[];
  dailyProtection:LegacyRangeProtection[];reportProtection:LegacyRangeProtection[];cleanProtection:LegacyRangeProtection[];
}
export interface LegacyReportPolicy {formulaDigest:string;serviceAccount:string}

function protectedArea(id:number,ranges:LegacyRangeProtection[],account:string,startRow:number,endRow:number|undefined,startCol:number,endCol:number):boolean {
  if(!Array.isArray(ranges)||ranges.some(p=>!p.range||p.range.sheetId!==id))return false;
  const overlaps=ranges.filter(p=>{const r=p.range!;return (r.endRowIndex??Infinity)>startRow&&(r.startRowIndex??0)<(endRow??Infinity)&&(r.endColumnIndex??Infinity)>startCol&&(r.startColumnIndex??0)<endCol;});
  if(overlaps.length!==1)return false;
  const p=overlaps[0]!,r=p.range!,e=p.editors,users=e?.users;
  const numbers=[r.startRowIndex??0,r.startColumnIndex??0,...(r.endRowIndex===undefined?[]:[r.endRowIndex]),...(r.endColumnIndex===undefined?[]:[r.endColumnIndex])];
  if(numbers.some(n=>!Number.isSafeInteger(n)||n<0)||p.warningOnly===true||p.requestingUserCanEdit!==true||p.unprotectedRanges?.length||!e||e.domainUsersCanEdit===true||e.groups?.length||!Array.isArray(users)||!users.length||!users.every(x=>typeof x==="string"&&x.trim().toLowerCase()===account))return false;
  return (r.startRowIndex??0)<=startRow&&(endRow===undefined?r.endRowIndex===undefined:(r.endRowIndex??Infinity)>=endRow)&&(r.startColumnIndex??0)<=startCol&&(r.endColumnIndex??Infinity)>=endCol;
}

/** Normalize only the row end in the daily ranges, rejecting shorter or mixed ends. */
export function normalizeLegacyReportFormula(formula:string,lastRow:number):string|null {
  if(typeof formula!=="string"||!formula.startsWith("=")||!Number.isSafeInteger(lastRow)||lastRow<5)return null;
  const ends=new Set<number>();let invalid=false;
  const result=formula.replace(/('รายวัน'!\$?[A-Z]+\$?5:\$?[A-Z]+\$?)(\d+)/g,(_m,prefix:string,endText:string)=>{
    const end=Number(endText);if(!Number.isSafeInteger(end)||end<lastRow)invalid=true;ends.add(end);return `${prefix}<ROW_END>`;
  });
  return invalid||ends.size>1?null:result;
}

/**
 * Returns true only for a stable observation matching supplied evidence. It does
 * not authenticate the policy/manifest or prove that the reader covered all
 * report-affecting inputs; production must establish those independently.
 */
export async function legacyReportMatchesTrustedEvidence(first:LegacyReportObservation,second:LegacyReportObservation,policy:LegacyReportPolicy|null,approvedRows:LegacyApprovedRow[],digest:(v:string)=>Promise<string>):Promise<boolean>{
  try {
    if(!first||!second||!policy||JSON.stringify(first)!==JSON.stringify(second)||!/^[a-f0-9]{64}$/.test(policy.formulaDigest)||typeof policy.serviceAccount!=="string"||!policy.serviceAccount.trim()||!Array.isArray(approvedRows))return false;
    const o=first,account=policy.serviceAccount.trim().toLowerCase(),ids=[o.dailySheetId,o.reportSheetId,o.cleanSheetId];
    if(ids.some(id=>!Number.isSafeInteger(id)||id<0)||new Set(ids).size!==3||!Number.isSafeInteger(o.lastRow)||o.lastRow<5||!Array.isArray(o.reportFormulas)||o.reportFormulas.length!==12||typeof o.cleanFormula!=="string"||!Array.isArray(o.rows)||o.rows.length!==o.lastRow-4)return false;
    if(!protectedArea(o.dailySheetId,o.dailyProtection,account,4,undefined,23,25)||!protectedArea(o.reportSheetId,o.reportProtection,account,23,35,2,3)||!protectedArea(o.cleanSheetId,o.cleanProtection,account,1,2,0,1))return false;
    const normalized=[...o.reportFormulas,o.cleanFormula].map(f=>normalizeLegacyReportFormula(f,o.lastRow));
    if(normalized.some(f=>f===null))return false;
    const report=o.reportFormulas.join("\n"),rawCategory=/'รายวัน'!\$?V\$?5:\$?V\$?\d+/i,rawDescription=/'รายวัน'!\$?D\$?5:\$?D\$?\d+/i;
    if(rawCategory.test(report)||rawDescription.test(report)||rawCategory.test(o.cleanFormula)||!/'รายวัน'!\$?X\$?5:\$?X\$?\d+/i.test(report)||!/'รายวัน'!\$?Y\$?5:\$?Y\$?\d+/i.test(report)||!/'รายวัน'!\$?X\$?5:\$?X\$?\d+/i.test(o.cleanFormula)||!/'รายวัน'!\$?Y\$?5:\$?Y\$?\d+/i.test(o.cleanFormula)||await digest(JSON.stringify(normalized))!==policy.formulaDigest)return false;
    const approved=new Map<number,LegacyApprovedRow>(),identities=new Set<string>(),evidence=new Set<string>();
    for(const row of approvedRows){
      if(!row||!Number.isSafeInteger(row.row)||row.row<5||row.row>o.lastRow||typeof row.identity!=="string"||!row.identity.trim()||typeof row.evidenceId!=="string"||!row.evidenceId.trim()||!["verified_d1","owner_attested"].includes(row.kind)||typeof row.approvedCategory!=="string"||typeof row.approvedDescription!=="string"||approved.has(row.row)||identities.has(row.identity)||evidence.has(row.evidenceId))return false;
      approved.set(row.row,row);identities.add(row.identity);evidence.add(row.evidenceId);
    }
    for(let i=0;i<o.rows.length;i++){
      const row=o.rows[i];if(!row||row.row!==i+5||typeof row.hasFinancialData!=="boolean"||![row.displayCategory,row.displayDescription,row.approvedCategory,row.approvedDescription].every(v=>typeof v==="string"))return false;
      const proof=approved.get(row.row),needsProof=row.hasFinancialData||!!row.displayCategory||!!row.displayDescription||!!row.approvedCategory||!!row.approvedDescription||row.identity!==null;
      if(needsProof){if(!proof||row.identity!==proof.identity||row.approvedCategory!==proof.approvedCategory||row.approvedDescription!==proof.approvedDescription)return false;}
      else if(proof||row.identity!==null)return false;
    }
    return true;
  }catch{return false;}
}
