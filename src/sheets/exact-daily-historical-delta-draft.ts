import {sha256Hex} from '../shared/ids';
import {decodeAtomicDailyPayload} from './atomic-daily-template';
import {
 dailyPaddingStart,matchesCommittedDailyInsert,type DailyWriteCoordinates,type DailyWriteSnapshot,
} from './continuous-daily-write-evidence';

export type HistoricalDailyIncidentScope=Readonly<{
 fingerprint:string;
 spreadsheetId:string;
 sheetName:string;
 coordinates:Readonly<DailyWriteCoordinates>;
 beforeDigest:string;
 payloadDigest:string;
}>;

export type HistoricalDailyDeltaPolicy=HistoricalDailyIncidentScope&Readonly<{
 backupSpreadsheetId:string;
 backupCreatedAt:string;
 expectedDeltaDigest:string;
}>;

export type HistoricalDailyGrid=Readonly<{
 spreadsheetId:string;
 sheetId:number;
 sheetName:string;
 rowCount:number;
 columnCount:number;
 values:DailyWriteSnapshot;
}>;

export type HistoricalDailyArchive=HistoricalDailyGrid&Readonly<{
 sourceSpreadsheetId:string;
 createdAt:string;
}>;

type Cell=string|number|boolean|null;
type Change=[row:number,column:number,backupFormula:Cell,backupEffective:Cell,liveFormula:Cell,liveEffective:Cell];
const sha256=/^[0-9a-f]{64}$/;
const spreadsheetId=/^[A-Za-z0-9_-]{1,256}$/;

function sameIncident(policy:HistoricalDailyIncidentScope,current:HistoricalDailyIncidentScope):boolean{
 const p=policy.coordinates,c=current.coordinates;
 return policy.fingerprint===current.fingerprint&&policy.spreadsheetId===current.spreadsheetId&&
  policy.sheetName===current.sheetName&&policy.beforeDigest===current.beforeDigest&&policy.payloadDigest===current.payloadDigest&&
  p.sheetId===c.sheetId&&p.row===c.row&&p.rowCount===c.rowCount&&p.columnCount===c.columnCount;
}

function normalizedCell(value:unknown):Cell{
 return value===undefined||value===null||value===''?null:value as Cell;
}

function matchesGrid(grid:HistoricalDailyGrid,book:string,sheetName:string,c:DailyWriteCoordinates):boolean{
 const rows=c.rowCount+2;
 if(!grid||grid.spreadsheetId!==book||grid.sheetId!==c.sheetId||grid.sheetName!==sheetName||
  grid.rowCount!==rows||grid.columnCount!==c.columnCount||!grid.values)return false;
 for(const matrix of [grid.values.formula,grid.values.effective]){
  if(!Array.isArray(matrix)||matrix.length>rows)return false;
  for(const cells of matrix){
   if(!Array.isArray(cells)||cells.length>c.columnCount||cells.some(cell=>normalizedCell(cell)!==null&&
    typeof cell!=='string'&&typeof cell!=='boolean'&&(typeof cell!=='number'||!Number.isFinite(cell))))return false;
  }
 }
 // The provider grid has two additional physical rows. The legacy proof
 // handles one, and every column on the second must be blank in both views.
 return dailyPaddingStart(grid.values,rows,c.columnCount)<rows;
}

function copyProofGrid(values:DailyWriteSnapshot,rows:number):DailyWriteSnapshot{
 return {formula:values.formula.slice(0,rows).map(row=>row.slice()),
  effective:values.effective.slice(0,rows).map(row=>row.slice())};
}

/** Prove the single pre-approved historical delta using authenticated snapshot
 * identities supplied by the caller. This validates structure only. The
 * operator must separately authenticate the inputs and recheck current source,
 * carrier, accounting, format, notice and permissions before any transition. */
export async function matchesApprovedHistoricalDailyDelta(
 policy:HistoricalDailyDeltaPolicy,current:HistoricalDailyIncidentScope,payload:string,
 archive:HistoricalDailyArchive,live:HistoricalDailyGrid,
):Promise<boolean>{
 if(!policy?.coordinates||!current?.coordinates||!sameIncident(policy,current))return false;
 const {beforeDigest,payloadDigest,backupCreatedAt,expectedDeltaDigest}=policy,c={...policy.coordinates};
 const created=typeof backupCreatedAt==='string'?Date.parse(backupCreatedAt):NaN;
 if(![policy.fingerprint,beforeDigest,payloadDigest,expectedDeltaDigest].every(v=>typeof v==='string'&&sha256.test(v))||
  ![policy.spreadsheetId,policy.backupSpreadsheetId].every(v=>typeof v==='string'&&spreadsheetId.test(v))||
  policy.backupSpreadsheetId===policy.spreadsheetId||typeof policy.sheetName!=='string'||!policy.sheetName.trim()||
  !Number.isFinite(created)||new Date(created).toISOString()!==backupCreatedAt||
  !Number.isSafeInteger(c.sheetId)||c.sheetId<0||!Number.isSafeInteger(c.rowCount)||c.rowCount<5||c.rowCount>4998||
  !Number.isSafeInteger(c.columnCount)||c.columnCount<29||c.columnCount>100||
  !Number.isSafeInteger(c.row)||c.row<5||c.row>c.rowCount)return false;
 if(archive?.createdAt!==backupCreatedAt||archive.sourceSpreadsheetId!==policy.spreadsheetId||
  !matchesGrid(archive,policy.backupSpreadsheetId,policy.sheetName,c)||!matchesGrid(live,policy.spreadsheetId,policy.sheetName,c))return false;

 const carrier=decodeAtomicDailyPayload(payload);
 if(!carrier?.operationMarker)return false;
 const archived=copyProofGrid(archive.values,c.rowCount+1),restored=copyProofGrid(live.values,c.rowCount+1);
 const carrierViews=[archived.formula,archived.effective,restored.formula,restored.effective];
 const differences:Change[]=[];
 for(let r=0;r<c.rowCount+1;r++){
  if(r!==c.row-1&&carrierViews.some(values=>{
   const other=decodeAtomicDailyPayload(values[r]?.[24]);
   return other&&(other.operationMarker===carrier.operationMarker||other.expenseId===carrier.expenseId);
  }))return false;
  for(let col=0;col<c.columnCount;col++){
   const bf=normalizedCell(archived.formula[r]?.[col]),be=normalizedCell(archived.effective[r]?.[col]);
   const lf=normalizedCell(restored.formula[r]?.[col]),le=normalizedCell(restored.effective[r]?.[col]);
   if(bf===lf&&be===le)continue;
   if(r>=c.row-1)return false;
   differences.push([r+1,col+1,bf,be,lf,le]);
  }
 }
 if(differences.length===0)return false;
 const tuple=['issue296-daily-above-insert-delta-v1',c.sheetId,c.row,beforeDigest,backupCreatedAt,differences];
 if(await sha256Hex(new TextEncoder().encode(JSON.stringify(tuple)).buffer)!==expectedDeltaDigest||
  !await matchesCommittedDailyInsert(archived,c,payload,beforeDigest,payloadDigest))return false;
 for(const [row,col,formula,effective] of differences){
  // The target carrier exists in both input views, so all prior row arrays
  // were already present and only the approved coordinates are rewritten.
  restored.formula[row-1]![col-1]=formula;
  restored.effective[row-1]![col-1]=effective;
 }
 return matchesCommittedDailyInsert(restored,c,payload,beforeDigest,payloadDigest);
}
