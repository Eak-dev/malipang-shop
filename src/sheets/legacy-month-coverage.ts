/** Local, read-only legacy monthly reconciliation. This does not fence a
 * collaborator or establish provider request settlement. The caller must
 * bind both complete snapshots to one verified sheet identity and re-check
 * them under its external-writer fence immediately around a cutover. */
const empty=(x:unknown)=>x===null||x===undefined||x==='';
const money=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&Number.isSafeInteger(Math.round(x*100))&&Math.abs(x*100-Math.round(x*100))<0.0001;
const serial=(year:number,month:number,day:number)=>(Date.UTC(year,month-1,day)-Date.UTC(1899,11,30))/86400000;
const expr=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)||typeof x==='string'&&x.startsWith('=');
export type LegacyCoverageResult={status:'VERIFIED';legacyDebitSatang:number;openingSatang:number|null;checkedRows:number}|{status:'REVIEW';reason:string};
export function verifyLegacyMonthCoverage(input:{formula:unknown[][];effective:unknown[][];rowCount:number;columnCount:number;year:number;month:number;complete:boolean}):LegacyCoverageResult{
 const fail=(reason:string):LegacyCoverageResult=>({status:'REVIEW',reason});
 const {formula,effective,rowCount,columnCount,year,month,complete}=input;
 if(complete!==true||!Array.isArray(formula)||!Array.isArray(effective)||!Number.isSafeInteger(rowCount)||rowCount<6||rowCount>5000||!Number.isSafeInteger(columnCount)||columnCount<21||columnCount>100||formula.length>rowCount||effective.length>rowCount||[...formula,...effective].some(r=>!Array.isArray(r)||r.length>columnCount)||!Number.isInteger(year)||year<1900||year>9999||!Number.isInteger(month)||month<1||month>12)return fail('SNAPSHOT_UNVERIFIED');
 const anchor=formula[4]?.[0];
 if(typeof anchor!=='number'||!Number.isInteger(anchor)||anchor<1900||anchor>9999||year<anchor||effective[4]?.[0]!==anchor)return fail('YEAR_UNVERIFIED');
 const future=year>anchor,headers:number[]=[],summaries:number[]=[],allHeaders=new Map<number,number[]>(),allSummaries=new Map<number,number[]>();
 for(let i=4;i<rowCount;i++){
  const f=formula[i]??[],e=effective[i]??[],a=e[0],m=e[1],d=e[2],description=e[3],amount=e[8],date=e[20];
  if(i!==4&&typeof a==='number'&&Number.isInteger(a)&&a>=1900&&a<=9999)return fail('YEAR_UNVERIFIED');
  // A dated expense in an unknown month/year makes whole-year coverage
  // ambiguous. Do not assign it to a month by guessing.
  const hasMoney=!empty(amount)&&amount!==0,hasInputs=[5,6,7].some(c=>!empty(e[c])&&e[c]!==0);
  if((hasMoney||hasInputs)&&(typeof m!=='number'||!Number.isInteger(m)||m<1||m>12))return fail('MONTH_UNVERIFIED');
  if((hasMoney||hasInputs)&&m===month&&empty(d)&&a!=='รวม')return fail('DATE_UNVERIFIED');
  if(typeof date==='number'&&Number.isFinite(date)){
   if(!Number.isInteger(date))return fail('DATE_UNVERIFIED');
   const y=new Date(Date.UTC(1899,11,30)+date*86400000).getUTCFullYear();
   if(y!==anchor)return fail('YEAR_UNVERIFIED');
  }else if(future&&!empty(date)&&(hasMoney||hasInputs))return fail('DATE_UNVERIFIED');
  if(m===month&&empty(d)&&description==='รายรับทั้งหมดในบัญชี')headers.push(i);
  if(m===month&&empty(d)&&a==='รวม'&&empty(date))summaries.push(i);
  if(typeof m==='number'&&Number.isInteger(m)&&m>=1&&m<=12&&empty(d)&&description==='รายรับทั้งหมดในบัญชี')allHeaders.set(m,[...allHeaders.get(m)||[],i]);
  if(typeof m==='number'&&Number.isInteger(m)&&m>=1&&m<=12&&empty(d)&&a==='รวม'&&empty(date))allSummaries.set(m,[...allSummaries.get(m)||[],i]);
 }
 if(future){
  for(let i=4;i<rowCount;i++){
   const e=effective[i]??[],m=e[1],day=e[2],amount=e[8],date=e[20],hasMoney=!empty(amount)&&amount!==0,hasInputs=[5,6,7].some(c=>!empty(e[c])&&e[c]!==0);
   if(!hasMoney&&!hasInputs||e[0]==='รวม')continue;
   if(typeof m!=='number'||!Number.isInteger(m)||m<1||m>12||typeof day!=='number'||!Number.isInteger(day)||day<1||day>31)return fail('DATE_UNVERIFIED');
   const hs=allHeaders.get(m)||[],ss=allSummaries.get(m)||[];
   if(hs.length!==1||ss.length!==1||i<=hs[0]!||i>=ss[0]!)return fail('MONTH_BLOCK_UNVERIFIED');
   const d:Date=new Date(Date.UTC(anchor,m-1,day));
   if(d.getUTCFullYear()!==anchor||d.getUTCMonth()+1!==m||d.getUTCDate()!==day||!empty(date)&&date!==serial(anchor,m,day))return fail('DATE_UNVERIFIED');
   if(!money(amount))return fail('AMOUNT_UNVERIFIED');
  }
  return{status:'VERIFIED',legacyDebitSatang:0,openingSatang:null,checkedRows:0};
 }
 if(headers.length!==1||summaries.length!==1||headers[0]!>=summaries[0]!)return fail('MONTH_BLOCK_UNVERIFIED');
 const start=headers[0]!,end=summaries[0]!,h=formula[start]??[],he=effective[start]??[],s=formula[end]??[],se=effective[end]??[];
 if(!money(h[4])||h[4]!==he[4])return fail('OPENING_UNVERIFIED');
 const directSubtotal=s[8]===`=SUM(I${start+2}:I${end})`;
 const channelsSubtotal=s[8]===`=SUM(F${end+1}:H${end+1})`&&[5,6,7].every((c)=>{
  const name=String.fromCharCode(65+c);
  return s[c]===`=SUMIF($B$${start+2}:$B$${end},$B${end+1},${name}${start+2}:${name}${end})`&&money(se[c]);
 });
 if((!directSubtotal&&!channelsSubtotal)||!money(se[8]))return fail('SUBTOTAL_UNVERIFIED');
 let total=0,entries=0;
 for(let i=4;i<rowCount;i++){
  const f=formula[i]??[],e=effective[i]??[],m=e[1],day=e[2],amount=e[8],date=e[20],hasMoney=!empty(amount)&&amount!==0,hasInputs=[5,6,7].some(c=>!empty(e[c])&&e[c]!==0);
  const dateInMonth=typeof date==='number'&&date>=serial(year,month,1)&&date<serial(year,month+1,1);
  if(i===end)continue;
  if(!(m===month||dateInMonth)||!hasMoney&&!hasInputs)continue;
  if(i<=start||i>=end)return fail('MONTH_BLOCK_UNVERIFIED');
  if(m!==month||typeof day!=='number'||!Number.isInteger(day)||day<1||day>31)return fail('DATE_UNVERIFIED');
  const actual=new Date(Date.UTC(year,month-1,day));
  if(actual.getUTCFullYear()!==year||actual.getUTCMonth()+1!==month||actual.getUTCDate()!==day||date!==serial(year,month,day)||!expr(f[20]))return fail('DATE_UNVERIFIED');
  if(!money(amount)||!expr(f[8]))return fail('AMOUNT_UNVERIFIED');
  if(channelsSubtotal&&([5,6,7].some(c=>!empty(e[c])&&!money(e[c]))||Math.round(amount*100)!==[5,6,7].reduce((n,c)=>n+(empty(e[c])?0:Math.round((e[c] as number)*100)),0)))return fail('SUBTOTAL_UNVERIFIED');
  if(!Number.isSafeInteger(total+Math.round(amount*100)))return fail('AMOUNT_UNVERIFIED');
  total+=Math.round(amount*100);entries++;
 }
 if(Math.round(se[8]*100)!==total)return fail('SUBTOTAL_MISMATCH');
 return{status:'VERIFIED',legacyDebitSatang:total,openingSatang:Math.round(he[4]*100),checkedRows:entries};
}
