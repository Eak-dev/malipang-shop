# Mapping จาก MaliPang_OWNER_MASTER

## หลักการ

- D1 เป็นฐานข้อมูลและตัวคำนวณหลัก
- Google Sheets เป็น Input/Reporting interface
- ห้ามแก้แถวรายงาน `V52_*` ด้วยมือ
- ค่าแรงใน Payroll ต้องใช้ Snapshot ตามวันที่ ห้ามคำนวณประวัติย้อนหลังจากค่าแรงปัจจุบัน

## แหล่งพนักงานที่เชื่อถือ

อ่านจาก `HR_STAFF_CONFIG`:

| Google Sheet | D1 |
|---|---|
| Employee_ID | employee_id |
| Staff_Name | staff_name |
| LINE_User_ID | line_user_id |
| Scheduled_In | scheduled_in |
| Scheduled_Out | scheduled_out |
| Daily_Wage | employees.daily_wage_satang สำหรับค่าปัจจุบัน/fallback |
| Wage_Effective_From | employee_wage_history.effective_from เมื่อค่าแรงเปลี่ยน |
| Grace_Min | grace_min |
| Late_Deduction_Baht | legacy flat setting; Payroll policy ใหม่ไม่ใช้ค่านี้สำหรับขั้น 50/100/ครึ่งวัน |
| Deduct_Late / Deduct_Early | legacy enable/disable fields |
| Status | status |
| Can_Submit_Expense | can_submit_expense |

เมื่อ `Daily_Wage` ของพนักงานเดิมเปลี่ยน ต้องระบุ `Wage_Effective_From` เป็น `YYYY-MM-DD` มิฉะนั้น Import จะถูกปฏิเสธ

ห้าม import ชื่อพนักงานจาก `HR_ATTENDANCE_RAW` เพราะพบประวัติบางช่วงที่ EMP001/EMP002 สลับชื่อกัน

## Wage history

ชีท `HR_WAGE_HISTORY` แสดงข้อมูลจาก `employee_wage_history`:

| Google Sheet | D1 |
|---|---|
| Wage_ID | wage_id |
| Employee_ID | employee_id |
| Daily_Wage_Baht | daily_wage_satang / 100 |
| Effective_From / Effective_To | effective_from / effective_to |
| Source / Note / Version | source / note / version |

ระบบเลือกค่าแรงด้วย `Employee_ID + Work_Date` แล้วเก็บ `Daily_Wage_Snapshot_Baht` และ `Wage_Source_ID` ใน Payroll รายวัน

## Shift schedule

ชีท `HR_SHIFT_SCHEDULE` เป็น Input/Report สำหรับ `employee_shift_days`:

| Google Sheet | D1 |
|---|---|
| Work_Date | work_date |
| Employee_ID | employee_id |
| Scheduled_In / Scheduled_Out | scheduled_in / scheduled_out |
| Daily_Wage_Snapshot_Baht | daily_wage_snapshot_satang |
| Wage_Source_ID | wage_source_id |
| Status | EXPECTED / DAY_OFF / CANCELLED |
| Note / Version | note / version |

Both-punch missing จะถูกตรวจเฉพาะแถว `EXPECTED` เท่านั้น เพื่อไม่ให้วันหยุดถูกนับเป็นขาดงาน

## Fixed OT

ชีท `HR_OT_REQUESTS` แสดงข้อมูลจาก `ot_requests`:

| Google Sheet | D1 |
|---|---|
| OT_ID | ot_id |
| Work_Date / Employee_ID | work_date / employee_id |
| Fixed_Amount_Baht | fixed_amount_satang / 100 |
| Employee_Confirm_Status | employee_confirm_status |
| Owner_Final_Status | owner_final_status |
| Owner_Final_Amount_Baht | owner_final_amount_satang / 100 |
| Actual_OT_Min | actual_ot_minutes |
| Status / Version | status / version |

OT จะเข้า Payroll เฉพาะรายการที่พนักงาน `ACCEPTED` และ Owner Final เป็น `APPROVED`

