/** Isolated prototype: the existing Owner Master draft does NOT use this
 * carrier layout. Never migrate an existing populated sheet with these
 * requests. addSheet and initialization must be sent in the SAME atomic
 * batch to a new, unused sheet id and title; uncertain responses are reviewed. */
export const ATOMIC_DAILY_SEPARATOR='␟';
export const ATOMIC_DAILY_PREFIX=`MPD1${ATOMIC_DAILY_SEPARATOR}`;
export const atomicDailyMarker=(row:number):string=>{
 if(!Number.isSafeInteger(row)||row<4||row>5000)throw Error('ATOMIC_DAILY_INVALID_ROW');
 return `MPD1_EMPTY_${row}_${crypto.randomUUID().replaceAll('-','').toLowerCase()}`;
};
export const isAtomicDailyMarkerForRow=(marker:unknown,row:number):marker is string=>typeof marker==='string'&&new RegExp(`^MPD1_EMPTY_${row}_[0-9a-f]{32}$`).test(marker);
export type AtomicDailyPayload={expenseId:string;postingYear:number;postingMonth:number;postingDay:number;description:string;amountColumn:string;amountSatang:number;category:string;wallet:string};
const columns=['F','G','H','K','L','M','N','O','P','Q'];
export function encodeAtomicDailyPayload(input:AtomicDailyPayload):string{
 const date=new Date(Date.UTC(input.postingYear,input.postingMonth-1,input.postingDay));
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(input.expenseId)||!Number.isSafeInteger(input.postingYear)||input.postingYear<1900||input.postingYear>9999||!Number.isInteger(input.postingMonth)||!Number.isInteger(input.postingDay)||date.getUTCFullYear()!==input.postingYear||date.getUTCMonth()+1!==input.postingMonth||date.getUTCDate()!==input.postingDay||!columns.includes(input.amountColumn)||!Number.isSafeInteger(input.amountSatang)||input.amountSatang<=0)throw Error('ATOMIC_DAILY_INVALID_SOURCE');
 const strings=[input.description,input.category,input.wallet];
 if(strings.some(x=>typeof x!=='string'||!x.trim()||x!==x.trim()||x.includes(ATOMIC_DAILY_SEPARATOR)||x.length>1000))throw Error('ATOMIC_DAILY_INVALID_TEXT');
 const out=['MPD1',`MALIPANG_EXPENSE:${input.expenseId}`,input.postingYear,input.postingMonth,input.postingDay,input.description,input.amountColumn,input.amountSatang,input.category,input.wallet].join(ATOMIC_DAILY_SEPARATOR);
 if(new TextEncoder().encode(out).byteLength>8000)throw Error('ATOMIC_DAILY_PAYLOAD_TOO_LONG');
 return out;
}
/** Every existing carrier is checked independently of its displayed X cell.
 * Canonical round-trip rejects malformed, truncated or ambiguous payloads. */
export function decodeAtomicDailyPayload(value:unknown):AtomicDailyPayload|null{
 if(typeof value!=='string'||!value.startsWith(ATOMIC_DAILY_PREFIX))return null;
 const p=value.split(ATOMIC_DAILY_SEPARATOR);
 if(p.length!==10||!p[1]?.startsWith('MALIPANG_EXPENSE:')||!/^\d+$/.test(p[2]||'')||!/^\d+$/.test(p[3]||'')||!/^\d+$/.test(p[4]||'')||!/^\d+$/.test(p[7]||''))return null;
 const parsed:AtomicDailyPayload={expenseId:p[1].slice('MALIPANG_EXPENSE:'.length),postingYear:Number(p[2]),postingMonth:Number(p[3]),postingDay:Number(p[4]),description:p[5]||'',amountColumn:p[6]||'',amountSatang:Number(p[7]),category:p[8]||'',wallet:p[9]||''};
 try{return encodeAtomicDailyPayload(parsed)===value?parsed:null;}catch{return null;}
}

/** Formulas exist only on system-managed rows. E remains an ordinary owner
 * input; the writer will not select a row with any manual value or altered
 * formula. Values are parsed from Y; dangerous-looking text remains text. */
