# Google Sheets Mapping — MaliPang Backend V5.2

D1 เป็น Source of Truth ส่วน Google Sheets ใช้สำหรับ Input, ตรวจสอบ และรายงานสำหรับ Owner

## Owner Master / Website mapping — ตรวจ 15 ตุลาคม 2026

อ้างอิง [สัญญาข้อมูลและขอบเขตเว็บไซต์](21_OWNER_MASTER_WEB_HANDOFF_TH.md) สำหรับ 4 หน้าหลัก:

| หน้าหลัก | ตำแหน่งสำคัญ | ข้อจำกัดการแก้ไข |
|---|---|---|
| `34_OWNER_DAILY_CASH` | `B2` เลือกเดือน, `E2` วันนี้, `A9:I40` สรุปเงิน/ยอดขาย, `A45:I77` รายจ่ายแยกแหล่งเงิน | B2 รองรับ ก.ย.–ต.ค. 2026; ตารางผลลัพธ์เป็นสูตร ไม่ใช่ช่องกรอกยอดจริง |
| `04_OWNER_MONTH_CLOSE` | `C2` เลือกเดือน; ช่องกรอกกระทบยอดและสูตรปิดเดือนเดิม | ต้อง inventory ช่องกรอกทีละช่องก่อนนำขึ้นเว็บ ห้ามแทนทั้งหน้าเป็น output แล้วทำ input หาย |
| `03_ต้นทุนสินค้า` | `B2` อ้างอิงเดือนปิดบัญชี, `A4:H21` สรุป 17 รายการจาก `Product_Cost_By_Filling!A37:M53` | อ่านอย่างเดียว; ยังไม่มีการยืนยันต้นทุนต่อชิ้นชิฟฟอน/คุกกี้ในหน้านี้ |
| `05_รายการต้องตรวจ` | สรุปจาก `30_RECON_DAILY`; รายละเอียดเริ่ม `A15:D` | เริ่มสิงหาคมของปีในแกนวันที่ ถึงวันนี้; ไม่ใช่ D1/failed-job audit |

ระบบยังอาศัย `SRC_ACTUAL_*`, `SRC_TEAM_*`, `รายวัน`, `97_EXPENSE_CLEAN`, `33_CUSTOMER_ADVANCES`, `24_CURR_PIECE_SUMMARY`, สูตรต้นทุน และแท็บ `HR_*` / `V52_*` ตามหน้าที่เดิม ทั้งที่แสดงและซ่อนอยู่ ห้ามลบ/rename/ย้ายแถวเพียงเพื่อให้เหลือ 4 หน้า เพราะ runtime มีชื่อแท็บและ D1 row mapping ผูกอยู่

### สัญญาเงินหน้าร้านที่ต้องรักษา

- Cash ที่กรอกคือเงินสดนับจริง **หลังซื้อของ** และ **ไม่รวมเงินทอนประจำ 2,500 บาท**; ห้ามหักรายจ่ายหน้าร้านหรือเงินทอนซ้ำ
- ยอดขายเงินสดที่คำนวณ = เงินสดคงเหลือ + รายจ่ายจาก `CASH_DRAWER` ที่ตรวจฐานแล้ว
- ยอดขายปรับมัดจำ = ยอดขายเงินสดที่คำนวณ + เงินโอนรับจริง − เงินรับล่วงหน้าวันรับ + มัดจำที่ตัดเมื่อส่งมอบ
- รายจ่าย `SHOP_BANK` / บัตรเครดิตไม่บวกกลับเป็นยอดขายเงินสด; `cash + SHOP_BANK` ไม่ใช่เงินหน้าร้าน
- `SRC_ACTUAL_1069`: B = เงินสดคงเหลือ, C = เงินโอนรับจริง, L = จ่ายจากหน้าร้าน, M = ยอดขายปรับแล้ว, R/S = ยืนยัน/สถานะปิดยอด, T = เงินสดต่างฐาน, U/V = รับล่วงหน้า/ตัดเมื่อส่งมอบ
- `รายวัน`: U เป็นวันที่สำหรับสรุป, W เป็นแหล่งเงิน, I และ R เป็นฐานสรุปรายจ่ายที่หน้าหลักใช้อยู่ ต้องตรวจ headers/สูตรก่อนเขียน; ไม่รวม I + R ซ้ำกับ line items
- ค่าว่าง, ศูนย์, สูตรผิด, รอปิดยอด และรอยืนยันเป็นคนละสถานะ ห้ามเปลี่ยนทั้งหมดเป็นศูนย์หรือ PASS