## แท็บ V5.2 ที่ระบบเขียน

- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `HR_WAGE_HISTORY`
- `HR_SHIFT_SCHEDULE`
- `HR_OT_REQUESTS`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`

ระบบไม่เขียนทับ `HR_DAILY_PAYROLL` หรือ `HR_WEEKLY_PAYROLL` ซึ่งมีข้อมูลและสูตรเดิม

`V52_ATTENDANCE_RAW` เก็บข้อมูลตรวจสอบเพิ่มต่อท้าย ได้แก่ `Attendance_Source`, `Photo_DateTime`, `GPS_Lat`, `GPS_Lng`, `Distance_M`, `Clock_Evidence`, `Clock_Confidence`, `Overlay_Raw_Text` และ `Image_SHA256` โดย `Work_Date`/`Official_Time` มาจาก Photo Timestamp เท่านั้น

`V52_DAILY_PAYROLL` เก็บค่าแรง Snapshot, แหล่งค่าแรง, Late deduction, Missing-punch deduction, OT, Other adjustment, Net pay และ Policy code

`V52_WEEKLY_PAYROLL` เก็บ Base wage, Late deduction, Missing-punch deduction, OT, Other adjustment, Net pay และ Pending review count

## Expense รุ่นนี้

ใช้ key ให้ตรง master เดิม เช่น `ingredients`, `packaging`, `gas`, `utilities`, `CASH_DRAWER`, `SHOP_BANK` รูปใบเสร็จทั่วไปยังเก็บรอตรวจและไม่แตกสินค้า ส่วน Bank slip/KBank/SCB/เป๋าตังที่อ่านข้อมูลสำคัญครบจะสร้างรายการรอยืนยันให้ผู้ใช้ตรวจใน LINE

ค่าใช้จ่ายที่ `CONFIRMED` จะเขียนสองจุด:

1. `V52_EXPENSE_RAW` เป็น audit trail และข้อมูลสำหรับกู้คืน
2. `รายวัน` เป็นรายงานบัญชีเดิมที่เจ้าของร้านใช้งาน

### Mapping ไป `รายวัน`

| ข้อมูล | คอลัมน์ |
|---|---|
| เดือน / วัน / รายการ | B / C / D |
| เงินสดแบบ NON-FIXED | G |
| เงินโอน | H |
| Kbank / First Choice / Aeon / Citibank / TTB / Homepro / The 1 | K ถึง Q ตามหัวตาราง |
| Category / แหล่งเงิน | V / W |

Bank slip ทุกธนาคารและ G-Wallet ใช้ `payment_key=transfer` และ `source_wallet=SHOP_BANK` เสมอ จึงลงยอดจ่ายจริงใน H และแสดง `บัญชีร้าน` ใน W เป๋าตังใช้ยอดสุดท้ายที่จ่ายจริง ไม่ใช้ราคาก่อนส่วนลด ข้อมูล audit ที่ชีทเดิมไม่มีคอลัมน์รองรับ เช่น สถาบัน เลขอ้างอิง ผู้ส่ง/ผู้รับ ยอดก่อนส่วนลด ส่วนลด และ image key จะเก็บใน `expense_documents`/R2 แทน

ระบบหาเดือนจากแถวหัวข้อ `รายรับทั้งหมดในบัญชี` หาแถวสิ้นสุดจาก `รวม` และใช้เฉพาะแถวว่างก่อนแถวรวม บัตรเครดิตใช้วันตัดรอบที่อยู่ในแถว 2 ของคอลัมน์บัตร ถ้าวันรายการเกินวันตัดรอบจะลงเดือนถัดไป และปรับวันที่ให้ไม่เกินวันสุดท้ายของเดือน

ระบบล้างเฉพาะ B:D, F:H, K:Q และ V:W ก่อนเขียนหรือเมื่อ Undo จึงรักษาสูตรใน I, J, R, S และ U ไว้เสมอ ถ้าบล็อกเดือนเต็มหรือไม่พบหัวตาราง งานจะ Failed/Retry แทนการเขียนทับ `รวม`
