import {expenseCategories} from "../expense/document";

/** Payload only. Apply after baseline provisioning and explicit release approval. */
export function dailyCategoryDropdownRequests(sheetId:number):unknown[]{
  if(!Number.isSafeInteger(sheetId)||sheetId<0)throw new Error("CATEGORY_DROPDOWN_INVALID_SHEET");
  const note="เลือกหมวดเพื่อส่งคำขอ จากนั้นเจ้าของพิมพ์ ตรวจหมวด ใน LINE และอนุมัติก่อนฐานข้อมูลเปลี่ยน แถวที่ยังไม่เชื่อมต้องตรวจเพิ่มเติม";
  return [
    {setDataValidation:{range:{sheetId,startRowIndex:4,startColumnIndex:21,endColumnIndex:22},rule:{condition:{type:"ONE_OF_LIST",values:[...expenseCategories].map(userEnteredValue=>({userEnteredValue}))},showCustomUi:true,strict:false,inputMessage:note}}},
    {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:21,endColumnIndex:22},rows:[{values:[{note}]}],fields:"note"}}
  ];
}