เลขแถวข้างต้นเป็นตำแหน่งที่ตรวจ ณ วันบันทึก ไม่ใช่ fixed capacity สำหรับเว็บหรืออนุญาตให้แก้ข้อมูลย้อนหลัง

## Expense Documents V1.2

`V52_EXPENSE_RAW` คง 10 คอลัมน์เดิมไว้ก่อน แล้วเพิ่มท้ายแบบ additive: `Submitted_By_Staff_ID`, `Branch_ID`, `Document_ID`, `Document_Type`, `Vendor`, `Document_Number`, `Order_ID`. ห้ามใช้ Sheet เป็นแหล่งสิทธิ์หรือแก้สถานะ Expense โดยตรง.

`รายวัน` รับเฉพาะ Expense `CONFIRMED`. จำนวนเงินคือ final cash outflow หลังส่วนลด/subsidy และเขียน **หนึ่งแถวสรุปต่อ Expense** เสมอด้วย key `Expense_ID`.

วิธีจ่ายและแหล่งเงินเป็นคนละ field: `cash` + `SHOP_BANK` ลงคอลัมน์เงินสด
และ W=`บัญชีร้าน`, ส่วน `cash` + `CASH_DRAWER` ลงเงินสดและ W=`ทอน/หน้าร้าน`.
`transfer` + `SHOP_BANK` ลงคอลัมน์เงินโอนและ W=`บัญชีร้าน` ตามเดิม.
RAW ต้องเก็บคู่ค่าทั้งสองตาม D1 ไม่อนุมานว่า cash ทุกกรณีมาจากหน้าร้าน.

`รายละเอียดการซื้อ` เป็น private detail ledger ใหม่ที่เขียนหนึ่งแถวต่อ `expense_document_items` โดยใช้ key `Expense_ID|Item_ID`. มี 20 คอลัมน์: Purchase_Item_ID, Expense_ID, Document_ID, วันที่ซื้อ, บริษัท/ร้านค้า, เลขที่เอกสาร, รายการสินค้า, จำนวน, หน่วย, ราคาต่อหน่วย, ส่วนลดรายการ, จำนวนเงินรายการ, ส่วนลด/ปรับยอดระดับเอกสาร, ยอดจ่ายจริงของ Expense, หมวด, สาขา, สถานะ, Evidence ref (private), Created_At และ Updated_At / Cancelled_At. ห้ามใช้รายละเอียดนี้คำนวณยอดรายวันแทน final paid.

ส่วนลด, voucher, subsidy, shipping และ adjustment ระดับเอกสารจะไม่ถูกเดาแจกลง line item: ระบบบันทึก adjustment aggregate เพียงครั้งเดียวใน detail ledger และ `รายวัน` ใช้ final paid. `V52_EXPENSE_RAW` ยังคงมี summary หนึ่งแถวต่อ Expense เสมอ.

Delivery Order และ payment evidence ไม่สร้าง detail row ซ้ำ; ใช้ primary purchase document เท่านั้น. Undo/CANCELLED อัปเดตเฉพาะ detail rows ของ Expense นั้นเป็น `CANCELLED` พร้อมเวลา โดยคง D1/audit/evidence ไว้.

