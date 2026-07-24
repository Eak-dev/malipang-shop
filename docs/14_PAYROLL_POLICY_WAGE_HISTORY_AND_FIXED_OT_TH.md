# Payroll Policy — ค่าแรงตามวันที่ การหักมาสาย และ OT แบบเหมา

เอกสารนี้อธิบายระบบที่พัฒนาใน Issue #17 / PR #18

> D1 เป็น Source of Truth ส่วน Google Sheets เป็น Input/Reporting interface เท่านั้น

## 1. กติกาค่าแรง

ค่าแรงเป็นรายพนักงานและมีวันที่เริ่มใช้ (`Effective_From`) ห้าม hard-code ค่าแรง 500 บาทหรือยอดครึ่งวัน 250 บาท

ระบบเลือกค่าแรงตามลำดับ:

1. ค้น `employee_wage_history` ด้วย `Employee_ID + Work_Date`
2. ใช้รายการที่ `Effective_From <= Work_Date` และ `Effective_To` ว่างหรือครอบคลุมวันนั้น
3. เมื่อสร้าง Payroll รายวัน ให้บันทึก `Daily_Wage_Snapshot_Baht` และ `Wage_Source_ID`
4. หากค่าแรงเปลี่ยนภายหลัง Payroll เก่าจะไม่ถูกคำนวณใหม่จากค่าแรงปัจจุบัน

### การเปลี่ยนค่าแรง

ใช้ `POST /admin/payroll/wage`

```json
{
  "employeeId": "EMP001",
  "dailyWageBaht": 600,
  "effectiveFrom": "2026-08-01",
  "note": "ปรับค่าแรงเดือนสิงหาคม"
}
```

หรือใส่คอลัมน์ `Wage_Effective_From` ใน `HR_STAFF_CONFIG` ก่อน Import พนักงาน เมื่อ `Daily_Wage` เปลี่ยนจากค่าเดิม ระบบจะปฏิเสธการ Import หากไม่ระบุวันที่เริ่มใช้

## 2. กติกามาสาย

ระบบคำนวณจากเวลาสายจริงเทียบกับ `Scheduled_In`

| เวลาสายจริง | ยอดหัก |
|---:|---:|
| 0–5 นาที | 0 บาท |
| 6–29 นาที | 50 บาท |
| 30–89 นาที | 100 บาท |
| 90 นาทีขึ้นไป | 50% ของ Daily Wage Snapshot |

ตัวอย่างค่าแรง 550 บาท:

- สาย 6 นาที: หัก 50 บาท เหลือ 500 บาท
- สาย 30 นาที: หัก 100 บาท เหลือ 450 บาท
- สาย 90 นาที: หัก 275 บาท เหลือ 275 บาท

## 3. กรณีลงเวลาไม่ครบ

| สถานการณ์ | กติกา |
|---|---|
| มี IN และ OUT | คำนวณมาสายตามขั้น |
| มี IN แต่ไม่มี OUT | หัก 50% ของ Daily Wage Snapshot หลังวันทำงานจบ |
| ไม่มี IN แต่มี OUT | หัก 50% ของ Daily Wage Snapshot หลังวันทำงานจบ |
| ไม่มีทั้ง IN และ OUT | หักเต็มวันและส่ง Review เฉพาะวันที่มี Expected Shift |

### ป้องกันการหักซ้ำ

Late และ Missing Punch ไม่บวกซ้อนกัน ระบบใช้ยอดที่สูงกว่า

ตัวอย่างค่าแรง 500 บาท สาย 35 นาทีและไม่มี OUT:

- Late = 100 บาท
- Missing OUT = 250 บาท
- หักจริง = 250 บาท ไม่ใช่ 350 บาท

### เวลา Finalize

- ระหว่างวัน One-punch จะยังอยู่ `REVIEW`
- Cron จะ Finalize One-punch หลังวันทำงานนั้นผ่านไปแล้ว เพื่อไม่หักระหว่างกะหรือระหว่าง OT
- Both-punch missing จะสร้างได้เฉพาะรายการ `EXPECTED` ใน `HR_SHIFT_SCHEDULE`
- วันหยุดต้องตั้ง `DAY_OFF` เพื่อไม่ให้ถูกมองเป็นขาดงาน

## 4. ตารางกะทำงาน

ใช้ชีท `HR_SHIFT_SCHEDULE`

| คอลัมน์ | ใช้ทำอะไร |
|---|---|
| Work_Date | วันที่ทำงาน YYYY-MM-DD |
| Employee_ID | รหัสพนักงาน |
| Scheduled_In / Scheduled_Out | เวลาเริ่มและสิ้นสุดกะ |
| Status | EXPECTED / DAY_OFF / CANCELLED |
| Note | หมายเหตุ |

นำเข้าด้วย:

```text
POST /admin/import-shifts-from-sheet
```

ค่าแรง Snapshot และ Wage Source จะถูก Resolve ตอน Import กะ

## 5. OT แบบเหมาจำนวนเงิน

OT ไม่เข้าค่าแรงจนกว่าจะผ่าน 3 ขั้น:

1. Owner Preapproval
2. Employee กดยืนยันใน LINE
3. Owner Final approval หลังทำงาน

### สร้าง OT

```json
POST /admin/ot/request
{
  "employeeId": "EMP001",
  "workDate": "2026-08-01",
  "reason": "เตรียมไส้เพิ่ม",
  "plannedStart": "16:00",
  "plannedEnd": "18:00",
  "fixedAmountBaht": 200,
  "note": "งานเพิ่มก่อนวันเสาร์"
}
```

