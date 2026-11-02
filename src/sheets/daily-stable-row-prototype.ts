import {findMonthBlocks} from './daily-expense';
import {planStableDailyExpenseRow,stableDailyExpenseKey,type StableDailyRowRequest} from './daily-stable-row-plan';
import {buildStableEmptyRowAppend,buildStableMonthExpansion,buildStableRowMetadataWrite,expectedHelperFormulae,hasExpectedMonthlySubtotal,type MetadataValueRange,type StableRowValues} from './daily-stable-row-writes';

/**
 * Shadow-only orchestration. No production adapter is provided: there is no
 * verified guard that excludes old worker versions and human sheet edits.
 * Any uncertain dispatch or failed readback is held, never blindly retried.
 */
export interface StablePrototypePort {
  requireExclusiveWriters():Promise<void>;
  readFormulaSnapshot():Promise<{sheetId:number;body:unknown[][]}>;
  /** UNFORMATTED_VALUE with dates rendered as SERIAL_NUMBER. */
  readEffectiveSnapshot():Promise<{sheetId:number;body:unknown[][]}>;
  /** Value of A5 read in formula/effective state; must be actual number. */
  readSheetYear():Promise<number>;
  lookupMetadata(key:string):Promise<Array<{metadataId:number;row:number}>>;
  /** Return all visible short-key metadata at this row, excluding nothing. */
  lookupMetadataAtRow(row:number):Promise<Array<{metadataId:number;row:number}>>;
  /** Durable D1 IN_FLIGHT intent, unique per spreadsheet/expense; it must never
   * expire by time and must refuse unresolved prior dispatch even when its
   * metadata disappeared (e.g. a user deleted the row). */
  reserveMetadataId(key:string):Promise<number>;
  /** D1 CAS: binds unique expense ID and unique metadata ID, never a row number. */
  bindMetadataId(key:string,metadataId:number):Promise<boolean>;
  /** Final CAS only after all postimages. Failures leave the intent held. */
  finishMetadataIntent(key:string,metadataId:number):Promise<boolean>;
  writeByMetadata(range:MetadataValueRange):Promise<void>;
  batchUpdate(requests:Array<Record<string,unknown>>):Promise<void>;
}
export type StablePrototypeResult={status:'VERIFIED'}|{status:'REVIEW';reason:string}|{status:'OUTCOME_UNKNOWN'};
const review=(reason:string):StablePrototypeResult=>({status:'REVIEW',reason});

