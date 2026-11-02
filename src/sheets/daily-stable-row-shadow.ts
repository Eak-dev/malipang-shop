import type {Env} from '../types';
import {batchUpdateStablePrototype,stablePrototypeSearchMetadata,stablePrototypeSheetInfo,stablePrototypeSnapshot,writeDailyByMetadataPrototype} from './client';
import {DailyCancelReviewRequired,legacySourceWallet,resolvePayment,type DailyExpenseRecord} from './daily-expense';
import {StableDailyJournal} from './daily-stable-row-journal';
import {runStableDailyPrototype,type StablePrototypePort} from './daily-stable-row-prototype';
import {withCorrectionDailyWriteFence,type DailyFenceExpenseSnapshot} from './owner-correction-daily-write-fence';

/** Execute only against an explicitly allowlisted, exclusive UAT workbook.
 * The consent flag is an operational assertion, NOT a technical guard against
 * a human editor or a worker using an older code version. Never use in prod. */
export function assertStableShadowConfig(env:Env,expenseId:string):void{
  if(env.RUNTIME_MODE!=='shadow'||env.DAILY_STABLE_ID_PROTOTYPE_ENABLED!=='true'||!env.DAILY_STABLE_UAT_SPREADSHEET_ID||!env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||env.DAILY_STABLE_UAT_SPREADSHEET_ID===env.DAILY_STABLE_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.DAILY_STABLE_UAT_SPREADSHEET_ID||!env.DAILY_STABLE_UAT_DATABASE_MARKER||env.DAILY_STABLE_UAT_EXCLUSIVE_EDITORS!=='true'||env.DAILY_STABLE_UAT_NEW_EXPENSE_ID!==expenseId)throw new DailyCancelReviewRequired('DAILY_STABLE_UAT_NOT_AUTHORIZED');
}
/** This table is intentionally NOT installed by migration; it must only be
 * provisioned in a dedicated synthetic UAT database. */
