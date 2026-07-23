# Mapping จาก MaliPang_OWNER_MASTER

## แหล่งพนักงานที่เชื่อถือ

อ่านจาก `HR_STAFF_CONFIG`:

| Google Sheet | D1 |
|---|---|
| Employee_ID | employee_id |
| Staff_Name | staff_name |
| LINE_User_ID | line_user_id |
| Scheduled_In | scheduled_in |
| Scheduled_Out | scheduled_out |
| Daily_Wage | daily_wage_satang |
| Grace_Min | grace_min |
| Late_Deduction_Baht | late_deduction_satang |
| Deduct_Late / Deduct_Early | เปิดหรือปิดยอดหักแบบคงที่ |
| Status | status |

หากเพิ่มคอลัมน์ `Can_Submit_Expense` ระบบจะอ่านและอัปเดตสิทธิ์ Expense ด้วย ถ้าไม่มีคอลัมน์นี้จะคงสิทธิ์เดิมใน D1 และสามารถตั้งผ่าน `/admin/expense-access`

ห้าม import ชื่อพนักงานจาก `HR_ATTENDANCE_RAW` เพราะพบประวัติบางช่วงที่ EMP001/EMP002 สลับชื่อกัน

## แท็บ Shadow ที่ระบบสร้าง

- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`

ระบบไม่เขียนทับ `HR_DAILY_PAYROLL` หรือ `HR_WEEKLY_PAYROLL` ซึ่งมีข้อมูลและสูตรเดิม

`V52_ATTENDANCE_RAW` เก็บข้อมูลตรวจสอบเพิ่มต่อท้าย ได้แก่ `Attendance_Source`, `Photo_DateTime`, `GPS_Lat`, `GPS_Lng`, `Distance_M`, `Clock_Evidence`, `Clock_Confidence`, `Overlay_Raw_Text` และ `Image_SHA256` โดย `Work_Date`/`Official_Time` มาจาก Photo Timestamp เท่านั้น

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
