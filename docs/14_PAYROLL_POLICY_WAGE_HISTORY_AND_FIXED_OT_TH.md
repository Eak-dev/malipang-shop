# Payroll Policy — ค่าแรงตามวันที่ การหักมาสาย และ OT แบบเหมา

เอกสารนี้อธิบายระบบใน Issue #17 / PR #18

> D1 เป็น Source of Truth และ Google Sheets เป็นหน้าสำหรับ Owner ตรวจข้อมูลทั้งหมด

## 1. หลักการแสดงผล

### LINE ของพนักงาน

พนักงานใช้ Flow เดิมเท่านั้น:

1. ตอนเช้าส่งรูปเข้างาน
2. ระบบตอบชื่อ วันที่ และเวลาเข้า
3. ตอนเย็นส่งรูปออกงาน
4. ระบบตอบชื่อ วันที่ และเวลาออก

LINE ของพนักงานต้องไม่แสดง:

- ค่าแรง
- ยอดหัก
- นาทีสายเพื่อใช้ตัดเงิน
- OT เป็นจำนวนเงิน
- สรุป Payroll รายวันหรือรายสัปดาห์
- ปุ่มยืนยัน OT หรือปุ่ม HR เพิ่มเติม

หากรายการต้องตรวจ ระบบแจ้งเพียงว่า “บันทึกแล้ว และผู้ดูแลจะตรวจสอบข้อมูลเพิ่มเติม” โดยไม่แสดงตัวเลขการเงิน

### Google Sheets ของ Owner

รายละเอียดทั้งหมดแสดงใน:

