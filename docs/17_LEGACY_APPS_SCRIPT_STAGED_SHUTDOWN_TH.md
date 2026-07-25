# แผนปิด Legacy Apps Script แบบเป็นขั้นตอน — MalisPang

อัปเดต: 25 กรกฎาคม 2026

เอกสารนี้เป็น Runbook หลักสำหรับถอน Legacy Apps Script โดยไม่ทำให้ Attendance, Payroll, Expense, LINE OA หรือ Google Sheets Direct API หยุดทำงาน

## สถานะปัจจุบัน

- Cloudflare Worker/D1/Queue/R2 เป็น Core Runtime
- Google Sheets ยังทำงานผ่าน Direct Sheets API และ `SHEETS_SYNC_ENABLED=true`
- Legacy Apps Script อาจยังมี Trigger/Deployment อยู่ภายนอก Repository
- Payroll รอบพฤหัสบดี–พุธ และ Pay Date วันพุธปิดรอบถูก Merge แล้วใน PR #64
- ยังห้ามปิด Legacy Apps Script จนกว่า Gate ใน #58 ผ่านครบ

## GitHub control issues

| ลำดับ | Issue | เป้าหมาย | Exit gate |
|---|---|---|---|
| 1 | #59 | ยืนยัน Worker SHA, version, runtime และ rollback | Source/runtime parity ชัดเจน |
| 2 | #60 | Inventory และ Backup Apps Script/Triggers/Deployments/Sheets | ไม่มี Project หรือ Flow ที่ไม่รู้จัก |
| 2A | #46 | Audit ทุก Google Sheets dependency และ Legacy parity | ไม่มี Legacy-only blocker |
| 3 | #61 | เก็บหลักฐานใช้งานจริงต่อเนื่อง 7 วัน | Lost/Duplicate/Failed/DLQ = 0 |
| 4 | #65 | ปิด Trigger แบบ Stage 1 ทีละตัว | ผ่าน Observation หลังปิด 7 วัน |
| 5 | #66 | Retire Deployment และ Archive | ไม่มี Legacy execution เหลือ |

Bug blocker เรื่อง `main` และ Runtime configuration อยู่ใน #67

## หลักการห้ามละเมิด

- ห้ามปิดทุก Trigger พร้อมกัน
- ห้ามลบ Apps Script source ใน Stage 1
- ห้ามลบ Legacy Sheets ใน Stage 1
- ห้ามเปลี่ยน LINE Webhook โดยเดา
- ห้ามเปิดเผยหรือ Rotate Secret ผ่าน Issue/PR
- ห้าม Deploy หรือเปลี่ยน `RUNTIME_MODE` จากงาน Shutdown ปกติ
- ห้ามใช้ข้อมูล Production ปลอมเพื่อให้ Gate ผ่าน
- ทุกการเปลี่ยนต้องมี Timestamp, Operator, Evidence และ Rollback method

## Phase 1 — Runtime verification

ดำเนินการใน #59

ต้องบันทึก:

- Worker URL ที่ LINE ใช้อยู่
- `/health` result และ Runtime Mode
- `/admin/readiness` result แบบปิดบังข้อมูลสำคัญ
- Worker version ปัจจุบัน
- Exact source commit SHA
- Previous known-good Worker version
- Queue, DLQ, failed jobs และ sync state

หาก Source กับ Runtime ไม่ตรง ให้หยุดและจัดการผ่าน #67 ก่อน

## Phase 2 — Inventory และ Backup

ดำเนินการใน #60 และ #46

### Apps Script inventory

เก็บข้อมูลทุก Project:

| Project | Bound file | Trigger/function | Type | Last run | Deployment | Replacement | Backup location | Ready |
|---|---|---|---|---|---|---|---|---|

ต้องตรวจอย่างน้อย:

- LINE message/image routing
- Image router
- Attendance
- Payroll
- Expense / bank slip / receipt
- Daily accounting write
- Staff config / wage history / shift / OT
- Retry / reconcile / scheduled jobs
- Owner/admin commands

