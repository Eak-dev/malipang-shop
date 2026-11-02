/**
 * Experimental request construction only, not connected to the live worker.
 * Identity attachment and concurrent edits must be proven safe separately.
 */
export interface StableRowValues {
  postingYear: number; month: number; day: number; description: string; amountColumn: string;
  amountBaht: number; category: string; sourceWallet: string;
}
export interface MetadataValueRange {
  dataFilter: { developerMetadataLookup: { metadataId: number } };
  majorDimension: 'ROWS';
  values: Array<Array<string|number|null>>;
}

/**
 * Sheets applies a metadata filter to an entire row. null means skip that
 * cell; '' clears an input cell. Formula and user-owned columns are null.
 * Metadata IDs, unlike metadata keys, are unique per spreadsheet. Never use
 * a key-only DataFilter: a matching filter can update more than one row.
 */
export function buildStableRowMetadataWrite(metadataId:number, values:StableRowValues):MetadataValueRange {
  if (!Number.isSafeInteger(metadataId) || metadataId < 1 || metadataId > 2147483647) throw new Error('INVALID_METADATA_ID');
  if (!Number.isInteger(values.postingYear)||values.postingYear<1900||values.postingYear>9999||!Number.isInteger(values.month)||values.month<1||values.month>12||!Number.isInteger(values.day)||values.day<1||values.day>31) throw new Error('INVALID_DAILY_DATE');
  const date=new Date(Date.UTC(values.postingYear,values.month-1,values.day));
  if(date.getUTCFullYear()!==values.postingYear||date.getUTCMonth()+1!==values.month||date.getUTCDate()!==values.day)throw new Error('INVALID_DAILY_DATE');
  if (!values.description.trim()||!Number.isFinite(values.amountBaht)||values.amountBaht<=0||!values.category.trim()||!values.sourceWallet.trim()) throw new Error('INVALID_DAILY_VALUES');
  const amountColumns:Record<string,number> = {F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};
  const amountIndex=amountColumns[values.amountColumn];if(amountIndex===undefined)throw new Error('INVALID_DAILY_AMOUNT_COLUMN');
  const row:Array<string|number|null> = Array(25).fill(null);
  row[1]=values.month;row[2]=values.day;row[3]=values.description;
  for(const index of Object.values(amountColumns))row[index]='';
  row[amountIndex]=values.amountBaht;row[21]=values.category;row[22]=values.sourceWallet;
  return {dataFilter:{developerMetadataLookup:{metadataId}},majorDimension:'ROWS',values:[row]};
}

/** Exact prior formulas are required: do not overwrite a customized total. */
export function hasExpectedMonthlySubtotal(row:readonly unknown[],headerRow:number,totalRow:number):boolean {
  if(!Number.isSafeInteger(headerRow)||!Number.isSafeInteger(totalRow)||headerRow<1||totalRow<=headerRow+1)return false;
  const last=totalRow-1;
  for(const [column,index] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]] as const){
    if(row[index]!==`=SUMIF($B$${headerRow+1}:$B$${last},$B${totalRow},${column}${headerRow+1}:${column}${last})`)return false;
  }
  return row[8]===`=SUM(F${totalRow}:H${totalRow})`&&row[9]===`=$E$${headerRow}-I${totalRow}`&&row[17]===`=SUM(K${totalRow}:Q${totalRow})`&&row[18]===`=J${totalRow}-R${totalRow}`;
}

export function expectedHelperFormulae(header:number,row:number):Record<string,string>{
  const prior=row-1;
  return {
    I:`=SUM(F${row}:H${row})`,
    J:`=IFERROR(LOOKUP(2,ARRAYFORMULA(1/(($B$${header}:B${prior}=B${row})*ISNUMBER(J$${header}:J${prior}))),J$${header}:J${prior}),$E$${header})-I${row}`,
    R:`=SUM(K${row}:Q${row})`,S:`=J${row}-R${row}`,
    U:`=IF(AND(ISNUMBER(B${row}),ISNUMBER(C${row})),DATE($A$5,B${row},C${row}),"")`
  };
}

/** Existing sequential J formulas are safe only with a same-month previous
 * row. The caller must additionally verify that row's effective J is numeric. */
export function isAcceptedHelperFormula(header:number,row:number,month:number,name:string,value:unknown,previous:readonly unknown[]):boolean{
  const generated=expectedHelperFormulae(header,row)[name];if(value===generated)return true;
  return name==='J'&&row>header+1&&value===`=J${row-1}-I${row}`&&Number(previous[1])===month&&previous[9]!==null&&previous[9]!==undefined&&previous[9]!=='';
}

