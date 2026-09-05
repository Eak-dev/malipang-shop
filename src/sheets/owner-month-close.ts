export interface OwnerMonthCloseCell{
  range:string;
  value:string;
}

const monthStart=`LET(ym,IF(ISNUMBER($C$2),DATE(YEAR($C$2),MONTH($C$2),1),DATEVALUE($C$2&"-01"))`;
const sheetReference=(name:string)=>`'${name.replace(/'/g,"''")}'`;
const legacyPersonalSum=(type:"PERSONAL_USE"|"PERSONAL_RETURN",wallet?:"SHOP_BANK")=>`=${monthStart},IFERROR(SUM(FILTER(V52_PERSONAL_USE_RAW!$E$2:$E$1000,V52_PERSONAL_USE_RAW!$C$2:$C$1000>=ym,V52_PERSONAL_USE_RAW!$C$2:$C$1000<EDATE(ym,1),V52_PERSONAL_USE_RAW!$B$2:$B$1000="${type}",V52_PERSONAL_USE_RAW!$G$2:$G$1000="CONFIRMED"${wallet?`,V52_PERSONAL_USE_RAW!$F$2:$F$1000="${wallet}"`:""})),0))`;
const personalSum=(sheetName:string,type:"PERSONAL_USE"|"PERSONAL_RETURN",wallet?:"SHOP_BANK")=>{
  const sheet=sheetReference(sheetName),range=(column:string)=>`${sheet}!$${column}$2:$${column}`,dates=range("C");
  return`=${monthStart},dates,ARRAYFORMULA(IFERROR(IF(ISNUMBER(${dates}),${dates},DATEVALUE(${dates})),0)),IFERROR(SUM(FILTER(${range("E")},dates>=ym,dates<EDATE(ym,1),${range("B")}="${type}",${range("G")}="CONFIRMED"${wallet?`,${range("F")}="${wallet}"`:""})),0))`;
};

/**
 * Source-controlled cells for the Owner month-close template. PERSONAL_USE is
 * a cash/equity movement, not an Expense, so these formulas read only the
 * dedicated raw mirror and only CONFIRMED rows.
 */
export function ownerMonthClosePersonalUseCells(sheetName:string):readonly OwnerMonthCloseCell[]{return[
  {range:"K6",value:"ถอนใช้ส่วนตัวทั้งหมด"},
  {range:"L6",value:personalSum(sheetName,"PERSONAL_USE")},
  {range:"K7",value:"คืนเงินส่วนตัวเข้าร้าน"},
  {range:"L7",value:personalSum(sheetName,"PERSONAL_RETURN")},
  {range:"K8",value:"ถอนสุทธิจากร้าน"},
  {range:"L8",value:"=L6-L7"},
  {range:"K15",value:"ถอนส่วนตัวจากบัญชีร้าน"},
  {range:"L15",value:personalSum(sheetName,"PERSONAL_USE","SHOP_BANK")},
  {range:"K16",value:"คืนเงินส่วนตัวเข้าบัญชี"},
  {range:"L16",value:personalSum(sheetName,"PERSONAL_RETURN","SHOP_BANK")},
  {range:"K17",value:"ยอดเงินปลายงวดที่ควรมี"},
  {range:"L17",value:'=IF(OR(L12="",L13=""),"",L12+L13-L14-L15+L16)'}
] as const;}

export function legacyOwnerMonthClosePersonalUseCells():readonly OwnerMonthCloseCell[]{return[
  {range:"K6",value:"ถอนใช้ส่วนตัวทั้งหมด"},{range:"L6",value:legacyPersonalSum("PERSONAL_USE")},
  {range:"K7",value:"คืนเงินส่วนตัวเข้าร้าน"},{range:"L7",value:legacyPersonalSum("PERSONAL_RETURN")},
  {range:"K8",value:"ถอนสุทธิจากร้าน"},{range:"L8",value:"=L6-L7"},
  {range:"K15",value:"ถอนส่วนตัวจากบัญชีร้าน"},{range:"L15",value:legacyPersonalSum("PERSONAL_USE","SHOP_BANK")},
  {range:"K16",value:"คืนเงินส่วนตัวเข้าบัญชี"},{range:"L16",value:legacyPersonalSum("PERSONAL_RETURN","SHOP_BANK")},
  {range:"K17",value:"ยอดเงินปลายงวดที่ควรมี"},{range:"L17",value:'=IF(OR(L12="",L13=""),"",L12+L13-L14-L15+L16)'}
] as const;}

export function planOwnerMonthClosePersonalUseWrites(current:unknown[][],expectedCells:readonly OwnerMonthCloseCell[],replaceableCells:readonly OwnerMonthCloseCell[]=[]):OwnerMonthCloseCell[]{
  if(current.length!==expectedCells.length)throw new Error("OWNER_MONTH_CLOSE_PERSONAL_USE_READBACK_INCOMPLETE");
  const replaceable=new Map(replaceableCells.map(cell=>[cell.range,cell.value]));
  const writes:OwnerMonthCloseCell[]=[];
  for(let i=0;i<expectedCells.length;i++){
    const expected=expectedCells[i]!,actual=String(current[i]?.[0]??"");
    if(actual===expected.value)continue;
    if(actual===""||actual===replaceable.get(expected.range)){writes.push(expected);continue;}
    throw new Error(`OWNER_MONTH_CLOSE_PERSONAL_USE_LAYOUT_CONFLICT:${expected.range}`);
  }
  return writes;
}