export function atomicDailyRowFormulas(row:number):Record<number,string>{
 if(!Number.isSafeInteger(row)||row<4||row>5000)throw Error('ATOMIC_DAILY_INVALID_ROW');
 const y=`$Y${row}`,sep=`"${ATOMIC_DAILY_SEPARATOR}"`,field=(n:number)=>`INDEX(SPLIT(${y},${sep},FALSE,FALSE),1,${n})`,active=`LEFT(${y},5)="${ATOMIC_DAILY_PREFIX}"`,text=(n:number)=>`=IF(${active},IFERROR(${field(n)},""),"")`,num=(n:number)=>`=IF(${active},IFERROR(VALUE(${field(n)}),""),"")`;
 const amount=(col:string)=>`=IF(${active},IFERROR(IF(${field(7)}="${col}",VALUE(${field(8)})/100,""),""),"")`;
 const result:Record<number,string>={0:num(3),1:num(4),2:num(5),3:text(6),8:`=IF(COUNT(F${row}:H${row})=0,"",SUM(F${row}:H${row}))`,9:`=IF(U${row}="","",IF(OR(COUNTIFS($AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})>1,AND(COUNTIFS($AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})=1,SUMPRODUCT(--($AA$4:$AA$243=A${row}),--($AB$4:$AB$243=B${row}),--ISNUMBER($AC$4:$AC$243))<>1),AND(COUNTIFS($AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})=0,OR(A${row}<>'รายวัน'!$A$5,COUNTIFS('รายวัน'!$B$5:$B,B${row},'รายวัน'!$C$5:$C,"",'รายวัน'!$D$5:$D,"รายรับทั้งหมดในบัญชี")<>1,SUMPRODUCT(--('รายวัน'!$B$5:$B=B${row}),--('รายวัน'!$C$5:$C=""),--('รายวัน'!$D$5:$D="รายรับทั้งหมดในบัญชี"),--ISNUMBER('รายวัน'!$E$5:$E))<>1))),"",IF(AND(A${row}='รายวัน'!$A$5,COUNTIFS('รายวัน'!$B$5:$B,B${row},'รายวัน'!$C$5:$C,">0",'รายวัน'!$I$5:$I,"<>0",'รายวัน'!$U$5:$U,"")>0),NA(),IF(COUNTIFS($AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})=1,SUMIFS($AC$4:$AC$243,$AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row}),SUMIFS('รายวัน'!$E$5:$E,'รายวัน'!$B$5:$B,B${row},'รายวัน'!$C$5:$C,"",'รายวัน'!$D$5:$D,"รายรับทั้งหมดในบัญชี"))-SUMIFS($I$4:I${row},$A$4:A${row},A${row},$B$4:B${row},B${row})-SUMIFS('รายวัน'!$I$5:$I,'รายวัน'!$U$5:$U,">="&DATE(A${row},B${row},1),'รายวัน'!$U$5:$U,"<"&EDATE(DATE(A${row},B${row},1),1)))))`,17:`=IF(COUNT(K${row}:Q${row})=0,"",SUM(K${row}:Q${row}))`,18:`=IF(J${row}="","",J${row}-R${row})`,20:`=IF(AND(ISNUMBER(A${row}),ISNUMBER(B${row}),ISNUMBER(C${row}),A${row}>=1900,A${row}<=9999,B${row}>=1,B${row}<=12,C${row}>=1,C${row}<=31),IF(AND(YEAR(DATE(A${row},B${row},C${row}))=A${row},MONTH(DATE(A${row},B${row},C${row}))=B${row},DAY(DATE(A${row},B${row},C${row}))=C${row}),DATE(A${row},B${row},C${row}),""),"")`,21:text(9),22:text(10),23:text(2)};
 for(const [column,index] of Object.entries({F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16}))result[index]=amount(column);
 return result;
}

/** Preconditions for marker initialization are enforced structurally:
 * addSheet must create a genuinely new sheet and the whole batch is atomic.
 * This only builds requests; a caller must reconcile an unknown response. */
export function atomicDailyBootstrapRequests(sheetId:number,title:string,rowCount:number,cutoffs:readonly number[]):unknown[]{
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!title.trim()||title.length>80||!Number.isSafeInteger(rowCount)||rowCount<4||rowCount>5000||cutoffs.length!==7||cutoffs.some(x=>!Number.isInteger(x)||x<1||x>31))throw Error('ATOMIC_DAILY_BOOTSTRAP_INVALID');
 const values=(v:unknown)=>typeof v==='number'?{userEnteredValue:{numberValue:v}}:{userEnteredValue:{stringValue:String(v)}};
 const headers=['ปี (ค.ศ.)','Month','Date','รายการ','รายรับ','เงินสด FIXED','เงินสด NON-FIXED','เงินโอน','รวม','งบคงเหลือเดิม','Kbank','First Choice','Aeon','Cibit Bank','Thanachart','Homepro','The One','ยอดรวมบัตรเครดิต','คงเหลือตามสูตรเดิม','@','FullDate','category','เงินออกจาก','Stable ID','Metadata'];
 const cell=(rowIndex:number,columnIndex:number,items:unknown[])=>({updateCells:{start:{sheetId,rowIndex,columnIndex},rows:[{values:items.map(values)}],fields:'userEnteredValue'}});
 const templates=atomicDailyRowFormulas(4),markers=Array.from({length:rowCount-3},(_,i)=>atomicDailyMarker(i+4));
 if(new Set(markers.map(marker=>marker.slice(-32))).size!==markers.length)throw Error('ATOMIC_DAILY_MARKER_COLLISION');
 return [
  {addSheet:{properties:{sheetId,title,gridProperties:{rowCount,columnCount:29,frozenRowCount:3}}}},
  cell(0,0,['แบบทดสอบ — ยังไม่เชื่อมระบบ']),cell(1,10,[...cutoffs]),cell(2,0,headers),cell(2,26,['ปี (ค.ศ.)','เดือน','งบตั้งต้น (บาท)']),
  {updateCells:{start:{sheetId,rowIndex:3,columnIndex:24},rows:markers.map(marker=>({values:[values(marker)]})),fields:'userEnteredValue'}},
  ...Object.entries(templates).map(([column,formulaValue])=>({repeatCell:{range:{sheetId,startRowIndex:3,endRowIndex:rowCount,startColumnIndex:Number(column),endColumnIndex:Number(column)+1},cell:{userEnteredValue:{formulaValue}},fields:'userEnteredValue'}}))
 ];
}
