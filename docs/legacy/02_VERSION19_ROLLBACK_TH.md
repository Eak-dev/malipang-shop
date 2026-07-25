# Legacy Apps Script Version 19 — Rollback Runbook

เอกสารนี้ใช้เฉพาะสำหรับการย้อนกลับระหว่างแผนปิด Legacy แบบเป็นขั้นตอน #58/#65/#66

> **ห้ามใช้เอกสารนี้เป็นคำสั่งเปลี่ยน Production โดยอัตโนมัติ** ทุก rollback ที่เปลี่ยน Trigger, Deployment หรือ LINE Webhook ต้องมีเหตุผล/หลักฐานและ Owner approval ตาม Change gate ที่เกี่ยวข้อง

## Baseline ที่ต้องรักษาไว้ก่อน Stage 1

- Active Legacy Web App: Version 19
- Source project: `Home Expense Mali's pang`
- Version 19 source/deployment ต้องไม่ถูกแก้หรือลบ
- Current Worker version/source SHA/Runtime และ rollback target ต้องยืนยันใน #59 ก่อน
- Owner Master + Legacy Sheets backup ต้องผ่าน #60
- LINE Webhook current destination ต้องบันทึกแบบ redacted และห้ามเปลี่ยนจาก Stage-1 shutdown task

ห้ามเก็บ Script ID, Deployment ID, Web App URL, Tokens หรือ Secrets ใน repository นี้

## Stage 1 ที่อนุญาตให้ทำเมื่อ Gate ผ่าน

Stage 1 มีเป้าหมายเพียง **หยุด Legacy execution ที่พิสูจน์แล้วว่าถูก Worker ทดแทนครบ** โดยเก็บความสามารถ rollback ไว้

สิ่งที่ต้องคงอยู่:

- Apps Script project source
- Active Version-19 Web App deployment
- Legacy Google Sheets/history
- backup copies
- deployment metadata/private evidence

Stage 1 **ไม่ใช่** final retirement และไม่อนุญาต permanent delete

## Rollback trigger

ให้เข้าสู่ rollback ทันทีหากหลัง Stage 1 พบอย่างใดอย่างหนึ่ง:

- LINE flow ที่ควรทำงานผ่าน Worker ไม่ตอบ/5xx ต่อเนื่อง
- Attendance IN/OUT หาย ผิด หรือซ้ำ
- Expense ยืนยัน/ยกเลิก/Undo ผิดหรือสูญหาย
- Payroll รอบ Thursday–Wednesday ผิดหรือ duplicate
- Lost > 0 หรือ Duplicate > 0
- Queue/DLQ/failed/sync ค้างเกินเกณฑ์ runbook
- D1 ↔ Google Sheets reconcile ไม่ผ่าน
- พบว่างาน scheduled ของ Legacy ยังมีหน้าที่ที่ Worker ไม่ได้ทดแทน

## Rollback — Legacy cleanup trigger

Legacy source Version 19 มี `MPSYS_installCleanupTrigger_()` ซึ่งสร้าง time-driven trigger สำหรับ `MPSYS_cleanupExpiredImages` ประมาณ hour 02

ถ้า Stage 1 ได้ disable trigger นี้และจำเป็นต้อง rollback:

1. หยุดการเปลี่ยนแปลงอื่นทั้งหมด
2. ยืนยันว่าตัว Apps Script project และ Version-19 source ยังเป็น baseline เดิม
3. เปิด Apps Script → Triggers ด้วย Google account ที่เป็น owner ของ trigger ตาม inventory
4. Re-create **เฉพาะ** `MPSYS_cleanupExpiredImages` time-driven trigger ด้วย schedule เดิมที่บันทึกไว้ใน private inventory
5. ห้ามรัน `MPSYS_setupFullSystem()` เพื่อ recreate trigger หากยังไม่ได้ review side effects เพราะฟังก์ชันดังกล่าวมีการ ensure/seed system sheets/config ด้วย
6. ตรวจ Executions ว่า trigger ถูกสร้างและไม่มี duplicate trigger
7. บันทึก timestamp/operator/reason แบบ redacted ใน #65
8. ตรวจ Legacy cleanup execution ในรอบถัดไปโดยไม่ลบ/แก้ evidence เพิ่มเอง

หมายเหตุ: Worker R2 retention replacement เป็น non-destructive audit และไม่ลบ R2 evidence ดังนั้นการ rollback Legacy cleanup ต้องใช้เพื่อ Legacy Drive/System Sheets เท่านั้น ไม่ใช่ให้ Legacy จัดการ Worker R2

## Rollback — Web App execution

Stage 1 ต้องไม่ archive/delete Version-19 Web App ดังนั้นโดยปกติไม่ต้อง recreate deployment

หากมีการ retire deployment ใน Stage 2 ภายหลัง:

1. ใช้ Version/Deployment metadata จาก private #60 backup เท่านั้น
2. ห้ามสร้าง deployment ใหม่โดยเดา version/config
3. Restore/enable ตาม Owner-approved rollback change
4. ตรวจ `doGet`/Web App health แบบไม่ส่งธุรกรรมจริงก่อน
5. LINE Webhook เปลี่ยนได้เฉพาะ Production Change ที่ Owner อนุมัติแยก ไม่ใช่จาก #60/#65

## Rollback — Worker

Worker rollback ถูกควบคุมด้วย #59/#22 ไม่ใช่ Apps Script Issue:

1. ใช้ exact previous known-good Worker version จาก #59
2. ไม่ Drop migration และไม่ rewrite history
3. ไม่ลบ Payroll run/audit/evidence
4. หลัง rollback ตรวจ `/health`, `/admin/readiness`, `/admin/status`
5. ตรวจ LINE/Attendance/Expense ตามธรรมชาติและ reconcile

## Google Sheets catch-up

หากในอนาคตมีการปิด `SHEETS_SYNC_ENABLED` เป็นช่วงเวลาแล้วต้องกลับมาเปิด:

- `/admin/retry-sync` อย่างเดียวไม่พอสำหรับรายการที่เกิดตอน flag ปิด เพราะ sync job ใหม่ไม่ได้ถูกสร้างในช่วงนั้น
- ต้องบันทึกช่วงเวลาที่ปิด และรัน date-bounded `/admin/reconcile-sheets` ครอบคลุม business-date interval ทั้งหมดหลัง re-enable
- รอ pending/processing sync = 0 และตรวจ D1 ↔ Sheets ก่อนถือว่า rollback เสร็จ

รายละเอียด dependency อยู่ใน `docs/board/01_SHEETS_DEPENDENCY_INVENTORY.md`

## Evidence ที่ต้องบันทึกหลัง rollback

บันทึกเฉพาะข้อมูลไม่อ่อนไหวใน GitHub:

- วันที่/เวลา Asia/Bangkok
- operator
- trigger/deployment/function แบบชื่อทั่วไป
- reason
- health/readiness/status PASS/FAIL
- Lost/Duplicate/Failed/DLQ/Sync counts
- reconcile result
- GO/ROLLBACK decision

Full IDs, URLs, screenshots ที่มี identifiers และ source backup ให้เก็บใน private backup location เท่านั้น

## Exit criteria หลัง rollback

- ระบบกลับสู่ known-good state
- ไม่มี lost/duplicate ที่ยังอธิบายไม่ได้
- queue/sync/reconcile ปกติ
- Owner รับทราบสาเหตุ
- เปิด Bug Issue สำหรับ root cause ก่อนเริ่ม Stage 1 ใหม่
