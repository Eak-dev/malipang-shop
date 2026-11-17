# Runbook release ซิงก์ค่าใช้จ่ายรายวันต่อเนื่อง (#296)

เอกสารนี้เป็นลำดับปฏิบัติที่อ้างใน [#296](https://github.com/Eak-dev/malipang-shop/issues/296) ไม่ใช่การอนุมัติ ทุกขั้นต้องมีคอมเมนต์อนุมัติจากเจ้าของใน #296 ก่อนทำ และต้องอ่านผลกลับก่อนไปขั้นถัดไป ห้าม deploy `wrangler.continuous-notice.jsonc` ในรอบนี้

## ก่อนเริ่ม

- PR ที่ปิด R1–R7 merge แล้ว และ [#295](https://github.com/Eak-dev/malipang-shop/issues/295) ขั้นที่ 1 ยืนยันว่า `0048` และ `0055` ยังไม่อยู่ใน migration ที่ apply แล้ว จากนั้นขั้นที่ 2 (rehearsal กับไฟล์ฉบับ merge แล้ว) ผ่าน
- เจ้าของตัดสินเรื่องที่ค้างใน #296 แล้ว: แท็บ RAW/รายละเอียดแบบต่อเนื่อง, งบตั้งต้น `AA4:AC243`, workbook claim `REVIEW` เดิม, สองรายการ Makro
- backup ตาม #295 ขั้นที่ 3 ภายใน 1 ชั่วโมงก่อน migrate และสำเนา Owner Master ภายใน 1 วันก่อน cutover

## ลำดับและค่าที่ตั้ง

ค่า flag ที่ไม่ได้ระบุให้คงไม่ตั้ง (ปิด) ตาม `wrangler.jsonc`

| ขั้น | การเปลี่ยน | ค่าที่ตั้งเพิ่ม | อ่านผลกลับก่อนไปต่อ |
|---|---|---|---|
| 1 | backup | — (#295 ขั้นที่ 3, ช่วง 02:00–05:00) | `backup_checksum: PASS` |
| 2 | `wrangler d1 migrations apply malipang-v5-2 --remote` | — | snapshot: ไม่มี migration ค้าง, ช่วงงานผิดปกติไม่เพิ่ม |
| 3 | deploy Worker จาก SHA ที่อนุมัติ | ไม่มี (flag ใหม่ทั้งหมดปิด) | snapshot `MATCH` กับ hash ของเวอร์ชันใหม่, LINE OA บันทึกรายการได้ |
| 4a | การพักงานแบบใหม่ | `STABLE_REDRIVE_HOLD_ENABLED=true`, `STABLE_SCOPED_REVIEW_ENABLED=true`, `EXPENSE_FORCE_RECONCILE_HOLD_ENABLED=true` | ไม่มี FAILED ใหม่ที่อธิบายไม่ได้ |
| 4b | แจ้งเหตุแบบ durable | `SYNC_ALERT_DURABLE_ENABLED=true`, `SYNC_ALERT_DURABLE_SINCE=<เวลาที่เปิด, ISO UTC>`, (`SYNC_ALERT_INCIDENT_RETENTION_DAYS` ถ้าไม่ใช้ค่าเริ่มต้น 90) | ไม่มีการแจ้งเหตุย้อนหลังก่อน cutoff |
| 4c | ส่วนเสริม | `WORKBOOK_BATCH_FAIRNESS_ENABLED=true`, `EXPENSE_SAVED_SYNC_NOTE_ENABLED=true` | งาน HR และค่าใช้จ่ายสลับกันได้, การ์ด LINE แสดงข้อความใหม่ |
| 4d | เป้าหมายแท็บ | `STABLE_CANCELLATION_PREIMAGE_ENABLED=true`, `CONTINUOUS_DAILY_SHEET`/`_ID`, `CONTINUOUS_RAW_SHEET`/`_ID`, `CONTINUOUS_DETAIL_SHEET`/`_ID` (ตามคำตัดสินเรื่องแท็บ) | `CONTINUOUS_DAILY_ENABLED` ยังไม่ตั้ง |
| 5 | cutover | `STABLE_RECOVERY_GATE_ENABLED=true`, `CONTINUOUS_REPORT_CUTOVER_ENABLED=true`, `CONTINUOUS_CUTOVER_OPERATOR_ENABLED=true` แล้วสั่ง operator ตามขั้นตอนของ `/admin/stable-sync/continuous-cutover` | operator อยู่สถานะพร้อม, ไม่มีงานค้าง `PROCESSING` |
| 6 | canary รายการเดียว | `CONTINUOUS_DAILY_ENABLED=true`, `CONTINUOUS_CANARY_OPERATOR_ENABLED=true` | อ่านกลับแถว ยอด สูตร `I/J/R/S/U` และรายงาน; ส่งซ้ำจำกัดรายการแล้วไม่เพิ่ม; Undo รายการเดียวกันแล้วอ่านกลับ |
| 7 | ขยายวง | ปิด `CONTINUOUS_CANARY_OPERATOR_ENABLED` ตามขั้นตอน operator | 24 ชั่วโมงแรก: failed jobs, REVIEW, รายการซ้ำ วันละครั้ง |

ห้ามเปิดในรอบนี้ เพราะต้องใช้ notice worker หรือยังไม่ผ่านการทดสอบ provider จริง: `CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED`, `CONTINUOUS_NOTICE_DISPATCH_ENABLED`, `CONTINUOUS_REVIEW_CLOSE_ENABLED`, `CONTINUOUS_PUBLICATION_ENABLED`, `CONTINUOUS_UNDO_SERIALIZATION_ENABLED`, `CONTINUOUS_REVOKE_REVIEW_*`, `CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED`, `CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED`, `CONTINUOUS_PROVIDER_CANARY_ENABLED`, `EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED`, `EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED` (เปิดได้ชั่วคราวเพื่ออ่านอย่างเดียวเมื่อเจ้าของอนุมัติ)

## ถ้า migration ล้มกลางไฟล์

เอกสาร Cloudflare ระบุว่า migration ที่ล้มจะถูก rollback แต่ไม่ได้กำหนดขอบเขต transaction ถ้าสงสัยว่า `0048` หรือ `0055` ค้างครึ่งไฟล์:

1. อ่าน `SELECT name FROM pragma_table_info('<ตาราง>')` ของ `continuous_notice_dispatches` (0048) หรือ `continuous_publication_intents` (0055) เก็บเป็น JSON `{"<ตาราง>":["<คอลัมน์>",...]}`
2. `node scripts/migration-forward-fix.mjs migrations/<ไฟล์> <columns.json> > forward-fix.sql` (ไม่ต่อฐานข้อมูล)
3. เมื่อเจ้าของอนุมัติ: `wrangler d1 execute malipang-v5-2 --remote --file=forward-fix.sql` แล้วบันทึกชื่อไฟล์ใน `d1_migrations` ตามขั้นตอนที่อนุมัติใน #296

## Rollback

- ขั้นที่ 3–4: ปิด flag ล่าสุดหรือ rollback Worker ไปเวอร์ชันก่อนหน้า (schema แบบเพิ่ม Worker เดิมทำงานได้ตามผล rehearsal)
- ขั้นที่ 5 เป็นต้นไป: ทำตามขั้นตอนของ operator ห้าม deploy config ค่าเริ่มต้นทับหลัง cutover
- ไม่ย้อน schema
