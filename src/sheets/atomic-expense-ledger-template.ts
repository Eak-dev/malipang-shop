/** NEW, empty helper ledgers only. The live RAW/detail sheets contain plain
 * rows and MUST NOT be bootstrapped or edited with these requests. */
export type CarrierLedger='EXPENSE_RAW'|'DETAIL';
export type CarrierLedgerRow={projection:CarrierLedger;expenseId:string;itemId:string;confirmedVersion:number;status:'CONFIRMED'|'CANCELLED';cancelVersion:number|null;cancelledAt:string;values:unknown[];writeMarker?:string;cancelMarker?:string};
export const LEDGER_SEPARATOR='␟';
export const LEDGER_PREFIX=`MPL1${LEDGER_SEPARATOR}`;
const numeric:Record<CarrierLedger,Set<number>>={EXPENSE_RAW:new Set([3]),DETAIL:new Set([7,9,10,11,12,13])};
const lengths:Record<CarrierLedger,number>={EXPENSE_RAW:17,DETAIL:20};
export const rawCarrierHeaders=['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID'];
export const detailCarrierHeaders=['Purchase_Item_ID','Expense_ID','Document_ID','วันที่ซื้อ','บริษัท/ร้านค้า','เลขที่เอกสาร','รายการสินค้า','จำนวน','หน่วย','ราคาต่อหน่วย','ส่วนลดรายการ','จำนวนเงินรายการ','ส่วนลด/ปรับยอดระดับเอกสาร','ยอดจ่ายจริงของ Expense','หมวด','สาขา','สถานะ','Evidence ref (private)','Created_At','Updated_At / Cancelled_At'];
/** An appended row did not exist in the preimage. Its non-formula cells must
 * remain empty in both views or an external input could be mistaken for part
 * of this write. Existing rows may legitimately contain owner-entered data. */