เมื่อเดือนนั้นไม่มี detail row ว่าง Worker จะ insert detail row ก่อนแถว `รวม`, คัดลอกรูปแบบ/สูตรจาก detail row ก่อนหน้า, ล้างเฉพาะ writable input cells และเลื่อน `sheet_row_index` หลัง total อย่าง idempotent. สูตร, total และ manual/fixed row ห้ามถูกเขียนทับ. `รายละเอียดการซื้อ` ใช้ append-only mapping แยกจึงไม่เปลี่ยน month block หรือสูตรรายวัน.

## Attendance LINE flow

พนักงานใช้ Flow เดิม:

1. ส่งรูปเข้างานตอนเช้า
2. ส่งรูปออกงานตอนเย็น

LINE แสดงรายละเอียดการลงเวลา ได้แก่ ชื่อ วันที่ เวลา Timestamp บนภาพ ผลตรวจ GPS ผลยืนยันนาฬิการ้าน นาทีสาย และสถานะ

LINE ห้ามแสดงค่าแรง ยอดหัก OT ยอดจ่ายสุทธิ หรือสรุป Payroll

## HR_STAFF_CONFIG

คอลัมน์หลัก:

- `Employee_ID`
- `Staff_Name`
- `LINE_User_ID`
- `Scheduled_In`
- `Scheduled_Out`
- `Status`
- `Daily_Wage`
- `Grace_Min`
- `Wage_Effective_From`

เมื่อเปลี่ยน `Daily_Wage` ต้องระบุ `Wage_Effective_From` เป็น `YYYY-MM-DD`

## HR_WAGE_HISTORY

ใช้รายงานประวัติค่าแรงตาม Effective Date จาก D1

- `Wage_ID`
- `Employee_ID`
- `Staff_Name`
- `Daily_Wage_Baht`
- `Effective_From`
- `Effective_To`
- `Source`
- `Note`
- `Version`
- `Created_At`
- `Updated_At`

## HR_SHIFT_SCHEDULE

ใช้กำหนดวันที่ต้องทำงานเพื่อแยกวันขาดงานออกจากวันหยุด

- `Work_Date`
- `Employee_ID`
- `Staff_Name`
- `Scheduled_In`
- `Scheduled_Out`
- `Daily_Wage_Snapshot_Baht`
- `Wage_Source_ID`
- `Status`
- `Note`
- `Version`
- `Updated_At`

สถานะ:

- `EXPECTED`
- `DAY_OFF`
- `CANCELLED`

## HR_OT_REQUESTS

ใช้ตรวจรายการ OT แบบเหมาโดย Owner

- `OT_ID`
- `Work_Date`
- `Employee_ID`
- `Staff_Name`
- `Reason`
- `Planned_Start`
- `Planned_End`
- `Fixed_Amount_Baht`
- `Requested_By`
- `Owner_Preapproved_At`
- `Employee_Confirm_Status` ซึ่งใช้ `NOT_REQUIRED`
- `Employee_Confirmed_At`
- `Owner_Final_Status`
- `Owner_Final_Amount_Baht`
- `Owner_Final_At`
- `Actual_OT_Min`
- `Status`
- `Note`
- `Version`
- `Updated_At`

## V52_DAILY_PAYROLL

เพิ่มข้อมูล:

- `Wage_Source_ID`
- `Daily_Wage_Snapshot_Baht`
- `Late_Deduction_Baht`
- `Missing_Punch_Type`
- `Missing_Punch_Deduction_Baht`
- `OT_Approved_Baht`
- `Other_Adjustment_Baht`
- `Net_Pay_Baht`
- `Payroll_Policy_Code`
- `Finalized_At`

## V52_WEEKLY_PAYROLL

เพิ่มข้อมูล:

- `Base_Wage_Total_Baht`
- `Late_Deduction_Total_Baht`
- `Missing_Punch_Deduction_Total_Baht`
- `OT_Total_Baht`
- `Other_Adjustment_Total_Baht`
- `Net_Pay_Baht`
- `Pending_Review_Count`

ห้ามแก้แถวรายงาน `V52_*`, `HR_WAGE_HISTORY` หรือ `HR_OT_REQUESTS` ด้วยมือ ให้แก้ผ่าน Admin flow หรือ Input sheet ที่กำหนด