- `HR_WAGE_HISTORY`
- `HR_SHIFT_SCHEDULE`
- `HR_OT_REQUESTS`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`

## 2. ค่าแรงตาม Effective Date

ค่าแรงเป็นรายพนักงานและมีวันที่เริ่มใช้ ห้าม hard-code ค่าแรง 500 บาทหรือครึ่งวัน 250 บาท

ระบบเลือกค่าแรงตาม `Employee_ID + Work_Date` แล้วบันทึก:

- `Daily_Wage_Snapshot_Baht`
- `Wage_Source_ID`

เมื่อค่าแรงเปลี่ยน Payroll เก่าต้องไม่เปลี่ยนย้อนหลัง

เปลี่ยนค่าแรงผ่าน `POST /admin/payroll/wage` หรือ Import `HR_STAFF_CONFIG` โดยต้องใส่ `Wage_Effective_From` เมื่อยอดค่าแรงเปลี่ยน

## 3. กติกามาสาย

คำนวณจากเวลาสายจริงเทียบกับ `Scheduled_In`

| เวลาสายจริง | ยอดหัก |
|---:|---:|
| 0–5 นาที | 0 บาท |
| 6–29 นาที | 50 บาท |
| 30–89 นาที | 100 บาท |
| 90 นาทีขึ้นไป | 50% ของ Daily Wage Snapshot |

ยอดนี้บันทึกใน Google Sheets เท่านั้น ไม่ตอบกลับพนักงานผ่าน LINE

## 4. ลงเวลาไม่ครบ

| สถานการณ์ | กติกา |
|---|---|
| มี IN และ OUT | คำนวณมาสายตามขั้น |
| มี IN แต่ไม่มี OUT | หลังวันจบ หัก 50% ของ Daily Wage Snapshot |
| ไม่มี IN แต่มี OUT | หลังวันจบ หัก 50% ของ Daily Wage Snapshot |
| ไม่มีทั้ง IN และ OUT | ใช้ 100% ของ Daily Wage Snapshot และส่ง Review เฉพาะวันที่มี `EXPECTED` Shift |

Late และ Missing Punch ไม่บวกซ้อน ใช้ยอดที่สูงกว่า

ระหว่างวัน One-punch ยังอยู่ `REVIEW` เพื่อไม่หักก่อนพนักงานส่งรูปออก ส่วน Both-punch missing จะเกิดได้เฉพาะวันที่ Owner ระบุ `EXPECTED`

## 5. ตารางกะ

ใช้ `HR_SHIFT_SCHEDULE`

| Status | ความหมาย |
|---|---|
| `EXPECTED` | ต้องมาทำงาน ใช้ตรวจกรณีไม่มีทั้ง IN และ OUT |
| `DAY_OFF` | วันหยุด ไม่สร้างรายการขาดงาน |
| `CANCELLED` | ยกเลิกกะ |

ไม่จำเป็นต้องกำหนดวันหยุดทั้งเดือน สามารถใส่กะล่วงหน้าเป็นรายวันหรือรายสัปดาห์ได้ หากไม่มีแถว `EXPECTED` ระบบจะไม่ตัดสินว่าไม่มี Punch คือขาดงานเต็มวัน

## 6. OT แบบเหมาจำนวนเงิน

OT เป็น Owner-managed workflow และไม่ต้องให้พนักงานกดปุ่มใน LINE

ขั้นตอน:

1. Owner สร้าง OT ล่วงหน้า พร้อมวันที่ เหตุผล ช่วงเวลาโดยประมาณ และยอดเหมา
2. พนักงานทำงานตามที่ Owner แจ้งหน้างาน และส่งรูป OUT ตามปกติ
3. หลังมีเวลา OUT Owner ยืนยันหรือปฏิเสธยอดสุดท้าย
4. ระบบจึงรวม OT เข้า Daily/Weekly Payroll

สร้างผ่าน `POST /admin/ot/request` หรือคำสั่ง Owner LINE:

```text
OT Win วันนี้ 200 16:00-18:00 เตรียมไส้เพิ่ม
```

ยืนยันหลังทำงาน:

```text
OT อนุมัติ <OT_ID> 200 งานเสร็จครบ
```

พนักงานไม่ได้รับปุ่มหรือข้อความยอด OT ส่วน Owner LINE ได้เพียงข้อความว่าบันทึกแล้วและให้ดูรายละเอียดใน `HR_OT_REQUESTS`

หากไม่มีเวลา OUT ระบบต้องปฏิเสธการอนุมัติ OT จนกว่าจะแก้ Attendance

## 7. Google Sheets

### Input / master

- `HR_STAFF_CONFIG` เพิ่ม `Wage_Effective_From`
- `HR_SHIFT_SCHEDULE`

### Audit / reporting

- `HR_WAGE_HISTORY`
- `HR_OT_REQUESTS`
- `V52_DAILY_PAYROLL` แสดง Wage Snapshot, Late Deduction, Missing Punch, OT และ Net Pay
- `V52_WEEKLY_PAYROLL` แสดง Base Wage, Deduction, OT, Net Pay และ Pending Review Count

ห้ามแก้แถวรายงาน `V52_*` ด้วยมือ

## 8. UAT ก่อน Deploy จริง

### Employee LINE flow

- [ ] รูป IN ตอบเฉพาะชื่อ วันที่ เวลา
- [ ] รูป OUT ตอบเฉพาะชื่อ วันที่ เวลา
- [ ] LINE ไม่มีค่าแรง ยอดหัก นาทีสายเพื่อการเงิน หรือ OT amount
- [ ] พนักงานไม่มีปุ่ม OT/Payroll ให้กด
- [ ] Duplicate photo แจ้งไม่ต้องส่งซ้ำ

### Wage history

- [ ] พนักงานสองคนใช้ค่าแรงต่างกันในวันเดียวกัน
- [ ] ค่าแรงใหม่เริ่มตาม Effective Date
- [ ] Payroll วันเก่ายังคง Snapshot เดิม
- [ ] เปลี่ยนค่าแรงโดยไม่มี Effective Date ถูกปฏิเสธ

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
- [ ] Late + Missing ใช้ยอดสูงกว่า
- [ ] Both missing + EXPECTED = เต็มวันและ Review
- [ ] Both missing + DAY_OFF หรือไม่มี Expected Shift = ไม่สร้างขาดงาน

### Fixed OT

- [ ] Owner สร้าง OT โดยไม่มีข้อความหรือปุ่มส่งให้พนักงาน
- [ ] ก่อน Owner Final ยอด OT ยังไม่เข้า Payroll
- [ ] Missing OUT ทำให้ Owner Final ไม่ผ่าน
- [ ] Owner Final แล้ว Daily/Weekly Payroll และ `HR_OT_REQUESTS` ตรงกัน

### Reconcile

- [ ] D1 ตรงกับ Sheets ทุกตารางใหม่
- [ ] Daily/Weekly breakdown ตรงการคำนวณมือ
- [ ] Duplicate/Lost event = 0
- [ ] Queue/Failed/DLQ ค้าง = 0

## 9. ลำดับ Deploy

1. Review และ Merge PR โดยยังไม่ Deploy
2. เปิด Production Change Issue แยก
3. Backup Remote D1 และบันทึก Worker version สำหรับ Rollback
4. Apply Migration 0007
5. Deploy Worker โดยคง `RUNTIME_MODE=shadow`
6. เรียก `/admin/bootstrap-sheets`
7. Import/ตรวจ Wage History และ Shift Schedule
8. UAT LINE แบบรูปเข้า/รูปออก และตรวจรายละเอียดใน Sheets
9. ตรวจ D1 ↔ Sheets ↔ Payroll มือ
10. จึงพิจารณาเปิดใช้ยอดหักจริง

## 10. Rollback

- Rollback Worker ไป version ก่อนหน้า
- ห้าม Drop ตารางหรือคอลัมน์จาก Migration 0007 ระหว่างเหตุฉุกเฉิน
- ตรวจ Attendance, Daily/Weekly Payroll, Queue และ Sheets หลัง Rollback

## 11. ข้อควรระวัง

กติกาหักค่าจ้างและ OT กระทบเงินจริง ต้องผ่าน Owner UAT และตรวจข้อกำหนดกฎหมายแรงงานก่อนเปิดใช้จ่ายจริง