/** Build a narrow write for an independently verified blank row, in one batch. */
export function buildStableEmptyRowAppend(sheetId:number,headerRow:number,row:number,stableKey:string,values:StableRowValues,missingFormulaColumns:string[],blockMonth:number,metadataId:number):Array<Record<string,unknown>> {
  if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(headerRow)||headerRow<1||!Number.isSafeInteger(row)||row<=headerRow)throw new Error('INVALID_MONTH_LAYOUT');
  if(!/^MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}$/.test(stableKey))throw new Error('INVALID_STABLE_KEY');
  if(values.month!==blockMonth)throw new Error('POSTING_MONTH_MISMATCH');
  if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw new Error('INVALID_METADATA_ID');
  buildStableRowMetadataWrite(1,values);
  const colNames=['F','G','H','K','L','M','N','O','P','Q'],idx=colNames.indexOf(values.amountColumn),target=[5,6,7,10,11,12,13,14,15,16][idx]!;
  const cell=(v:string|number)=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}});
  const request=(start:number,data:Array<{userEnteredValue:Record<string,string|number>}>)=>({updateCells:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:start,endColumnIndex:start+data.length},rows:[{values:data}],fields:'userEnteredValue'}});
  const requests:Array<Record<string,unknown>>=[request(1,[cell(values.month),cell(values.day),cell(values.description)]),request(target,[cell(values.amountBaht)]),request(21,[cell(values.category),cell(values.sourceWallet),cell(stableKey)])];
  const formulas=expectedHelperFormulae(headerRow,row),columns:Record<string,number>={I:8,J:9,R:17,S:18,U:20};
  const seen=new Set<string>();
  for(const name of missingFormulaColumns){if(!(name in columns)||seen.has(name))throw new Error('INVALID_MISSING_FORMULA');seen.add(name);requests.push(request(columns[name]!,[{userEnteredValue:{formulaValue:formulas[name]!}}]));}
  // The ID must be durably reserved before dispatch and journaled against the
  // expense; a repeated atomic batch is rejected while this metadata exists.
  requests.push({createDeveloperMetadata:{developerMetadata:{metadataId,metadataKey:'e',location:{dimensionRange:{sheetId,dimension:'ROWS',startIndex:row-1,endIndex:row}},visibility:'DOCUMENT'}}});
  return requests;
}

/**
 * Experimental monthly expansion request. The caller must prove that the
 * complete month snapshot, subtotal formula preimages, and writer cutover are
 * still valid before dispatch; this builder itself provides no Sheets CAS.
 * The new row and its subtotal changes are one Sheets batch, never a
 * PASTE_NORMAL of a populated row. This builder is not wired to production.
 */
export function buildStableMonthExpansion(sheetId:number, headerRow:number, totalRow:number, stableKey:string, values:StableRowValues,blockMonth:number,metadataId:number):Array<Record<string,unknown>> {
  if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(headerRow)||headerRow<1||!Number.isSafeInteger(totalRow)||totalRow<=headerRow+1)throw new Error('INVALID_MONTH_LAYOUT');
  if(!/^MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}$/.test(stableKey))throw new Error('INVALID_STABLE_KEY');
  if(values.month!==blockMonth)throw new Error('POSTING_MONTH_MISMATCH');
  if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647)throw new Error('INVALID_METADATA_ID');
  const update=buildStableRowMetadataWrite(1,values).values[0]!;
  const row=totalRow, newTotal=row+1;
  const cells:Array<{userEnteredValue?:Record<string,string|number>}> = update.map(value=>value===null||value===''?{}:({userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:value}}));
  const formula=(column:number,value:string)=>{cells[column]={userEnteredValue:{formulaValue:value}};};
  const helper=expectedHelperFormulae(headerRow,row);
  formula(8,helper.I!);formula(9,helper.J!);formula(17,helper.R!);formula(18,helper.S!);formula(20,helper.U!);
  cells[23]={userEnteredValue:{stringValue:stableKey}};
  const requests:Array<Record<string,unknown>>=[
    {insertDimension:{range:{sheetId,dimension:'ROWS',startIndex:row-1,endIndex:row},inheritFromBefore:true}},
    {updateCells:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:0,endColumnIndex:25},rows:[{values:cells}],fields:'userEnteredValue'}}
  ];
  const sumColumns=[['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]] as const;
  for(const [name,index] of sumColumns){
    const value=`=SUMIF($B$${headerRow+1}:$B$${row},$B${newTotal},${name}${headerRow+1}:${name}${row})`;
    requests.push({updateCells:{range:{sheetId,startRowIndex:newTotal-1,endRowIndex:newTotal,startColumnIndex:index,endColumnIndex:index+1},rows:[{values:[{userEnteredValue:{formulaValue:value}}]}],fields:'userEnteredValue'}});
  }
  for(const [index,value] of [[8,`=SUM(F${newTotal}:H${newTotal})`],[9,`=$E$${headerRow}-I${newTotal}`],[17,`=SUM(K${newTotal}:Q${newTotal})`],[18,`=J${newTotal}-R${newTotal}`]] as const){
    requests.push({updateCells:{range:{sheetId,startRowIndex:newTotal-1,endRowIndex:newTotal,startColumnIndex:index,endColumnIndex:index+1},rows:[{values:[{userEnteredValue:{formulaValue:value}}]}],fields:'userEnteredValue'}});
  }
  requests.push({createDeveloperMetadata:{developerMetadata:{metadataId,metadataKey:'e',location:{dimensionRange:{sheetId,dimension:'ROWS',startIndex:row-1,endIndex:row}},visibility:'DOCUMENT'}}});
  return requests;
}
