import type {Env} from '../types';
import {planInstalledReportFormulas,type SheetProperty} from './continuous-report-health';
import type {PublicationSnapshotSpec} from './publication-batch-snapshot';

/** Plan only the bounded rectangles required for publication and report
 * validation. Metadata must come from a fresh, budgeted provider read; the
 * capture itself independently brackets all values with metadata checks. */
export async function planPublicationSnapshot(env:Env,allSheets:SheetProperty[],marker:{sheetId:number;sheetName:string;rows:number}):Promise<PublicationSnapshotSpec[]>{
 const book=env.GOOGLE_SPREADSHEET_ID,db=env.DB,daily=env.CONTINUOUS_DAILY_SHEET,raw=env.CONTINUOUS_RAW_SHEET,detail=env.CONTINUOUS_DETAIL_SHEET,legacy=env.SHEET_EXPENSE_DAILY;
 if(!book||!daily||!raw||!detail||legacy!=='รายวัน'||!marker.sheetName||!Number.isSafeInteger(marker.sheetId)||!Number.isSafeInteger(marker.rows)||marker.rows<2||marker.rows>5000)throw Error('PUBLICATION_PLAN_SCOPE');
 const find=(name:string)=>{const values=allSheets.filter(s=>s.title===name);if(values.length!==1)throw Error('PUBLICATION_PLAN_TARGET');return values[0]!;};
 const selected=[find(daily),find(legacy),find(raw),find(detail),find('V52_EXPENSE_RAW_ALL'),find('V52_PURCHASE_DETAIL_ALL'),find('97_EXPENSE_CLEAN'),find(marker.sheetName)];
 if(new Set(selected.map(s=>s.sheetId)).size!==selected.length||selected[7]!.sheetId!==marker.sheetId||selected[7]!.rowCount!==marker.rows||selected[0]!.sheetId!==Number(env.CONTINUOUS_DAILY_SHEET_ID)||selected[2]!.sheetId!==Number(env.CONTINUOUS_RAW_SHEET_ID)||selected[3]!.sheetId!==Number(env.CONTINUOUS_DETAIL_SHEET_ID)||selected[6]!.rowCount!==4500||selected[6]!.columnCount<8)throw Error('PUBLICATION_PLAN_TARGET');
 const full=(s:SheetProperty):PublicationSnapshotSpec=>({sheetId:s.sheetId,sheetName:s.title,rows:s.rowCount,columns:s.columnCount});
 const region=(s:SheetProperty,startRow:number,endRow:number,startColumn:number,endColumn:number):PublicationSnapshotSpec=>({...full(s),startRow,endRow,startColumn,endColumn});
 const specs:PublicationSnapshotSpec[]=[full(selected[0]!),region(selected[1]!,1,selected[1]!.rowCount,1,Math.min(25,selected[1]!.columnCount)),full(selected[2]!),full(selected[3]!),region(selected[4]!,1,selected[4]!.rowCount,1,1),region(selected[5]!,1,selected[5]!.rowCount,1,2),region(selected[6]!,1,4500,1,8),region(selected[7]!,1,marker.rows,1,1)];
 for(const g of await planInstalledReportFormulas(env,allSheets))specs.push(region(g.sheet,g.minRow,g.maxRow,g.minColumn,g.maxColumn));
 const unique=new Map<string,PublicationSnapshotSpec>();for(const s of specs)unique.set(JSON.stringify([s.sheetId,s.startRow??1,s.endRow??s.rows,s.startColumn??1,s.endColumn??s.columns]),s);
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.CONTINUOUS_DAILY_SHEET!==daily||env.CONTINUOUS_RAW_SHEET!==raw||env.CONTINUOUS_DETAIL_SHEET!==detail)throw Error('PUBLICATION_PLAN_SCOPE');return [...unique.values()];
}
