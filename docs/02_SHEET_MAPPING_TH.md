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
| Status | status |

หากเพิ่มคอลัมน์ `Can_Submit_Expense` ระบบจะอ่านสิทธิ์ Expense ได้ด้วย มิฉะนั้นให้ตั้งผ่าน `/admin/expense-access`

ห้าม import ชื่อพนักงานจาก `HR_ATTENDANCE_RAW` เพราะพบประวัติบางช่วงที่ EMP001/EMP002 สลับชื่อกัน

## แท็บ Shadow ที่ระบบสร้าง

- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`

ระบบไม่เขียนทับ `HR_DAILY_PAYROLL` หรือ `HR_WEEKLY_PAYROLL` ซึ่งมีข้อมูลและสูตรเดิม

## Expense รุ่นนี้

ใช้ key ให้ตรง master เดิม เช่น `ingredients`, `packaging`, `gas`, `utilities`, `CASH_DRAWER`, `SHOP_BANK` รูปใบเสร็จและสลิปจะเก็บรอตรวจ ไม่แตกสินค้าหรือบันทึกยอดอัตโนมัติ