### Backup

- Export `.gs`, `.html` และ manifest
- Backup Legacy Sheets ทั้งไฟล์
- บันทึก Trigger/Deployment inventory แบบ Redacted
- ทดสอบว่า Backup เปิดอ่านได้
- ระบุผู้รับผิดชอบและพื้นที่เก็บที่จำกัดสิทธิ์

## Phase 3 — Operational parity 7 วัน

ดำเนินการใน #61 หลัง #59, #60, #46 และ Payroll code พร้อม

ตรวจทุกวัน:

- `/health` ผ่าน
- `/admin/readiness` ผ่าน
- Attendance IN/OUT ครบ
- Expense ตามรายการจริงครบ
- Payroll Thursday–Wednesday ถูกต้อง
- Pay Date = Wednesday Period End
- Pending/Processing Sync = 0 หลัง Recovery
- Open failed jobs = 0
- DLQ = 0
- Lost/stuck inbound = 0
- Duplicate กลุ่มสำคัญ = 0
- D1 ตรง Google Sheets
- ไม่มี LINE ตอบซ้ำ
- ไม่มี Legacy fallback usage

หากวันใดมี Blocking error ให้หยุดนับ แก้ Bug และเริ่ม Observation ใหม่

## Phase 4 — Stage 1 Trigger shutdown

ดำเนินการใน #65 หลัง Owner พิมพ์:

`GO STAGE-1 LEGACY SHUTDOWN`

ขั้นตอน:

1. Fresh D1 backup พร้อม SHA-256
2. ยืนยัน Worker version และ rollback target
3. ปิด Time-driven/Installable Trigger ทีละตัว
4. หลังแต่ละตัวตรวจ LINE, Attendance, Expense, Payroll, Queue และ Sheets sync
5. ยังไม่ลบ Web App Deployment หรือ Source
6. หากผิดปกติ ให้ Re-enable Trigger ล่าสุดทันที
7. เฝ้าดูอีกอย่างน้อย 7 วัน

## Phase 5 — Retire และ Archive

ดำเนินการใน #66 หลัง Owner พิมพ์:

`GO FINAL LEGACY RETIREMENT`

- Retire Web App Deployment ที่เหลือ
- ยืนยัน LINE ไม่ชี้ Legacy URL
- ยืนยันไม่มี Trigger Active
- Archive Apps Script source และ Legacy Sheets แบบ Read-only
- อัปเดตคู่มือปฏิบัติงานให้ใช้ Worker flow เท่านั้น
- เก็บ Historical records โดยไม่ Rewrite

## Final deletion

ไม่ลบ Project/Source/Sheets ทันทีหลัง Retire

การลบถาวรต้องผ่าน:

- Rollback window สิ้นสุด
- Backup restore test ผ่าน
- ไม่มีข้อพิพาท Attendance/Payroll/Expense ที่ต้องใช้ข้อมูลเก่า
- Owner อนุมัติการลบเป็นข้อความแยก

## Rollback triggers

Rollback ทันทีเมื่อ:

- LINE ไม่ตอบหรือ 5xx ต่อเนื่อง
- Attendance, Expense หรือ Payroll ขาดหาย ผิด หรือซ้ำ
- Lost > 0
- Duplicate > 0
- Failed/DLQ/Sync ค้าง
- D1 ไม่ตรง Google Sheets
- Payroll Preview อธิบายยอดไม่ได้

## Definition of done

Legacy Apps Script ถือว่าถูกถอนสมบูรณ์เมื่อ:

- ไม่มี Trigger หรือ Deployment ทำงาน
- Worker ทำงานต่อเนื่องโดย Lost/Duplicate = 0
- Payroll/Attendance/Expense ผ่านการตรวจจริง
- Backup และ Rollback evidence ครบ
- Assets ถูก Archive ตาม Retention policy
- Owner อนุมัติ Final GO ใน #66
- #58 ถูกปิดเป็น completed
