import type {ContinuousSheetsReadPolicy} from './client';
import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from './client';
import {verifyLegacyMonthCoverage,type LegacyCoverageResult} from './legacy-month-coverage';
import {publicationSnapshotRange,type PublicationBatchSnapshot} from './publication-batch-snapshot';

export type VerifiedLegacyCoverage=Extract<LegacyCoverageResult,{status:'VERIFIED'}>&{year:number;month:number};
export type LegacyDailySnapshot={grid:{sheetId:number;rowCount:number;columnCount:number};formula:unknown[][];effective:unknown[][];coverage:VerifiedLegacyCoverage};

/** Caller must independently fence provider requests and external writers;
 * multiple reads cannot exclude a concurrent edit-and-restore (ABA). */
export async function readLegacyDailyCoverage(env:Env,year:number,month:number,targetSheet:string,readPolicy?:ContinuousSheetsReadPolicy,snapshot?:PublicationBatchSnapshot):Promise<LegacyDailySnapshot>{
 const book=env.GOOGLE_SPREADSHEET_ID,legacy=env.SHEET_EXPENSE_DAILY;
 // The carrier formula below explicitly references this verified legacy tab.
 if(!book||legacy!=='รายวัน'||!targetSheet||legacy===targetSheet)throw Error('LEGACY_COVERAGE_TARGET_UNVERIFIED');
 const entry=snapshot?.metadata.find(x=>x.title===legacy),grid=entry?{sheetId:entry.sheetId,rowCount:entry.rowCount,columnCount:entry.columnCount}:snapshot?null:await getSheetGridInfo(env,legacy,readPolicy);
 if(!grid)throw Error('LEGACY_COVERAGE_GRID_UNVERIFIED');
 if(grid.rowCount<6||grid.rowCount>5000||grid.columnCount<21||grid.columnCount>100)throw Error('LEGACY_COVERAGE_GRID_UNVERIFIED');
 const range=`'${legacy.replace(/'/g,"''")}'!A1:U${grid.rowCount}`;
 const f=snapshot?[publicationSnapshotRange(snapshot,grid.sheetId,1,grid.rowCount,1,21,'FORMULA')]:await batchGetSheetFormulaValues(env,[range],readPolicy),e=snapshot?[publicationSnapshotRange(snapshot,grid.sheetId,1,grid.rowCount,1,21,'EFFECTIVE')]:await batchGetSheetEffectiveSerialValues(env,[range],readPolicy),again=snapshot?grid:await getSheetGridInfo(env,legacy,readPolicy);
 if(env.GOOGLE_SPREADSHEET_ID!==book||env.SHEET_EXPENSE_DAILY!==legacy||JSON.stringify(grid)!==JSON.stringify(again)||f.length!==1||e.length!==1||!Array.isArray(f[0])||!Array.isArray(e[0]))throw Error('LEGACY_COVERAGE_READ_UNVERIFIED');
 const formula=f[0],effective=e[0],coverage=verifyLegacyMonthCoverage({formula,effective,rowCount:grid.rowCount,columnCount:21,year,month,complete:true});
 if(coverage.status!=='VERIFIED')throw Error(`LEGACY_COVERAGE_${coverage.reason}`);
 return{grid,formula,effective,coverage:{...coverage,year,month}};
}
