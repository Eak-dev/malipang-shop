# MalisPang Worker/R2 Evidence Retention

เอกสารนี้อธิบายตัวทดแทนงาน Legacy Apps Script `MPSYS_cleanupExpiredImages` สำหรับหลักฐานที่ระบบ Worker เก็บใน R2

## สถานะเริ่มต้น

`EVIDENCE_RETENTION_ENABLED=false`

ดังนั้นการ Merge โค้ดนี้ **ไม่ทำให้รูป Production ถูกลบ** และไม่ถือเป็นการอนุญาตปิด Legacy Trigger

การเปิดใช้งานจริงต้องผ่าน Legacy shutdown gates #58/#59/#60/#46/#61/#65 และ Production Change ที่ Owner อนุมัติแยก

## Policy ที่ยกมาจาก Legacy Version 19

- หลักฐานทั่วไป: 90 วัน (`EVIDENCE_RETENTION_DAYS`)
- เอกสาร Expense ที่สถานะ `CANCELLED`: 7 วัน (`EVIDENCE_SHORT_RETENTION_DAYS`)
- `WAITING_REVIEW`, `WAITING_CONFIRM`, `CONFIRMED` ใช้ช่วงทั่วไป 90 วัน เพื่อไม่ลบหลักฐานที่ยังต้องตรวจเร็วเกินไป
- Attendance evidence ใช้ช่วงทั่วไป 90 วัน

Legacy `WAITING_ACTION` image-router TTL ไม่มีคู่ตรงใน Worker V5.2 เพราะ Worker ไม่มี pending image-choice record แบบ Version 19; รูปจะถูก classify และเข้าสู่ Attendance/Expense flow โดยตรง

## การทำงาน

Scheduled maintenance เรียก `cleanupExpiredEvidence()` แต่ฟังก์ชันจะ return ทันทีถ้า feature flag ปิด

เมื่อเปิด:

1. เลือก Attendance evidence ที่เกิน 90 วันและยังไม่มี `evidence_deleted_at`
2. เลือก Expense evidence:
   - `CANCELLED` เกิน 7 วัน
   - สถานะอื่นเกิน 90 วัน
3. จำกัดงานต่อรอบด้วย `EVIDENCE_RETENTION_BATCH_SIZE` (default 50 ต่อประเภท, capped ที่ 100)
4. ลบ object ใน R2
5. หลังลบสำเร็จจึงบันทึก `evidence_deleted_at` ใน D1
6. ถ้า R2 delete ล้มเหลว จะไม่ mark ว่าลบสำเร็จ และรอบถัดไปสามารถ retry ได้
7. เก็บ metric เฉพาะจำนวน ไม่เก็บรูป, key ใน metric, LINE ID หรือ PII

## Migration

Migration `0009_evidence_retention.sql` เพิ่ม:

- `attendance_events.evidence_deleted_at`
- `expense_documents.evidence_deleted_at`
- indexes สำหรับหา candidate แบบ bounded

ไม่แก้หรือลบ `image_key` เดิม เพื่อรักษา audit/reference history

## Rollback

ก่อนเปิด Production ต้องมี Fresh D1 backup และ Worker rollback target ตาม #59/#65

ถ้าพบการลบผิด policy:

1. ปิด `EVIDENCE_RETENTION_ENABLED`
2. หยุดการ cleanup ทันที
3. ตรวจ `evidence_deleted_at` และ R2 backup/retention evidence
4. Rollback Worker เฉพาะเมื่อจำเป็นตาม Production runbook
5. ห้ามแก้ migration history หรือ clear audit timestamp แบบเดา

หมายเหตุ: การลบ R2 object เป็น destructive operation ดังนั้น feature flag ต้องยัง `false` จนกว่า Owner จะอนุมัติ Production Change หลัง parity/backup gate ผ่าน