export async function assertStableShadowDatabase(env:Env):Promise<void>{
  try{const marker=await env.DB.prepare(`SELECT marker FROM daily_stable_uat_guard WHERE marker=?`).bind(env.DAILY_STABLE_UAT_DATABASE_MARKER).first<{marker:string}>();if(!marker)throw new Error('missing');}
  catch{throw new DailyCancelReviewRequired('DAILY_STABLE_UAT_DATABASE_UNVERIFIED');}
}
export async function writeDailyStableShadow(env:Env,record:DailyExpenseRecord):Promise<void>{
  assertStableShadowConfig(env,record.expenseId);
  await assertStableShadowDatabase(env);
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!match)throw new DailyCancelReviewRequired('DAILY_STABLE_DATE_INVALID');
  const sheet=env.SHEET_EXPENSE_DAILY,escaped=sheet.replace(/'/g,"''"),snapshot:DailyFenceExpenseSnapshot={expenseId:record.expenseId,version:record.version,transactionDate:record.transactionDate,description:record.description,amountSatang:Math.round(record.amountBaht*100),paymentKey:record.paymentKey,sourceWallet:record.sourceWallet,category:record.category};
  await withCorrectionDailyWriteFence(env,sheet,async(write,token)=>{
    if(!token)throw new DailyCancelReviewRequired('DAILY_STABLE_FENCE_MISSING');
    // Existing numeric mappings are not evidence of absence or identity.
    const prior=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND entity_key=?`).bind(sheet,record.expenseId).first();
    if(prior)throw new DailyCancelReviewRequired('DAILY_STABLE_LEGACY_REVIEW_REQUIRED');
    const initialInfo=await stablePrototypeSheetInfo(env,sheet),sheetId=initialInfo.sheetId,journal=new StableDailyJournal(env,env.GOOGLE_SPREADSHEET_ID,record.expenseId,record.version),stableKey=`MALIPANG_EXPENSE:${record.expenseId}`;
    let expectedRowCount=initialInfo.rowCount;
    let reserved:number|undefined;
    const assertFence=async()=>{
      const row=await env.DB.prepare(`SELECT 1 AS ok FROM owner_correction_daily_write_fences f JOIN expense_events e ON e.expense_id=? WHERE f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND e.status='CONFIRMED' AND e.version=? AND e.transaction_date=? AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=?`).bind(record.expenseId,sheet,token,record.version,record.transactionDate,record.description,Math.round(record.amountBaht*100),record.paymentKey,record.sourceWallet,record.category).first<{ok:number}>();
      if(!row)throw new DailyCancelReviewRequired('DAILY_STABLE_FENCE_OR_SOURCE_CHANGED');
    };
    const read=async(formulas:boolean)=>{const info=await stablePrototypeSheetInfo(env,sheet);if(info.sheetId!==sheetId||info.rowCount!==expectedRowCount||info.columnCount!==initialInfo.columnCount)throw new DailyCancelReviewRequired('DAILY_STABLE_SHEET_GRID_CHANGED');return{sheetId,body:await stablePrototypeSnapshot(env,`'${escaped}'!A1:Y${info.rowCount}`,formulas)};};
    const port:StablePrototypePort={
      requireExclusiveWriters:assertFence,
      readFormulaSnapshot:()=>read(true),readEffectiveSnapshot:()=>read(false),
      readSheetYear:async()=>{const v=await stablePrototypeSnapshot(env,`'${escaped}'!A5`,false);return typeof v[0]?.[0]==='number'?v[0][0]:NaN;},
      lookupMetadata:async key=>{if(key!==stableKey)throw new Error('DAILY_STABLE_ID_MISMATCH');const entry=await journal.get();if(!entry)return[];if(entry.state==='IN_FLIGHT'&&entry.metadataId!==reserved)throw new DailyCancelReviewRequired('DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW');return(await stablePrototypeSearchMetadata(env,{metadataId:entry.metadataId})).filter(m=>m.sheetId===sheetId).map(({metadataId,row})=>({metadataId,row}));},
      lookupMetadataAtRow:async row=>(await stablePrototypeSearchMetadata(env,{metadataKey:'e',metadataLocation:{dimensionRange:{sheetId,dimension:'ROWS',startIndex:row-1,endIndex:row}},locationMatchingStrategy:'EXACT_LOCATION'})).filter(m=>m.sheetId===sheetId).map(({metadataId,row})=>({metadataId,row})),
      reserveMetadataId:async key=>{if(key!==stableKey)throw new Error('DAILY_STABLE_ID_MISMATCH');reserved=await journal.reserve();return reserved;},
      bindMetadataId:async(key,id)=>key===stableKey&&await journal.matchesReserved(id),
      finishMetadataIntent:async(key,id)=>key===stableKey&&await journal.finish(id),
      writeByMetadata:async range=>write(before=>writeDailyByMetadataPrototype(env,range,async()=>{await assertFence();if(before)await before();})),
      batchUpdate:async requests=>{
        const insertions=requests.filter(request=>'insertDimension' in request).length;
        if(insertions>1||expectedRowCount+insertions>5000)throw new DailyCancelReviewRequired('DAILY_STABLE_SHEET_GRID_UNSUPPORTED');
        await write(before=>batchUpdateStablePrototype(env,requests,async()=>{await assertFence();if(before)await before();}));
        expectedRowCount+=insertions;
      }
    };
    const headers=(await stablePrototypeSnapshot(env,`'${escaped}'!A1:W3`,true)),payment=resolvePayment(headers,record.paymentKey,Number(match[1]),Number(match[2]),Number(match[3]));
    const result=await runStableDailyPrototype('shadow',true,port,{expenseId:record.expenseId,postingMonth:payment.postingMonth,allowCreate:true},{postingYear:payment.postingYear,month:payment.postingMonth,day:payment.postingDay,description:record.description,amountColumn:payment.amountColumn,amountBaht:record.amountBaht,category:record.category,sourceWallet:legacySourceWallet(record.paymentKey,record.sourceWallet)});
    if(result.status!=='VERIFIED')throw new DailyCancelReviewRequired(result.status==='REVIEW'?result.reason:'DAILY_STABLE_OUTCOME_UNKNOWN');
  },undefined,snapshot);
}
