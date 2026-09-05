export interface OwnerMonthCloseCell{
  range:string;
  value:string;
}

const monthStart=`LET(ym,IF(ISNUMBER($C$2),DATE(YEAR($C$2),MONTH($C$2),1),DATEVALUE($C$2&"-01"))`;
const personalSum=(type:"PERSONAL_USE"|"PERSONAL_RETURN",wallet?:"SHOP_BANK")=>`=${monthStart},IFERROR(SUM(FILTER(V52_PERSONAL_USE_RAW!$E$2:$E$1000,V52_PERSONAL_USE_RAW!$C$2:$C$1000>=ym,V52_PERSONAL_USE_RAW!$C$2:$C$1000<EDATE(ym,1),V52_PERSONAL_USE_RAW!$B$2:$B$1000="${type}",V52_PERSONAL_USE_RAW!$G$2:$G$1000="CONFIRMED"${wallet?`,V52_PERSONAL_USE_RAW!$F$2:$F$1000="${wallet}"`:""})),0))`;

/**
 * Source-controlled cells for the Owner month-close template. PERSONAL_USE is
 * a cash/equity movement, not an Expense, so these formulas read only the
 * dedicated raw mirror and only CONFIRMED rows.
 */
export const OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS:readonly OwnerMonthCloseCell[]=[
  {range:"K6",value:"ถอนใช้ส่วนตัวทั้งหมด"},
  {range:"L6",value:personalSum("PERSONAL_USE")},
  {range:"K7",value:"คืนเงินส่วนตัวเข้าร้าน"},
  {range:"L7",value:personalSum("PERSONAL_RETURN")},
  {range:"K8",value:"ถอนสุทธิจากร้าน"},
  {range:"L8",value:"=L6-L7"},
  {range:"K15",value:"ถอนส่วนตัวจากบัญชีร้าน"},
  {range:"L15",value:personalSum("PERSONAL_USE","SHOP_BANK")},
  {range:"K16",value:"คืนเงินส่วนตัวเข้าบัญชี"},
  {range:"L16",value:personalSum("PERSONAL_RETURN","SHOP_BANK")},
  {range:"K17",value:"ยอดเงินปลายงวดที่ควรมี"},
  {range:"L17",value:'=IF(OR(L12="",L13=""),"",L12+L13-L14-L15+L16)'}
] as const;

export function planOwnerMonthClosePersonalUseWrites(current:unknown[][]):OwnerMonthCloseCell[]{
  if(current.length!==OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.length)throw new Error("OWNER_MONTH_CLOSE_PERSONAL_USE_READBACK_INCOMPLETE");
  const writes:OwnerMonthCloseCell[]=[];
  for(let i=0;i<OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS.length;i++){
    const expected=OWNER_MONTH_CLOSE_PERSONAL_USE_CELLS[i]!,actual=String(current[i]?.[0]??"");
    if(actual===expected.value)continue;
    if(actual===""){writes.push(expected);continue;}
    throw new Error(`OWNER_MONTH_CLOSE_PERSONAL_USE_LAYOUT_CONFLICT:${expected.range}`);
  }
  return writes;
}
