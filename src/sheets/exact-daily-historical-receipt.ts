import {sha256Hex} from '../shared/ids';
import type {DailyWriteSnapshot} from './continuous-daily-write-evidence';
import {
 matchesApprovedHistoricalDailyDelta,type HistoricalDailyArchive,type HistoricalDailyDeltaPolicy,
 type HistoricalDailyGrid,type HistoricalDailyIncidentScope,
} from './exact-daily-historical-delta-draft';

const fields=['incidentFingerprint','archiveIdentityDigest','archiveGridDigest','approvedDeltaDigest','liveGridDigest'] as const;
type ReceiptField=(typeof fields)[number];
export type HistoricalDailyReceipt=Readonly<Record<ReceiptField,string>>;

const receiptDomain='issue296-exact-daily-historical-receipt-v1';
const gridDomain='issue296-exact-daily-historical-grid-v1';
const archiveIdentityDomain='issue296-exact-daily-historical-archive-identity-v1';
const sha256=/^[0-9a-f]{64}$/;
const bookId=/^[A-Za-z0-9_-]{1,256}$/;
const driveVersionPattern=/^[1-9][0-9]{0,19}$/;

function hashTuple(tuple:readonly unknown[]):Promise<string>{
 return sha256Hex(new TextEncoder().encode(JSON.stringify(tuple)).buffer);
}

/** Extract own data fields into a detached snapshot before checking any pin. */
export function parseHistoricalDailyReceipt(raw:unknown):HistoricalDailyReceipt|null{
 try{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Reflect.ownKeys(raw).length!==fields.length)return null;
  const receipt={} as Record<ReceiptField,string>;
  for(const key of fields){
   const field=Object.getOwnPropertyDescriptor(raw,key);
   if(!field?.enumerable||typeof field.value!=='string'||!sha256.test(field.value))return null;
   receipt[key]=field.value;
  }
  return receipt;
 }catch{
  return null;
 }
}

export async function historicalDailyReceiptDigest(receipt:HistoricalDailyReceipt):Promise<string>{
 const parsed=parseHistoricalDailyReceipt(receipt);
 if(!parsed)throw Error('HISTORICAL_DAILY_RECEIPT_INVALID');
 return hashTuple([receiptDomain,...fields.map(key=>parsed[key])]);
}

function validCell(cell:unknown):boolean{
 return cell===undefined||cell===null||typeof cell==='string'||typeof cell==='boolean'||
  typeof cell==='number'&&Number.isFinite(cell);
}

function snapshotGrid(grid:HistoricalDailyGrid):HistoricalDailyGrid|null{
 if(!grid||!grid.values)return null;
 const {spreadsheetId,sheetId,sheetName,rowCount,columnCount}=grid;
 if(typeof spreadsheetId!=='string'||!bookId.test(spreadsheetId)||!Number.isSafeInteger(sheetId)||sheetId<0||
  typeof sheetName!=='string'||!sheetName.trim()||!Number.isSafeInteger(rowCount)||rowCount<7||rowCount>5000||
  !Number.isSafeInteger(columnCount)||columnCount<29||columnCount>100)return null;
 const values:DailyWriteSnapshot={formula:[],effective:[]};
 for(const view of ['formula','effective'] as const){
  const matrix=grid.values[view];
  if(!Array.isArray(matrix)||matrix.length>rowCount)return null;
  for(const row of matrix){
   if(!Array.isArray(row)||row.length>columnCount||!row.every(validCell))return null;
  }
  values[view]=Array.from({length:rowCount},(_,r)=>Array.from({length:columnCount},(_,c)=>{
   const cell=matrix[r]?.[c];
   return cell===undefined||cell===''?null:cell;
  }));
  if(values[view][rowCount-1]!.some(cell=>cell!==null))return null;
 }
 return {spreadsheetId,sheetId,sheetName,rowCount,columnCount,values};
}

function gridDigest(grid:HistoricalDailyGrid):Promise<string>{
 return hashTuple([gridDomain,grid.spreadsheetId,grid.sheetId,grid.sheetName,grid.rowCount,grid.columnCount,
  grid.values.formula,grid.values.effective]);
}

/** The caller independently authenticates the incident, policy and Drive
 * version before/after reading the archive. The receipt contains digests only
 * and proves the approved structural delta, without granting write authority. */
export async function prepareHistoricalDailyReceipt(
 policy:HistoricalDailyDeltaPolicy,current:HistoricalDailyIncidentScope,payload:string,
 archive:HistoricalDailyArchive,live:HistoricalDailyGrid,driveVersion:string,
):Promise<HistoricalDailyReceipt|null>{
 if(typeof driveVersion!=='string'||!driveVersionPattern.test(driveVersion)||!policy?.coordinates||!current?.coordinates)return null;
 const archivedGrid=snapshotGrid(archive),liveGrid=snapshotGrid(live);
 if(!archivedGrid||!liveGrid)return null;
 const archived={...archivedGrid,sourceSpreadsheetId:archive.sourceSpreadsheetId,createdAt:archive.createdAt};
 const approved={...policy,coordinates:{...policy.coordinates}};
 const incident={...current,coordinates:{...current.coordinates}};
 if(!await matchesApprovedHistoricalDailyDelta(approved,incident,payload,archived,liveGrid))return null;
 const [archiveIdentityDigest,archiveGridDigest,liveGridDigest]=await Promise.all([
  hashTuple([archiveIdentityDomain,archived.spreadsheetId,archived.sourceSpreadsheetId,archived.createdAt,driveVersion]),
  gridDigest(archived),gridDigest(liveGrid),
 ]);
 return {incidentFingerprint:incident.fingerprint,archiveIdentityDigest,archiveGridDigest,
  approvedDeltaDigest:approved.expectedDeltaDigest,liveGridDigest};
}

/** Check the separately configured receipt pin against the authenticated
 * incident and the caller's current full-grid readback. */
export async function matchesPinnedHistoricalDailyReadback(
 receipt:unknown,pin:string|null|undefined,incidentFingerprint:string,live:HistoricalDailyGrid,
):Promise<boolean>{
 const parsed=parseHistoricalDailyReceipt(receipt);
 if(!parsed||typeof pin!=='string'||!sha256.test(pin)||parsed.incidentFingerprint!==incidentFingerprint)return false;
 const snapshot=snapshotGrid(live);
 return !!snapshot&&await historicalDailyReceiptDigest(parsed)===pin&&await gridDigest(snapshot)===parsed.liveGridDigest;
}