export async function runStableDailyPrototype(mode:string,enabled:boolean,port:StablePrototypePort,request:StableDailyRowRequest,values:StableRowValues):Promise<StablePrototypeResult>{
  if(mode!=='shadow'||!enabled)return review('PROTOTYPE_DISABLED');
  const key=stableDailyExpenseKey(request.expenseId);
  if(request.postingMonth!==values.month)return review('POSTING_MONTH_MISMATCH');
  await port.requireExclusiveWriters();
  if(await port.readSheetYear()!==values.postingYear)return review('POSTING_YEAR_MISMATCH');
  const initial=await port.readFormulaSnapshot(),plan=planStableDailyExpenseRow(initial.body,request);
  if(plan.status==='REVIEW')return plan;
  const block=findMonthBlocks(initial.body).filter(item=>item.month===request.postingMonth);
  if(block.length!==1)return review('MONTH_BLOCK_NOT_UNIQUE');
  const expected=plan.status==='FOUND'?[...initial.body[plan.observedRow-1]!]:Array(25).fill(null);
  expected[1]=values.month;expected[2]=values.day;expected[3]=values.description;
  for(const column of [5,6,7,10,11,12,13,14,15,16])expected[column]='';
  const amountIndex:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};
  const amountColumn=amountIndex[values.amountColumn];if(amountColumn===undefined)return review('INVALID_DAILY_AMOUNT_COLUMN');
  expected[amountColumn]=values.amountBaht;expected[21]=values.category;expected[22]=values.sourceWallet;expected[23]=key;
  const metadata=await port.lookupMetadata(key);
  if(plan.status==='FOUND'){
    if(metadata.length!==1||metadata[0]!.row!==plan.observedRow)return review('ROW_METADATA_NOT_UNIQUE_OR_MISMATCH');
  }else if(metadata.length!==0)return review('UNEXPECTED_EXISTING_METADATA');
  await port.requireExclusiveWriters();
  const fresh=await port.readFormulaSnapshot(),freshPlan=planStableDailyExpenseRow(fresh.body,request);
  if(JSON.stringify(plan)!==JSON.stringify(freshPlan)||fresh.sheetId!==initial.sheetId)return review('SHEET_CHANGED_BEFORE_DISPATCH');
  if(plan.status==='FOUND'){
    const nextMetadata=await port.lookupMetadata(key);
    if(nextMetadata.length!==1||nextMetadata[0]!.row!==metadata[0]!.row||nextMetadata[0]!.metadataId!==metadata[0]!.metadataId)return review('ROW_METADATA_CHANGED_BEFORE_DISPATCH');
  }
  const monthBlock=block[0]!;
  if(plan.status==='CAPACITY_REQUIRED'&&!hasExpectedMonthlySubtotal(fresh.body[monthBlock.totalRow-1]??[],monthBlock.headerRow,monthBlock.totalRow))return review('SUBTOTAL_PREIMAGE_UNVERIFIED');
  let expectedBalance:number|undefined;
  let subtotalBefore:unknown[]|undefined;
  if(plan.status!=='FOUND'){
    const beforeEffective=await port.readEffectiveSnapshot();
    if(beforeEffective.sheetId!==fresh.sheetId)return review('SHEET_CHANGED_BEFORE_DISPATCH');
    const target=plan.status==='APPEND'?plan.observedRow:monthBlock.totalRow;
    for(let row=target-1;row>=monthBlock.headerRow;row--){
      const candidate=beforeEffective.body[row-1]??[],balance=candidate[9];
      if(Number(candidate[1])===request.postingMonth&&typeof balance==='number'&&Number.isFinite(balance)){expectedBalance=balance;break;}
    }
    if(expectedBalance===undefined)return review('PREVIOUS_BALANCE_UNVERIFIED');
    if(plan.status==='CAPACITY_REQUIRED'){
      subtotalBefore=beforeEffective.body[monthBlock.totalRow-1];
      if(!subtotalBefore||[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18].some(index=>typeof subtotalBefore![index]!=='number'||!Number.isFinite(subtotalBefore![index] as number)))return review('SUBTOTAL_VALUES_UNVERIFIED');
    }
  }
  let reservedMetadataId:number|undefined;
  if(plan.status!=='FOUND'){
    try{reservedMetadataId=await port.reserveMetadataId(key);}catch{return review('METADATA_RESERVATION_UNAVAILABLE');}
    if(!Number.isSafeInteger(reservedMetadataId)||reservedMetadataId<1||reservedMetadataId>2147483647)return review('INVALID_METADATA_ID');
  }
  await port.requireExclusiveWriters();
  if(await port.readSheetYear()!==values.postingYear)return review('POSTING_YEAR_MISMATCH');
  try{
    if(plan.status==='FOUND')await port.writeByMetadata(buildStableRowMetadataWrite(metadata[0]!.metadataId,values));
    else if(plan.status==='APPEND')await port.batchUpdate(buildStableEmptyRowAppend(fresh.sheetId,monthBlock.headerRow,plan.observedRow,key,values,plan.formulaColumnsMissing,request.postingMonth,reservedMetadataId!));
    else await port.batchUpdate(buildStableMonthExpansion(fresh.sheetId,monthBlock.headerRow,monthBlock.totalRow,key,values,request.postingMonth,reservedMetadataId!));
  }catch{return {status:'OUTCOME_UNKNOWN'};}
  try{
    const after=await port.readFormulaSnapshot(),post=planStableDailyExpenseRow(after.body,{expenseId:request.expenseId,postingMonth:request.postingMonth,allowCreate:false,expectedPrevious:expected});
    if(post.status!=='FOUND')return review('POSTIMAGE_UNVERIFIED');
    let expectedMetadataId=plan.status==='FOUND'?metadata[0]!.metadataId:undefined;
    if(plan.status!=='FOUND'){
      const candidates=await port.lookupMetadataAtRow(post.observedRow);
      if(candidates.length!==1||candidates[0]!.row!==post.observedRow||candidates[0]!.metadataId!==reservedMetadataId)return review('POSTIMAGE_METADATA_UNVERIFIED');
      if(!await port.bindMetadataId(key,candidates[0]!.metadataId))return review('POSTIMAGE_METADATA_BINDING_CONFLICT');
      expectedMetadataId=candidates[0]!.metadataId;
    }
    const postMetadata=await port.lookupMetadata(key);
    if(postMetadata.length!==1||postMetadata[0]!.row!==post.observedRow||postMetadata[0]!.metadataId!==expectedMetadataId)return review('POSTIMAGE_METADATA_UNVERIFIED');
    if(plan.status!=='FOUND'){
      const helper=expectedHelperFormulae(monthBlock.headerRow,post.observedRow),row=after.body[post.observedRow-1]??[];
      for(const [index,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']] as const)if(row[index]!==helper[name])return review('POSTIMAGE_HELPER_UNVERIFIED');
      const effective=await port.readEffectiveSnapshot(),visible=effective.body[post.observedRow-1]??[];
      const cash=['F','G','H'].includes(values.amountColumn)?values.amountBaht:0, card=cash?0:values.amountBaht;
      const expectedJ=expectedBalance!-cash;
      const expectedDate=(Date.UTC(values.postingYear,values.month-1,values.day)-Date.UTC(1899,11,30))/86400000;
      if(effective.sheetId!==fresh.sheetId||await port.readSheetYear()!==values.postingYear||visible[8]!==cash||visible[17]!==card||typeof visible[9]!=='number'||typeof visible[18]!=='number'||!Number.isFinite(visible[9])||!Number.isFinite(visible[18])||Math.abs(visible[9]-expectedJ)>0.001||Math.abs(visible[18]-(expectedJ-card))>0.001||visible[20]!==expectedDate)return review('POSTIMAGE_HELPER_VALUE_UNVERIFIED');
      if(plan.status==='CAPACITY_REQUIRED'){
        const blocks=findMonthBlocks(after.body).filter(item=>item.month===request.postingMonth);
        if(blocks.length!==1||blocks[0]!.totalRow!==monthBlock.totalRow+1||!hasExpectedMonthlySubtotal(after.body[blocks[0]!.totalRow-1]??[],monthBlock.headerRow,blocks[0]!.totalRow))return review('POSTIMAGE_SUBTOTAL_FORMULA_UNVERIFIED');
        const total=effective.body[blocks[0]!.totalRow-1]??[];
        for(const index of [4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]){
          const expectedDelta=index===amountColumn?values.amountBaht:index===8?cash:index===9?-cash:index===17?card:index===18?-cash-card:0;
          if(typeof total[index]!=='number'||!Number.isFinite(total[index] as number)||Math.abs((total[index] as number)-(subtotalBefore![index] as number)-expectedDelta)>0.001)return review('POSTIMAGE_SUBTOTAL_VALUE_UNVERIFIED');
        }
      }
    }
    await port.requireExclusiveWriters();
    if(plan.status!=='FOUND'&&!await port.finishMetadataIntent(key,reservedMetadataId!))return review('INTENT_COMPLETION_UNVERIFIED');
    return {status:'VERIFIED'};
  }catch{return review('POSTIMAGE_READ_FAILED');}
}
