# Payroll V1 — รอบพฤหัสบดี–พุธ จ่ายวันพุธ

## กติกา

- รอบงานเริ่มวันพฤหัสบดีและสิ้นสุดวันพุธ รวม 7 วัน
- จ่ายเงินในวันพุธเดียวกับวันปิดรอบ
- รอบเงินจริงรอบแรกที่ล็อกไว้คือ 30 กรกฎาคม–5 สิงหาคม 2026
- จ่ายวันที่ 5 สิงหาคม 2026

> รอบ 23–29 กรกฎาคม 2026 เป็นข้อมูล Historical/Audit เท่านั้น ห้ามใช้คำสั่ง Apply กับรอบนั้น และไม่ใช่เงื่อนไขเปิดระบบรอบนี้

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
  "fromDate": "2026-07-30",
  "toDate": "2026-08-05"
}
```

ตรวจอย่างน้อย:

- `periodStart` ต้องเป็น `2026-07-30`
- `periodEnd` ต้องเป็น `2026-08-05`
- `payDate` ต้องเป็น `2026-08-05`
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
  "fromDate": "2026-07-30",
  "toDate": "2026-08-05",
  "runId": "payroll-2026-08-05-v1",
  "requestedBy": "OWNER"
}
```

`runId` ต้องไม่ซ้ำ รายการที่ Apply สำเร็จจะถูกบันทึกใน `payroll_runs`

เมื่อส่ง `runId` เดิมซ้ำ ระบบคืนผลเดิมและไม่บวกค่าแรง ยอดหัก หรือ OT ซ้ำ

Payroll Apply ทำได้วันที่ 5 สิงหาคม 2026 หลัง Owner อนุมัติแยกเท่านั้น การ Merge หรือ Deploy ไม่ได้อนุญาตให้ Apply

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

## Release Control ที่ล็อกไว้

| Operation | Confirmation | Period / Run ID |
|---|---|---|
| Shadow preflight | `SHADOW-PREFLIGHT` | `2026-07-30` → `2026-08-05` |
| Production cutover | `PRODUCTION-2026-07-28` | `2026-07-30` → `2026-08-05` |
| Payroll preview | `PREVIEW-PAYROLL` | `2026-07-30` → `2026-08-05` |
| Payroll apply | `APPLY-PAYROLL-2026-08-05` | `payroll-2026-08-05-v1` |

## Controlled launch วันที่ 28 กรกฎาคม 2026

ดำเนินการผ่าน Production Change ที่ Owner อนุมัติเท่านั้น:

1. ยืนยัน exact commit SHA
2. Backup Remote D1 ใหม่ เก็บ Private พร้อม SHA-256
3. บันทึก Worker version ปัจจุบันเพื่อ Rollback
4. ยืนยันพนักงานจริง 4 คนเป็น `ACTIVE` และ UAT 3 คนเป็น `INACTIVE`
5. Apply Migration `0007` → `0008` → `0009` → `0010` ตามลำดับ โดยไม่แก้ migration เดิม
6. Deploy exact RC เป็น Silent Shadow และยืนยันว่าไม่มี LINE output จริง
7. Bootstrap/ตรวจ Google Sheets headers เป็น `Pay_Date`, `Period_Start`, `Period_End`
8. Import/ตรวจ Wage History 500 บาท effective `2026-07-30` ครบ 4 คน โดยไม่เดาค่าแรง
9. สร้าง/ตรวจ Shift Schedule แบบ insert-only สำหรับ `2026-07-30` ถึง `2026-12-31`: 4 คน × 155 วัน = 620 แถว `EXPECTED`, เวลา `04:00–16:00`; รอบแรก `2026-07-30` ถึง `2026-08-05` ต้องมี 28 แถว
10. ตรวจ Health, Readiness, Attendance, Expense, Sheets Sync, Queue/DLQ, lost และ duplicate
11. รัน Preview รอบ `2026-07-30` ถึง `2026-08-05`
12. Owner ตรวจยอดและคำนวณมืออย่างน้อย 2 คน
13. เตรียม Production config-only change และหยุดขออนุมัติ Cutover

ห้ามใช้รายการเก่าต่อไปนี้เป็นขั้นตอนปัจจุบัน:

- ห้าม Preview/Apply รอบ `2026-07-23` ถึง `2026-07-29`
- ห้ามใช้ Run ID `payroll-2026-07-29-v1`
- ห้ามใช้ confirmation `PRODUCTION-2026-07-29` หรือ `APPLY-PAYROLL-2026-07-29`

หลัง Silent Shadow ผ่าน ให้เปลี่ยน Runtime เฉพาะผ่าน config-only Production Change ที่อนุมัติ แล้วตรวจ Health/Readiness/Queue/DLQ/Lost/Duplicate/Reconcile ก่อนรับเหตุการณ์จริง

การ Merge โค้ด Payroll ไม่ถือเป็นการอนุญาต Deploy, เปลี่ยน `RUNTIME_MODE`, เปลี่ยน LINE Webhook, Secret หรือปิด Legacy Apps Script

## Rollback

Rollback Worker ไปเวอร์ชันที่บันทึกไว้ โดยไม่ Drop Migration 0007/0008/0009/0010 และไม่ลบ Payroll Run/Audit/Shift Audit การย้อน schema ให้ใช้ forward-fix เท่านั้น

หยุดจ่ายและ Rollback เมื่อ:

- ยอด Preview อธิบายไม่ได้
- Payroll ซ้ำหรือ D1 ไม่ตรง Sheets
- Attendance/Expense ผิดหรือสูญหาย
- Health/Readiness ไม่ผ่าน
- Queue, Failed jobs หรือ DLQ ค้าง
