# Payroll V1 — รอบพฤหัสบดี–พุธ จ่ายวันพุธ

## กติกา

- รอบงานเริ่มวันพฤหัสบดีและสิ้นสุดวันพุธ รวม 7 วัน
- จ่ายเงินในวันพุธเดียวกับวันปิดรอบ
- ตัวอย่าง: รอบ 23–29 กรกฎาคม 2026 จ่าย 29 กรกฎาคม 2026
- วันที่ 30 กรกฎาคมเริ่มรอบใหม่ ซึ่งจ่าย 5 สิงหาคม 2026

## Google Sheets

ชีท `V52_WEEKLY_PAYROLL` ใช้หัวตาราง:

- `Pay_Date` = วันพุธที่จ่ายและเป็นวันปิดรอบ
- `Period_Start` = วันพฤหัสบดี
- `Period_End` = วันพุธ

ระบบยังคงใช้คอลัมน์ฐานข้อมูลเดิม `week_start` และ `pay_sunday` เพื่อ backward compatibility แต่ค่าที่เขียนใหม่หมายถึง `Period_Start` และ `Period_End` ตามลำดับ ห้ามแก้หรือ rewrite Payroll Snapshot เดิมย้อนหลัง

## Preview ก่อนจ่าย

Preview ต้องใช้ Admin Token และไม่เขียน D1, Google Sheets หรือ Queue

```http
POST /admin/payroll/preview
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "fromDate": "2026-07-23",
  "toDate": "2026-07-29"
}
```

ตรวจอย่างน้อย:

- `periodStart` ต้องเป็น `2026-07-23`
- `periodEnd` ต้องเป็น `2026-07-29`
- `payDate` ต้องเป็น `2026-07-29`
- ค่าแรง Snapshot ของพนักงานแต่ละคน
- ยอดสายและ Missing Punch ไม่ถูกหักซ้อน
- OT ตรงรายการที่ Owner อนุมัติ
- `pendingReviewCount` ต้องเคลียร์ก่อนจ่าย หรือมีเหตุผลและ Owner ยืนยัน

## Apply หลังตรวจ Preview

```http
POST /admin/payroll/apply
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "fromDate": "2026-07-23",
  "toDate": "2026-07-29",
  "runId": "payroll-2026-07-29-v1",
  "requestedBy": "OWNER"
}
```

`runId` ต้องไม่ซ้ำ รายการที่ Apply สำเร็จจะถูกบันทึกใน `payroll_runs`

เมื่อส่ง `runId` เดิมซ้ำ ระบบคืนผลเดิมและไม่บวกค่าแรง ยอดหัก หรือ OT ซ้ำ

## กติกายอดหักในรายงาน

กรณีสายและขาด Punch ในวันเดียวกัน ระบบใช้ยอดที่สูงกว่าเพียงรายการเดียว

ตัวอย่าง:

- ค่าแรง 500 บาท
- สาย 35 นาที = 100 บาท
- ขาด OUT = 250 บาท
- รายงานต้องแสดง Late applied = 0 บาท
- Missing Punch applied = 250 บาท
- Net = 250 บาท

จึงสามารถกระทบยอดจาก Base, Deduction, OT และ Net ได้ตรงโดยไม่ตีความว่าหัก 350 บาท

## Cutover วันที่ 29 กรกฎาคม 2026

ดำเนินการผ่าน Issue #22 เท่านั้น:

1. ยืนยัน exact commit SHA
2. Backup Remote D1 ใหม่ เก็บ Private พร้อม SHA-256
3. บันทึก Worker version ปัจจุบันเพื่อ Rollback
4. ตรวจว่า Migration 0007 และ 0008 ถูก Apply แล้ว โดยไม่แก้ migration เดิม
5. Bootstrap/ตรวจ Google Sheets headers เป็น `Pay_Date`, `Period_Start`, `Period_End`
6. Import/ตรวจ Wage History โดยไม่เดาค่าแรง
7. รัน Preview รอบ 23–29 กรกฎาคม
8. Owner ตรวจยอดและคำนวณมืออย่างน้อย 2 คน
9. Apply ด้วย Run ID ที่กำหนดครั้งเดียว
10. เปลี่ยน Runtime เฉพาะผ่าน Production Change ที่อนุมัติและเมื่อ Health/Readiness/Queue/DLQ/Lost/Duplicate/Reconcile ผ่าน
11. ตรวจ Attendance และ Expense จริงตามธรรมชาติ
12. Monitor และเริ่ม Production Day-1 Audit #23

การ Merge โค้ด Payroll ไม่ถือเป็นการอนุญาต Deploy, เปลี่ยน `RUNTIME_MODE`, เปลี่ยน LINE Webhook, Secret หรือปิด Legacy Apps Script

## Rollback

Rollback Worker ไปเวอร์ชันที่บันทึกไว้ โดยไม่ Drop Migration 0007/0008 และไม่ลบ Payroll Run/Audit

หยุดจ่ายและ Rollback เมื่อ:

- ยอด Preview อธิบายไม่ได้
- Payroll ซ้ำหรือ D1 ไม่ตรง Sheets
- Attendance/Expense ผิดหรือสูญหาย
- Health/Readiness ไม่ผ่าน
- Queue, Failed jobs หรือ DLQ ค้าง
