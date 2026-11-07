# Issue #251 — ตรวจสุขภาพ Google Sheets Sync (DEV-only)

## จุดประสงค์

หลังแก้ปัญหา REVIEW ใน [Production Change #248](https://github.com/Eak-dev/malipang-shop/issues/248) ให้ข้อมูลใหม่จาก D1 ส่งผ่าน Durable Outbox → Cloudflare Queue → Google Sheets อัตโนมัติ โดยไม่ต้องให้พนักงานกด Sync เอง

**ข้อเท็จจริง:** Backend มีทางเรียก enqueueSheetSync อยู่แล้วในส่วน Expense/Attendance/Payroll การเพิ่ม Cron หรือ Apps Script อีกชุดโดยไม่ตรวจการซ้ำจะเสี่ยงมากกว่าเป็นประโยชน์

Issue #251 Phase 1 จึงเพิ่มเฉพาะการตรวจสุขภาพ Sync แบบอ่าน D1 ไม่เปลี่ยนธุรกรรม ค่าแรง กฎบัญชี การส่ง Queue หรือการเขียน Google Sheets

## Endpoint และการรักษาความลับ

- เรียกของเดิม: GET /admin/operations/summary (ต้องใช้ ADMIN_TOKEN เดิม)
- ส่วนใหม่: sideEffects.sheetsSync
- แสดง: status, reason, workbookConfigured, reviewClaimCount, heldClaimCount, reviewJobCount, unfinishedJobs, oldestUnfinishedLastUpdateAt, oldestUnfinishedLastUpdateMinutes, lastCompletedAt, lastCompletedAgeMinutes, byType และ checkedAt
- ไม่แสดง spreadsheet_id, operation_token, notice_identity, entity_key, trace_id, employee ID, LINE ID, จำนวนเงินหรือ Private Evidence
- byType ใช้ชื่อ Entity Type ที่อนุญาตจาก Enum เท่านั้น รายการไม่รู้จักรวมเป็น OTHER
- ไม่เรียก Google API, ไม่แก้ D1, ไม่ส่ง Queue, ไม่ Retry, ไม่ปลด REVIEW และไม่ทำ External Health Probe

## ความหมายของสถานะ

| status | ความหมาย | สิ่งที่ Owner ควรทำ |
| --- | --- | --- |
| REVIEW_BLOCKED | มี REVIEW Claim สำหรับ Workbook ที่กำหนด | ตรวจ Incident / Release Gates ห้ามลบ Claim เพื่อให้ตัวเลขสวย |
| DELAYED | งานไม่เสร็จและ updated_at ล่าสุดเกิน 10 นาที หรือมี Job REVIEW | ตรวจงานค้าง อย่ากด Retry ทั้งหมด |
| HEALTHY | มี D1 sync job COMPLETED ใน 15 นาทีล่าสุด และไม่มีหลักฐานบล็อก/งานค้างเก่า | **เป็นเพียง D1 outbox signal ไม่ยืนยันว่า Sheets แสดงข้อมูลแล้ว** |
| UNKNOWN | ไม่มีหลักฐานสำเร็จใหม่, Workbook/Sync ไม่พร้อม, HELD Claim, Clock skew หรือเวลา/สถานะไม่สมบูรณ์ | ห้ามสรุปว่า PASS จากการไม่มีข้อมูล |

ค่า oldestUnfinishedLastUpdateMinutes คำนวณจาก sync_jobs.updated_at ไม่ใช่เวลาที่ลูกค้าส่ง LINE และอาจถูกรีเซ็ตเมื่อมี retry ดังนั้น **ห้ามใช้เป็น Sync Latency SLA p95/p99** และ HEALTHY ไม่ใช่หลักฐาน End-to-End Provider Readback

## ขอบเขตและการตรวจรับ

1. ต้องตรวจข้อเท็จจริงจาก D1 และ Google Sheets แบบ Read-only ก่อนเปลี่ยน Production ตาม Issue #248
2. เพิ่ม API diagnostics แบบ Backward Compatible ไม่ลบ/เปลี่ยนชื่อ field เดิม
3. ทดสอบ REVIEW, HELD, งานค้างเกิน 10 นาที, ไม่มีข้อมูลใหม่, Timestamp ผิด/อนาคต, Workbook missing, Sync disabled, PII sanitization, Admin authentication, ไม่มี D1/Queue mutation
4. npm run check, Wrangler dry-run และ GitHub CI ต้องผ่าน; tests ข้ามยังเป็น UNKNOWN
5. ยังไม่ถือว่า Google Sheets กลับมาทำงานจนกว่าข้อมูล Expense/Attendance/Payroll ใหม่จะถูกอ่านกลับจาก Provider และกระทบยอดตรง D1 ตาม Release Gates ที่อนุมัติ
6. ห้าม Merge/Deploy Phase 1 จาก PR นี้โดยไม่อนุมัติ; ไม่แก้ PR #247/#250 และไม่แตะ Cron/Config/Queue/B1-C1/REVIEW Claim/ARM epoch

## เป้าหมายระยะถัดไป (ยังไม่ใช่ Acceptance ที่วัดผ่านแล้ว)

Near real-time เมื่อไม่มี REVIEW: ข้อมูลที่เข้าเกณฑ์ต้องเห็นใน Google Sheets ภายในเป้าหมาย 2 นาทีสำหรับ p95 และ 5 นาทีสำหรับ p99 หลังออกแบบการวัด D1-event → Provider Readback อย่างถูกต้อง มี Alert เมื่อค้างเกิน 10 นาทีแบบ dedup/rate-limit และไม่พึ่ง LINE Push เป็นหลักสำหรับแจ้งเตือนฉุกเฉิน

ค่าเป้าหมายดังกล่าวต้องได้รับ Owner Policy approval และทดสอบกับธุรกรรมจริงภายใต้ G6–G9 ก่อนประกาศ PASS
