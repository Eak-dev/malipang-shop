/** A verified candidate only: this module never reads or writes production data. */
export interface OwnerCorrectionIdentity {
  expenseId:string;
  postingYear:number;
  postingMonth:number;
  postingDay:number;
  description:string;
  amountSatang:number;
  /** Zero-based index in an A:W sheet row. */
  amountColumn:number;
}

export interface OwnerCorrectionSheetRow { rowNumber:number; sheetYear:number; values:unknown[] }
export interface OwnerCorrectionIdentityMatch { expenseId:string; rowNumber:number }

const amountColumns=[5,6,7,10,11,12,13,14,15,16];

function normalizedAmount(value:unknown):number|null{
  if(typeof value!=="number"||!Number.isFinite(value)||value<0)return null;
  const satang=Math.round(value*100);
  return Number.isSafeInteger(satang)&&Math.abs(value*100-satang)<0.000001?satang:null;
}

function matches(candidate:OwnerCorrectionIdentity,row:OwnerCorrectionSheetRow):boolean{
  const v=row.values;
  if(!candidate.expenseId||!candidate.description.trim()||!Number.isInteger(candidate.postingYear)||candidate.postingYear<2000||candidate.postingYear!==row.sheetYear||!Number.isInteger(candidate.postingMonth)||candidate.postingMonth<1||candidate.postingMonth>12||!Number.isInteger(candidate.postingDay)||candidate.postingDay<1||candidate.postingDay>31||!Number.isSafeInteger(candidate.amountSatang)||candidate.amountSatang<=0||!amountColumns.includes(candidate.amountColumn))return false;
  if(String(v[0]??"").trim()!==""||Number(v[1])!==candidate.postingMonth||Number(v[2])!==candidate.postingDay||String(v[3]??"").trim()!==candidate.description.trim())return false;
  if(normalizedAmount(v[candidate.amountColumn])!==candidate.amountSatang)return false;
  return amountColumns.every(col=>col===candidate.amountColumn||v[col]==null||v[col]===""||normalizedAmount(v[col])===0);
}

/** Match only one-to-one identities. Callers must supply the entire relevant
 * expense and row sets; partial sets cannot prove uniqueness. Ambiguous or
 * unverified rows stay unlinked. */
export function findUnambiguousOwnerCorrectionIdentities(candidates:OwnerCorrectionIdentity[],rows:OwnerCorrectionSheetRow[]):OwnerCorrectionIdentityMatch[]{
  const options=candidates.map(candidate=>({candidate,rows:rows.filter(row=>matches(candidate,row))}));
  return options.filter(option=>option.rows.length===1&&options.filter(other=>other.rows.some(row=>row.rowNumber===option.rows[0]!.rowNumber)).length===1)
    .map(option=>({expenseId:option.candidate.expenseId,rowNumber:option.rows[0]!.rowNumber}));
}
