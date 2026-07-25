# MalisPang Worker/R2 Evidence Retention Audit

เอกสารนี้อธิบายตัวทดแทนความรับผิดชอบด้าน retention ของ Legacy Apps Script `MPSYS_cleanupExpiredImages` สำหรับหลักฐานที่ระบบ Worker เก็บใน R2

## หลักความปลอดภัย

Repository กำหนดชัดว่า **ห้ามลบ R2 evidence** ดังนั้นระบบใหม่จะไม่คัดลอกพฤติกรรม destructive delete ของ Legacy Version 19 แบบตรงตัว

ระบบใหม่ทำเป็น **retention audit / eligibility classification**:

- R2 object ถูกเก็บไว้ ไม่ถูก delete หรือ overwrite โดยงาน retention
- D1 บันทึกว่า object ใดถึงอายุ retention แล้ว (`RETENTION_ELIGIBLE`)
- การลบถาวรจะยังไม่มี implementation จนกว่าจะมี requirements/policy ใหม่ที่ไม่ขัด Production safety rule

## สถานะเริ่มต้น

`EVIDENCE_RETENTION_ENABLED=false`

ดังนั้นการ Merge โค้ดนี้ไม่เริ่ม scan/mark ใน Production และไม่ถือเป็นการอนุญาตปิด Legacy Trigger การเปิด feature flag ต้องเป็น Production Change แยกหลัง gate ที่เกี่ยวข้องผ่าน

## Policy reference จาก Legacy Version 19

ใช้ช่วงเวลาเดิมเป็นเกณฑ์สำหรับ **mark eligible เท่านั้น**:

- หลักฐานทั่วไป: 90 วัน (`EVIDENCE_RETENTION_DAYS`)
- Expense ที่ผูกกับเอกสารสถานะ `CANCELLED`: 7 วัน (`EVIDENCE_SHORT_RETENTION_DAYS`)
- Expense ที่ไม่พบเอกสารอ้างอิง รวมถึง orphaned upload: ใช้ 90 วัน
- `WAITING_REVIEW`, `WAITING_CONFIRM`, `CONFIRMED`: 90 วัน
- Attendance: 90 วัน

Legacy `WAITING_ACTION` image-router TTL ไม่มีคู่ตรงใน Worker V5.2 เพราะ Worker classify รูปเข้าสู่ Attendance/Expense โดยตรง ไม่สร้าง pending image-choice record แบบ Version 19

## การทำงาน

Scheduled maintenance เรียก `auditEvidenceRetention()` แต่ return ทันทีเมื่อ feature flag ปิด

เมื่อเปิด:

1. ใช้ `R2.list()` scan prefix `attendance/` และ `expense/` โดยตรง จึงมองเห็น object ที่อาจไม่มี D1 business row เช่น duplicate submission ที่ upload ไปก่อนถูก dedup
2. บันทึก inventory ใน `evidence_objects` แบบ idempotent
3. เก็บ scan cursor แยกต่อ prefix ใน `evidence_scan_state` เพื่อให้ bounded scan เดินต่อไปได้ ไม่ติดอยู่ที่ object ชุดแรก
4. ใช้ช่วง 90/7 วันเพื่อ mark D1 status เป็น `RETENTION_ELIGIBLE`
5. **ไม่เรียก `R2.delete()` และไม่ลบ object**
6. เก็บ metric เฉพาะจำนวน scan/index/eligible/error โดยไม่ใส่ object key, LINE ID หรือเนื้อหารูปลง metric

`EVIDENCE_RETENTION_BATCH_SIZE` จำกัดจำนวน object ที่ list ต่อ prefix ต่อรอบ (default 50 ใน config ปัจจุบัน; code capped ที่ 1000)

## Migration

Migration `0009_evidence_retention.sql` เพิ่ม:

- `evidence_objects`
  - `object_key`
  - `evidence_type`
  - `status = STORED | RETENTION_ELIGIBLE`
  - `created_at`
  - `retention_eligible_at`
  - `updated_at`
- `evidence_scan_state`
  - prefix
  - cursor
  - updated timestamp
- index สำหรับ retention scan

Migration ไม่แก้ business rows เดิมและไม่ลบ `image_key` ใด ๆ

## Rollback

เพราะระบบนี้ไม่ลบ R2 object การ rollback หลักคือ:

1. ปิด `EVIDENCE_RETENTION_ENABLED`
2. Scheduled maintenance จะหยุด scan/mark
3. R2 evidence ยังคงอยู่ทั้งหมด
4. D1 inventory/eligibility rows เป็น audit metadata และไม่ควรถูกลบเพื่อย้อนสถานะ
5. หากต้อง rollback Worker ให้ใช้ exact rollback target และ backup ตาม Production runbook

## ความสัมพันธ์กับ Legacy shutdown

การมี retention audit replacement ไม่ได้อนุญาตให้ปิด Legacy Version 19 ทันที ต้องผ่าน #58/#59/#60/#46/#61/#65 ตามลำดับ

เมื่อถึง Stage 1 เราสามารถหยุด Legacy cleanup ได้โดยยอมรับนโยบายใหม่ว่า Worker **preserve R2 evidence และ mark eligibility แทนการลบอัตโนมัติ** ซึ่งปลอดภัยกว่าและสอดคล้อง repository invariant