export function appendedLedgerInputsBlank(projection:CarrierLedger,formula:unknown[],effective:unknown[]):boolean{
 if(!['EXPENSE_RAW','DETAIL'].includes(projection)||!Array.isArray(formula)||!Array.isArray(effective))return false;
 const start=projection==='EXPENSE_RAW'?17:20,blank=(v:unknown)=>v===undefined||v===null||v==='';
 for(let c=start;c<25;c++)if(!blank(formula[c])||!blank(effective[c]))return false;
 return true;
}
const date=(x:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export function encodeLedgerCarrier(row:CarrierLedgerRow):string{
 const {projection,expenseId,itemId,confirmedVersion,status,cancelVersion,cancelledAt,values}=row;
 if(!['EXPENSE_RAW','DETAIL'].includes(projection)||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||(projection==='DETAIL'?!/^item_[A-Za-z0-9_-]{1,128}$/.test(itemId):itemId!==''))throw Error('LEDGER_CARRIER_INVALID');
 if(!Number.isSafeInteger(confirmedVersion)||confirmedVersion<1||!Array.isArray(values)||values.length!==lengths[projection]||!['CONFIRMED','CANCELLED'].includes(status))throw Error('LEDGER_CARRIER_INVALID');
 if(status==='CONFIRMED'?(cancelVersion!==null||cancelledAt!==''):(!Number.isSafeInteger(cancelVersion)||Number(cancelVersion)<=confirmedVersion||!date(cancelledAt)))throw Error('LEDGER_CARRIER_INVALID');
 if(row.writeMarker!==undefined&&!/^LWC_[0-9a-f]{32}$/.test(row.writeMarker)||row.cancelMarker!==undefined&&(status!=='CANCELLED'||!/^LXC_[0-9a-f]{32}$/.test(row.cancelMarker)))throw Error('LEDGER_CARRIER_INVALID');
 if(projection==='EXPENSE_RAW'?(values[0]!==expenseId||values[7]!=='CONFIRMED'):(values[0]!==itemId||values[1]!==expenseId||values[16]!=='CONFIRMED'))throw Error('LEDGER_CARRIER_IDENTITY');
 const cells=values.map((v,i)=>{
  if(v===null||v===undefined||v==='')return 'b:';
  if(numeric[projection].has(i)){if(typeof v!=='number'||!Number.isFinite(v)||!Number.isSafeInteger(Math.round(v*1000000))||Math.abs(v*1000000-Math.round(v*1000000))>0.00001)throw Error('LEDGER_CARRIER_VALUE');return `n:${v}`;}
  if(typeof v!=='string'||v.includes(LEDGER_SEPARATOR)||v.length>4000)throw Error('LEDGER_CARRIER_VALUE');return `s:${v}`;
 });
 const fields:(string|number)[]=['MPL1',projection,expenseId,itemId,confirmedVersion,status,cancelVersion??'',cancelledAt,...cells];
 if(row.writeMarker!==undefined||row.cancelMarker!==undefined)fields.push(row.writeMarker??'');
 if(row.cancelMarker!==undefined)fields.push(row.cancelMarker);
 const result=fields.join(LEDGER_SEPARATOR);
 if(new TextEncoder().encode(result).length>20000)throw Error('LEDGER_CARRIER_TOO_LONG');return result;
}
export function decodeLedgerCarrier(value:unknown):CarrierLedgerRow|null{
 if(typeof value!=='string'||!value.startsWith(LEDGER_PREFIX))return null;
 const p=value.split(LEDGER_SEPARATOR),projection=p[1] as CarrierLedger;
 if(!['EXPENSE_RAW','DETAIL'].includes(projection)||p.length<8+lengths[projection]||p.length>10+lengths[projection]||!/^\d+$/.test(p[4]||'')||p[6]!==''&&!/^\d+$/.test(p[6]||''))return null;
 const values:unknown[]=[];
 for(let i=0;i<lengths[projection];i++){
  const v=p[8+i]||'';if(v==='b:')values.push('');else if(v.startsWith('n:')&&numeric[projection].has(i)&&v.slice(2).trim()!==''&&Number.isFinite(Number(v.slice(2))))values.push(Number(v.slice(2)));else if(v.startsWith('s:')&&!numeric[projection].has(i))values.push(v.slice(2));else return null;
 }
 const row:CarrierLedgerRow={projection,expenseId:p[2]||'',itemId:p[3]||'',confirmedVersion:Number(p[4]),status:p[5] as CarrierLedgerRow['status'],cancelVersion:p[6]===''?null:Number(p[6]),cancelledAt:p[7]||'',values};
 if(p.length>8+lengths[projection]&&p[8+lengths[projection]])row.writeMarker=p[8+lengths[projection]]!;
 if(p.length>9+lengths[projection])row.cancelMarker=p[9+lengths[projection]]||'';
 try{return encodeLedgerCarrier(row)===value?row:null}catch{return null}
}
/** Render original user-visible columns from a single guarded cell Z. RAW R is
 * intentionally left editable for the existing addback convention. */
function carrierFormulas(projection:CarrierLedger,z:string):Record<number,string>{
 const field=(n:number)=>`INDEX(SPLIT(${z},"${LEDGER_SEPARATOR}",FALSE,FALSE),1,${n})`,active=`LEFT(${z},5)="${LEDGER_PREFIX}"`,result:Record<number,string>={};
 for(let i=0;i<lengths[projection];i++){
  if(i===(projection==='EXPENSE_RAW'?7:16)){result[i]=`=IF(${active},IFERROR(${field(6)},""),"")`;continue;}
  const v=field(9+i),normal=numeric[projection].has(i)?`IF(LEFT(${v},2)="n:",VALUE(MID(${v},3,9999)),"")`:`IF(LEFT(${v},2)="s:",MID(${v},3,9999),"")`;
  result[i]=projection==='DETAIL'&&i===19?`=IF(${active},IFERROR(IF(${field(6)}="CANCELLED",${field(8)},${normal}),""),"")`:`=IF(${active},IFERROR(${normal},""),"")`;
 }
 return result;
}
export function ledgerCarrierFormulas(projection:CarrierLedger,row:number):Record<number,string>{
 if(!['EXPENSE_RAW','DETAIL'].includes(projection)||!Number.isSafeInteger(row)||row<2||row>5000)throw Error('LEDGER_CARRIER_ROW');return carrierFormulas(projection,`$Z${row}`);
}
/** ROW()-based formulas survive row movement and are safe to create in one
 * appendCells request without assuming which row number Google will allocate. */
export function ledgerCarrierAppendFormulas(projection:CarrierLedger):Record<number,string>{if(!['EXPENSE_RAW','DETAIL'].includes(projection))throw Error('LEDGER_CARRIER_ROW');return carrierFormulas(projection,'INDEX($Z:$Z,ROW())');}
/** One provider append request only; callers must reserve journal intent,
 * fence external writers, read back and never replay an ambiguous response. */
export function ledgerCarrierAppendRequest(projection:CarrierLedger,sheetId:number,payload:string):unknown{
 const decoded=decodeLedgerCarrier(payload);if(!decoded||decoded.projection!==projection||decoded.status!=='CONFIRMED'||!Number.isSafeInteger(sheetId)||sheetId<0)throw Error('LEDGER_APPEND_INVALID');
 const formulas=ledgerCarrierAppendFormulas(projection);
 return{appendCells:{sheetId,rows:[{values:Array.from({length:26},(_,c)=>c===25?{userEnteredValue:{stringValue:payload}}:Object.hasOwn(formulas,c)?{userEnteredValue:{formulaValue:formulas[c]}}:{})}],fields:'userEnteredValue'}};
}
export function ledgerCarrierMarker(row:number):string{if(!Number.isSafeInteger(row)||row<2||row>5000)throw Error('LEDGER_CARRIER_ROW');return `MPL1_EMPTY_${row}_${crypto.randomUUID().replaceAll('-','').toLowerCase()}`;}
export function ledgerCarrierDisplay(row:CarrierLedgerRow):unknown[]{return row.values.map((v,i)=>i===(row.projection==='EXPENSE_RAW'?7:16)?row.status:row.projection==='DETAIL'&&i===19&&row.status==='CANCELLED'?row.cancelledAt:v??'');}
/** A provider-side CAS request only; callers must also prove preimage,
 * source/claim/lease, settlement and durable versioned journal, then verify
 * exact readback. A planner is not permission to dispatch this request. */
export function planLedgerCarrierCancellation(input:{sheetId:number;row:number;projection:CarrierLedger;expenseId:string;itemId:string;confirmedVersion:number;cancelVersion:number;cancelledAt:string;original:unknown;cancelMarker?:string}):{find:string;replacement:string;request:unknown}{
 const original=decodeLedgerCarrier(input.original);
 if(!original||original.projection!==input.projection||original.expenseId!==input.expenseId||original.itemId!==input.itemId||original.confirmedVersion!==input.confirmedVersion||original.status!=='CONFIRMED'||!Number.isSafeInteger(input.sheetId)||input.sheetId<0||!Number.isSafeInteger(input.row)||input.row<2||input.row>5000)throw Error('LEDGER_CANCEL_PREIMAGE_UNVERIFIED');
 const replacement=encodeLedgerCarrier({...original,status:'CANCELLED',cancelVersion:input.cancelVersion,cancelledAt:input.cancelledAt,...(input.cancelMarker?{cancelMarker:input.cancelMarker}:{})}),find=input.original as string;
 return{find,replacement,request:{findReplace:{range:{sheetId:input.sheetId,startRowIndex:input.row-1,endRowIndex:input.row,startColumnIndex:25,endColumnIndex:26},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}}};
}
/** addSheet + all markers and formulas must be one atomic batch for a new
 * sheet ID. Unknown bootstrap response requires reconciliation. */
export function ledgerCarrierBootstrapRequests(projection:CarrierLedger,sheetId:number,title:string,rowCount:number,markersOverride?:readonly string[]):unknown[]{
 if(!['EXPENSE_RAW','DETAIL'].includes(projection)||!Number.isSafeInteger(sheetId)||sheetId<0||!title.trim()||title.length>80||!Number.isSafeInteger(rowCount)||rowCount<2||rowCount>5000)throw Error('LEDGER_BOOTSTRAP_INVALID');
 const headers=projection==='EXPENSE_RAW'?[...rawCarrierHeaders,'Sales_Addback_Basis']:detailCarrierHeaders,markers=markersOverride?[...markersOverride]:Array.from({length:rowCount-1},(_,i)=>ledgerCarrierMarker(i+2));
 if(markers.length!==rowCount-1||markers.some((v,i)=>typeof v!=='string'||!new RegExp('^MPL1_EMPTY_'+(i+2)+'_[0-9a-f]{32}$').test(v)))throw Error('LEDGER_MARKER_INVALID');
 if(new Set(markers.map(v=>v.slice(-32))).size!==markers.length)throw Error('LEDGER_MARKER_COLLISION');
 const formulas=ledgerCarrierFormulas(projection,2);
 return [{addSheet:{properties:{sheetId,title,gridProperties:{rowCount,columnCount:26,frozenRowCount:1}}}},
  {updateCells:{start:{sheetId,rowIndex:0,columnIndex:0},rows:[{values:headers.map(v=>({userEnteredValue:{stringValue:v}}))}],fields:'userEnteredValue'}},
  {updateCells:{start:{sheetId,rowIndex:1,columnIndex:25},rows:markers.map(v=>({values:[{userEnteredValue:{stringValue:v}}]})),fields:'userEnteredValue'}},
  ...Object.entries(formulas).map(([column,formulaValue])=>({repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:rowCount,startColumnIndex:Number(column),endColumnIndex:Number(column)+1},cell:{userEnteredValue:{formulaValue}},fields:'userEnteredValue'}}))];
}