พนักงานจะได้รับปุ่ม:

- ยืนยันทำ OT
- ไม่สะดวก

### Owner ยืนยันยอดสุดท้าย

```json
POST /admin/ot/finalize
{
  "otId": "<OT_ID>",
  "approved": true,
  "finalAmountBaht": 200,
  "note": "งานเสร็จครบ"
}
```

ระบบจะคำนวณ `Actual_OT_Min` จาก Attendance เพื่อ Audit แต่ยอดจ่ายใช้ Fixed Amount ที่ Owner อนุมัติ

## 6. Google Sheets

### Input / master

- `HR_STAFF_CONFIG` เพิ่ม `Wage_Effective_From`
- `HR_SHIFT_SCHEDULE`

### Audit / reporting

- `HR_WAGE_HISTORY`
- `HR_OT_REQUESTS`
- `V52_DAILY_PAYROLL` เพิ่ม Wage Source, Wage Snapshot, Deduction, OT และ Net Pay
- `V52_WEEKLY_PAYROLL` เพิ่ม Base Wage, Deduction, OT, Net Pay และ Pending Review Count

ห้ามแก้แถวรายงาน `V52_*` ด้วยมือ ให้แก้ผ่าน Admin flow หรือ Input sheet ที่กำหนด

## 7. UAT ที่ต้องทำก่อน Deploy จริง

### Wage history

- [ ] พนักงาน A ค่าแรง 500 และพนักงาน B ค่าแรง 600 ในวันเดียวกัน
- [ ] เปลี่ยนค่าแรง A เป็น 650 ในวันถัดไป
- [ ] Payroll วันเก่ายังคง Snapshot 500
- [ ] Payroll วันใหม่ใช้ Snapshot 650
- [ ] Import ค่าแรงที่เปลี่ยนโดยไม่ใส่ Effective Date ถูกปฏิเสธ

### Late boundaries

- [ ] 5 นาที = 0
- [ ] 6 นาที = 50
- [ ] 29 นาที = 50
- [ ] 30 นาที = 100
- [ ] 89 นาที = 100
- [ ] 90 นาที = 50% ของค่าแรงรายบุคคล

### Missing punch

- [ ] IN อย่างเดียว Finalize เป็นครึ่งค่าแรงหลังวันจบ
- [ ] OUT อย่างเดียว Finalize เป็นครึ่งค่าแรงหลังวันจบ
- [ ] Late + Missing ใช้ยอดสูงกว่า ไม่บวกซ้อน
- [ ] Both missing + EXPECTED = เต็มวันและ Review
- [ ] Both missing + DAY_OFF = ไม่สร้าง Payroll ขาดงาน
- [ ] Admin Correction คำนวณใหม่และเก็บ Audit

### Fixed OT

- [ ] Owner สร้าง OT 100 บาท
- [ ] พนักงาน Accept ผ่าน LINE
- [ ] ก่อน Owner Final ยอด OT ยังไม่เข้า Payroll
- [ ] Owner Final 100 บาทแล้ว Daily/Weekly Payroll เพิ่ม 100 บาท
- [ ] Employee Decline แล้ว Owner ไม่สามารถ Approve จ่ายได้
- [ ] Missing OUT ทำให้ Owner ต้องตรวจ Attendance ก่อนยืนยัน OT

### Reconcile

- [ ] D1 ตรง `HR_WAGE_HISTORY`
- [ ] D1 ตรง `HR_SHIFT_SCHEDULE`
- [ ] D1 ตรง `HR_OT_REQUESTS`
- [ ] Daily/Weekly breakdown ตรงการคำนวณมือ
- [ ] Duplicate/Lost event = 0
- [ ] Queue/Failed/DLQ ค้าง = 0

## 8. ลำดับ Deploy

1. Review และ Merge PR โดยยังไม่ Deploy
2. เปิด Production Change Issue แยก
3. Backup Remote D1 และบันทึก Worker version สำหรับ Rollback
4. Apply Migration 0007
5. ตรวจ tables/columns/indexes
6. Deploy Worker โดยคง `RUNTIME_MODE=shadow`
7. เรียก `/admin/bootstrap-sheets`
8. Import/ตรวจ Wage History และ Shift Schedule
9. UAT ตามรายการด้านบน
10. ตรวจ D1 ↔ Sheets ↔ Payroll มือ
11. จึงพิจารณาเปิดใช้ยอดหักจริง

## 9. Rollback

- Rollback Worker ไป version ก่อนหน้า
- ห้าม Drop ตารางหรือคอลัมน์จาก Migration 0007 ระหว่างเหตุฉุกเฉิน
- ข้อมูลใหม่สามารถคงไว้แต่ Worker เก่าจะไม่ใช้งาน
- ตรวจ Attendance, Daily/Weekly Payroll, Queue และ Sheets หลัง Rollback

## 10. ข้อควรระวัง

กติกาหัก 50/100/ครึ่งวันเป็นนโยบายที่ Owner เลือก แต่การนำไปหักค่าจ้างจริงควรให้ผู้เชี่ยวชาญกฎหมายแรงงานหรือสำนักงานสวัสดิการและคุ้มครองแรงงานตรวจระเบียบและเอกสารยินยอมก่อนเปิดใช้งานจริง
