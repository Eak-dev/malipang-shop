/** Expected row-relative formulas for a new daily entry. */
export function expectedHelperFormulae(header:number,row:number):Record<string,string>{
  const prior=row-1;
  return {
    I:`=SUM(F${row}:H${row})`,
    J:`=IFERROR(LOOKUP(2,ARRAYFORMULA(1/(($B$${header}:B${prior}=B${row})*ISNUMBER(J$${header}:J${prior}))),J$${header}:J${prior}),$E$${header})-I${row}`,
    R:`=SUM(K${row}:Q${row})`,S:`=J${row}-R${row}`,
    U:`=IF(AND(ISNUMBER(B${row}),ISNUMBER(C${row})),DATE($A$5,B${row},C${row}),"")`
  };
}

/** A sequential balance is accepted only when its predecessor is in the
 * same month and has a value; the caller checks the effective value too. */
export function isAcceptedHelperFormula(header:number,row:number,month:number,name:string,value:unknown,previous:readonly unknown[]):boolean{
  const generated=expectedHelperFormulae(header,row)[name];if(value===generated)return true;
  return name==='J'&&row>header&&value===`=J${row-1}-I${row}`&&Number(previous[1])===month&&previous[9]!==null&&previous[9]!==undefined&&previous[9]!=='';
}

/** A customized subtotal is held rather than rewritten. */
export function hasExpectedMonthlySubtotal(row:readonly unknown[],headerRow:number,totalRow:number):boolean {
  if(!Number.isSafeInteger(headerRow)||!Number.isSafeInteger(totalRow)||headerRow<1||totalRow<=headerRow+1)return false;
  const last=totalRow-1;
  for(const [column,index] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]] as const){
    const sumif=`=SUMIF($B$${headerRow+1}:$B$${last},$B${totalRow},${column}${headerRow+1}:${column}${last})`,sum=`=SUM(${column}${headerRow+1}:${column}${last})`;
    if(row[index]!==sumif&&row[index]!==sum)return false;
  }
  return (row[8]===`=SUM(F${totalRow}:H${totalRow})`||row[8]===`=SUM(I${headerRow+1}:I${last})`)&&row[9]===`=$E$${headerRow}-I${totalRow}`&&(row[17]===`=SUM(K${totalRow}:Q${totalRow})`||row[17]===`=SUM(R${headerRow+1}:R${last})`)&&row[18]===`=J${totalRow}-R${totalRow}`;
}

export interface StableDailyValues {month:number;day:number;description:string;amountColumn:string;amountBaht:number;category:string;sourceWallet:string;}
/** One atomic Sheets batch, touching only inputs, ID and missing helpers. */
export function buildStableEmptyDailyRow(sheetId:number,header:number,row:number,id:string,values:StableDailyValues,missing:string[]):Record<string,unknown>[] {
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(header)||header<1||!Number.isSafeInteger(row)||row<=header||!/^MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isInteger(values.month)||values.month<1||values.month>12||!Number.isInteger(values.day)||values.day<1||values.day>31||!values.description.trim()||!Number.isFinite(values.amountBaht)||values.amountBaht<=0||!values.category.trim()||!values.sourceWallet.trim())throw Error('STABLE_DAILY_INVALID');
 const amount:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},target=amount[values.amountColumn];if(target===undefined)throw Error('STABLE_DAILY_INVALID');
 const cell=(v:string|number)=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}});
 const update=(column:number,cells:unknown[])=>({updateCells:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:column,endColumnIndex:column+cells.length},rows:[{values:cells}],fields:'userEnteredValue'}});
 const requests=[update(1,[cell(values.month),cell(values.day),cell(values.description)]),update(target,[cell(values.amountBaht)]),update(21,[cell(values.category),cell(values.sourceWallet),cell(id)])];
 const formulas=expectedHelperFormulae(header,row),columns:Record<string,number>={I:8,J:9,R:17,S:18,U:20},seen=new Set<string>();
 for(const name of missing){if(!(name in columns)||seen.has(name))throw Error('STABLE_DAILY_INVALID');seen.add(name);requests.push(update(columns[name]!,[{userEnteredValue:{formulaValue:formulas[name]!}}]));}
 return requests;
}
