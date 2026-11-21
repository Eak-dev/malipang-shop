import {matchesCommittedDailyInsert,type DailyWriteCoordinates} from './continuous-daily-write-evidence';
import {verifyReportBaselineOverlay,type ReportGrid,type ReportReceipt} from './monthly-report-baseline';

/** Read-only composition of baseline overlay and the existing positive
 * insert proof. Callers MUST authenticate the baseline, journal receipts,
 * incident/source/claim, notice and all other guards before any transition.
 * This function cannot authorize recovery, dispatch or a retry. */
export async function verifyMonthlyIncidentOverlay(input:{base:ReportGrid;current:ReportGrid;baselineDigest:string;receipts:readonly ReportReceipt[];coords:DailyWriteCoordinates;payload:string;beforeDigest:string;payloadDigest:string}):Promise<boolean>{
 const {base,current,baselineDigest,receipts,coords,payload,beforeDigest,payloadDigest}=input;
 if(base.structure.sheetId!==coords.sheetId||base.columns!==coords.columnCount||![coords.rowCount+1,coords.rowCount+2].includes(base.rows)||!await verifyReportBaselineOverlay(base,current,baselineDigest,receipts))return false;
 if(base.rows===coords.rowCount+2){const index=coords.rowCount+1;for(let c=0;c<base.columns;c++)if(![undefined,null,''].includes(base.formula[index]?.[c] as never)||![undefined,null,''].includes(base.effective[index]?.[c] as never))return false;}
 return matchesCommittedDailyInsert({formula:base.formula.slice(0,coords.rowCount+1),effective:base.effective.slice(0,coords.rowCount+1)},coords,payload,beforeDigest,payloadDigest);
}
