# Runbook release ซิงก์ค่าใช้จ่ายรายวันต่อเนื่อง (#296)

เอกสารนี้เป็นลำดับปฏิบัติที่อ้างใน [#296](https://github.com/Eak-dev/malipang-shop/issues/296) ไม่ใช่การอนุมัติ ทุกขั้นต้องมีคอมเมนต์อนุมัติจากเจ้าของใน #296 ก่อนทำ และต้องอ่านผลกลับก่อนไปขั้นถัดไป ห้าม deploy `wrangler.continuous-notice.jsonc` ในรอบนี้

## คำตัดสินของเจ้าของที่ใช้กับ runbook นี้ (2026-11-18)

- แท็บ RAW/รายละเอียดต่อเนื่อง: operator สร้างในขั้น `VIEWS` (ดูหัวข้อแท็บ) และระบบเขียน Owner Master ได้เฉพาะขั้นของ operator ที่อนุมัติ
- งบตั้งต้น (แทนคำตัดสินเดิมทั้งหมด): เริ่มกลางเดือน พ.ย. 2569 โดย**ใช้งบหัวเดือนในแท็บ `รายวัน` เดิม ไม่ใส่แถว `AA:AC` ของ พ.ย.** เจ้าของตรวจว่างบหัวเดือน พ.ย. ถูกต้อง; ยกเลิกคำตัดสิน "งบเต็มลบรายจ่าย" (จะหักซ้ำ) ดูหัวข้อ "งบตั้งต้นเมื่อเริ่มกลางเดือน"
- แผนเร่ง (แทนแผนก่อนหน้าทั้งหมด): ขั้น 1–4 เช้ามืดวันพฤหัสบดี 19 พ.ย. 2569 02:00–05:00 แล้วเฝ้าดู 1 วัน; ขั้น 5–6 เช้ามืดวันศุกร์ 20 พ.ย. 02:00–05:00 (สำรอง เสาร์ 21 พ.ย.); **ห้ามทำในวันพุธ** ซึ่งเป็นวันจ่าย payroll (รอบ พฤ.–พ., `payrollPeriodFor` ใน `src/shared/time.ts`; วันจ่ายถัดไปคือพุธ 25 พ.ย.)
- สองรายการใน `ACTIVATE`: ถ้ายังไม่ยกเลิก เจ้าของ Undo ทั้งสองก่อนคืนวันศุกร์ 20 พ.ย. แล้วลบถาวรหลัง canary ตามแผน L5 เดิม
- fingerprint ของล็อกเดิม: อ่านด้วย workflow `review_fingerprint` (อ่านอย่างเดียว) เจ้าของยอมรับว่าค่า hash อยู่ใน log และ `wrangler.jsonc` ที่เป็นสาธารณะ
- ผู้รันขั้น 2–7: workflow `prod-release-migrate-deploy.yml` (#299) ที่เจ้าของอนุมัติผ่าน environment `production` ทุกครั้ง ไม่รัน wrangler จากเครื่องใคร; ไม่หยุด cron/queue ระหว่าง migrate กับ deploy และ deploy ต่อทันทีในคืนเดียวกัน
- Back Office: นำออกจากเกณฑ์ของ release นี้ (ตัวซิงก์อ่านค่าใช้จ่ายที่ยืนยันใน D1 โดยไม่ขึ้นกับช่องทาง)
- ล็อก workbook `REVIEW` เดิม: ใช้ `START_REVIEW` ของ operator หลังตรวจผลการเขียนเดิมในชีตแบบอ่านอย่างเดียว ในขั้นที่เจ้าของอนุมัติ
- สองรายการที่เจ้าของสั่งลบ: ลบหลัง canary ผ่าน เป็นงานแยก (L5) เก็บบันทึกกันซ้ำของข้อความ LINE ไว้ และเปิด `EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED` ก่อนลบ เจ้าของยืนยันทีละชิ้น
- แผนบัญชี Cloudflare (Paid/Free): เจ้าของตรวจเอง ก่อนขั้น 3
- การยกเลิกค่าใช้จ่ายอัตโนมัติ (#296 ข้อ 7): ไม่ให้ระบบยกเลิกเอง — `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED` ต้องไม่ตั้ง (ไม่ตั้ง = พักงานรอคนตรวจ, `true` = ยกเลิกแบบเดิม)
- จังหวะ cutover (#296 ข้อ 8): เมื่อเริ่ม `START_REVIEW` แล้วต้องไปให้ถึง `RELEASE`; ตรวจ preflight checklist ให้ครบก่อนเริ่ม ทำในช่วง 02:00–05:00 ไม่ทำวันที่มีรอบจ่าย payroll; ถ้าติดเกิน 8 ชั่วโมงให้หยุดถามเจ้าของ (ซิงก์ชีตยังหยุดระหว่างนั้น) — ไม่ใช้วิธีปิด gate กลางทาง
- payroll/การลงเวลาที่หยุดตั้งแต่ 14 พ.ย.: รอ release ตามแผน ไม่ปลดล็อกแยก
- เขียนแถวรายวันล้มแบบแน่นอนหลังขั้น 6 (`InsertDailyDefiniteFailure`): ยอมรับความเสี่ยงที่ทั้ง workbook ถูกพัก ไม่ทำ scoped hold ก่อนขั้น 6; ถ้าเกิด จะออกแบบวิธีปลดล็อกตอนนั้น (ระหว่างนั้นซิงก์ทุกประเภทหยุด) ข้อเสนอ scoped hold คงไว้เป็นงานในอนาคต

## ก่อนเริ่ม

- PR ที่ปิด R1–R7 merge แล้ว และ [#295](https://github.com/Eak-dev/malipang-shop/issues/295) ขั้นที่ 1 ยืนยันว่า `0048` และ `0055` ยังไม่อยู่ใน migration ที่ apply แล้ว จากนั้นขั้นที่ 2 (rehearsal กับไฟล์ฉบับ merge แล้ว) ผ่าน
- เจ้าของตัดสินเรื่องที่ค้างใน #296 แล้ว: แท็บ RAW/รายละเอียดแบบต่อเนื่อง, งบตั้งต้น `AA4:AC243`, workbook claim `REVIEW` เดิม, สองรายการค่าใช้จ่ายที่เจ้าของสั่งลบ
- backup ตาม #295 ขั้นที่ 3 ภายใน 1 ชั่วโมงก่อน migrate และสำเนา Owner Master ภายใน 1 วันก่อน cutover

## ลำดับและค่าที่ตั้ง

ค่า flag ที่ไม่ได้ระบุให้คงไม่ตั้ง (ปิด) ตาม `wrangler.jsonc`

**วิธีตั้ง flag (ขั้น 4–7):** flag และชื่อ/ID แท็บอยู่ใน `vars` ของ `wrangler.jsonc` บน main ซึ่งเป็นสาธารณะ แต่ละชุดคือ PR แก้ `wrangler.jsonc` ที่ผ่าน QA/Reviewer แล้ว merge จากนั้นรัน workflow `deploy` จาก SHA ใหม่ บรรทัด `config_changes` ต้องตรงกับรายชื่อ var ของชุดนั้นเท่านั้น (ข้อความยืนยันต้องระบุครบทุกชื่อ ระบบเทียบกับ Worker ที่รันอยู่) ห้ามใส่ค่าที่เป็นความลับใน `wrangler.jsonc`

**workflow `prod-release-migrate-deploy.yml` (#299):** รันได้จาก main เท่านั้น และต้องได้อนุมัติ environment `production` ทุกครั้ง
- `migrate`: ตรวจว่า ledger head และไฟล์สุดท้ายตรงกับข้อความยืนยันก่อน apply แล้วอ่าน ledger กลับเสมอ ถ้าได้ `migrate: INCOMPLETE` ห้ามรันซ้ำทันที ให้ดู `pending_after` แล้วทำตามหัวข้อ "ถ้า migration ล้มกลางไฟล์"
- `deploy` อ่านเวอร์ชันที่รันอยู่ได้สูงสุด 3 ครั้ง ห่างกัน 10 วินาที ก่อนสรุป ถ้าได้ `deploy: UNKNOWN` **ห้าม dispatch deploy ใหม่** ให้รัน snapshot แล้วเทียบ: กรอก `live_version_sha256` จาก `preflight` เป็น expected — `MATCH` แปลว่ายังเป็นเวอร์ชันเดิม (deploy ไม่เกิด) ส่วน `MISMATCH` แปลว่าเปลี่ยนแล้ว ให้ถามผู้ดูแลก่อนทำอะไรต่อ
- `deploy`: ปฏิเสธถ้ามี migration ค้าง, Worker ไม่ใช่เวอร์ชันเดียว 100%, หรือรายชื่อ var ที่เปลี่ยนไม่ตรงกับข้อความ; dry-run ก่อน; เก็บเวอร์ชันเดิมใน R2 private (`release-versions/<run id>.json`) และอ่านกลับก่อน deploy; ถ้า ACK หายจะอ่านเวอร์ชันที่รันอยู่แทนการ deploy ซ้ำ; ห้ามกด re-run (ระบบปฏิเสธ attempt ที่ 2) ให้ dispatch run ใหม่หลังอ่าน snapshot
- `rollback_worker`: ยืนยัน `ROLLBACK <sha7> BEFORE RUN <run id ของ deploy>` ย้อนไปเวอร์ชันที่ run นั้นแทนที่ เฉพาะเมื่อ Worker ที่รันอยู่ยังเป็นเวอร์ชันที่ run นั้น deploy; ถ้ามี deploy หลายครั้งให้ใช้ run แรกของชุดที่ต้องการย้อน
- `review_fingerprint` (อ่านอย่างเดียว): ยืนยัน `FINGERPRINT <sha7>` พิมพ์เฉพาะ SHA-256 สำหรับ `CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT` เมื่อมี claim เพียงหนึ่งเดียวและเป็น `REVIEW` / `OPERATION` / `STABLE_DAILY_REVIEW` ที่มี notice; ฟิลด์และลำดับเหมือน `startPrewriteReview` (เทสต์ล็อกไว้)
- `preflight` (ไม่เขียน D1 หรือ Worker): รันก่อน `migrate` เสมอ เพื่อให้รู้ว่า token ขาดสิทธิ์ก่อนที่ schema จะเปลี่ยน ไม่ใช่ระหว่าง migrate กับ deploy
- log แสดงเฉพาะสถานะ ชื่อไฟล์ migration ชื่อ var และ SHA-256 ของ version id

**ข้อควรรู้ของขั้น 3 (`deploy`):**
- รายชื่อ var ที่เปลี่ยนมาจาก binding แบบ `plain_text` ที่ API settings ของ Worker คืนมา ถ้า API ไม่คืนค่า `text` ของ var ระบบจะหยุดที่ `LIVE_SETTINGS_UNREADABLE` ก่อนเขียน และถ้าคืนค่าต่างจากที่คาด รอบแรกอาจได้ `CONFIRMATION_MISMATCH` พร้อม `expected_confirmation` — ให้ตรวจว่ารายชื่อนั้นสมเหตุผล (ควรเป็น `NONE` สำหรับ deploy ครั้งแรกถ้า Worker ที่รันอยู่มาจาก config เดียวกับ main) ก่อน dispatch ใหม่ด้วยข้อความนั้น ห้ามคัดลอกโดยไม่อ่าน
- binding ชนิดอื่น (D1, Queue, R2, Durable Object, secret, `version_metadata` ฯลฯ) ไม่อยู่ในข้อความยืนยัน การเปลี่ยน binding เหล่านี้ใน `wrangler.jsonc` ต้องตรวจใน PR เอง
- `preflight` แสดง `config_changes` แบบเดียวกันล่วงหน้า ใช้ดูได้ก่อนคืนนั้น

**⚠️ หลัง `ACTIVATE` ห้ามย้อน Worker ไปเวอร์ชันก่อน release (ก่อนคืนวันพฤหัสบดี 19 พ.ย.) ทั้งผ่าน workflow `rollback_worker` และผ่าน dashboard** เพราะ Worker เดิมไม่รู้จัก cutover และจะเขียนแท็บเดิมต่อ ทางหยุดฉุกเฉินหลัง `ACTIVATE` อยู่ในหัวข้อ "Rollback หลังขั้น 5 (operator)" (ปิด `CONTINUOUS_DAILY_ENABLED` ด้วย PR + `deploy`) การย้อนไปเวอร์ชันที่ deploy หลัง release แล้ว (เช่นก่อนชุด flag ล่าสุด) ยังทำได้

**ย้อน Worker ด้วยมือ (สำรองถ้า workflow ใช้ไม่ได้ และเฉพาะก่อน `ACTIVATE`):** เจ้าของเข้า Cloudflare dashboard → Workers & Pages → `malipang-backend-v5-2` → แท็บ Deployments → เลือกเวอร์ชันก่อนหน้า (เวอร์ชันที่ deploy ก่อนคืนนั้น; เทียบ SHA-256 ของ version id กับ `live_version_sha256` ที่ `preflight` พิมพ์) → Rollback แล้วรัน snapshot กรอก hash นั้นให้ได้ `MATCH`; schema ไม่ย้อน (Worker เดิมทำงานบน schema ใหม่ได้ตาม smoke ของ rehearsal)

| ขั้น | การเปลี่ยน | ค่าที่ตั้งเพิ่ม | อ่านผลกลับก่อนไปต่อ |
|---|---|---|---|
| 1 | backup | — (#295 ขั้นที่ 3, ช่วง 02:00–05:00) | `backup_checksum: PASS` |
| 1b | workflow `preflight` (**รอให้ run backup ของขั้น 1 จบก่อน**; สอง workflow ใช้ concurrency group `malipang-release-control` เดียวกันจึงไม่รันซ้อน แต่ต้อง dispatch หลัง backup จบ):  ยืนยัน `PREFLIGHT <sha7>` | — | `preflight: PASS` (อ่าน ledger/สถานะ Worker/settings ได้, dry-run ผ่าน, เขียน-อ่าน R2 ได้) และจด `expected_migrate_confirmation`; ถ้าไม่ผ่าน**หยุดคืนนั้น** ยังไม่มีอะไรถูกเขียน |
| 2 | **เจ้าของต้องเห็น `backup_checksum: PASS` ของขั้น 1 (และ `preflight: PASS`) ก่อนอนุมัติ** workflow `migrate`: ยืนยัน `MIGRATE <sha7> FROM 0023 TO <เลขไฟล์สุดท้าย>` (35 ไฟล์ตาม rehearsal #295) | — | ผล `migrate: PASS`, `pending_after: none`; snapshot: ไม่มี migration ค้าง, ช่วงงานผิดปกติไม่เพิ่ม |
| 3 | workflow `deploy` จาก SHA ที่อนุมัติ: ยืนยัน `DEPLOY <sha7> CHANGES <รายชื่อ var ที่เปลี่ยน หรือ NONE>` | ไม่มี (flag ใหม่ทั้งหมดปิด) | ผล `deploy: PASS` และ `deployed_version_sha256`; snapshot กรอก hash นั้นได้ `MATCH`; LINE OA บันทึกรายการได้ |
| 4a | การพักงานแบบใหม่ | `STABLE_REDRIVE_HOLD_ENABLED=true`, `STABLE_SCOPED_REVIEW_ENABLED=true`, `EXPENSE_FORCE_RECONCILE_HOLD_ENABLED=true` | ไม่มี FAILED ใหม่ที่อธิบายไม่ได้ |
| 4b | แจ้งเหตุแบบ durable | `SYNC_ALERT_DURABLE_ENABLED=true`, `SYNC_ALERT_DURABLE_SINCE=<เวลาที่เปิด, ISO UTC>`, (`SYNC_ALERT_INCIDENT_RETENTION_DAYS` ถ้าไม่ใช้ค่าเริ่มต้น 30) | ไม่มีการแจ้งเหตุย้อนหลังก่อน cutoff |
| 4c | ส่วนเสริม | `WORKBOOK_BATCH_FAIRNESS_ENABLED=true`, `EXPENSE_SAVED_SYNC_NOTE_ENABLED=true` | งาน HR และค่าใช้จ่ายสลับกันได้, การ์ด LINE แสดงข้อความใหม่ |
| 4d | เป้าหมายแท็บ | `STABLE_CANCELLATION_PREIMAGE_ENABLED=true`, `CONTINUOUS_DAILY_SHEET`/`_ID`, `CONTINUOUS_RAW_SHEET`/`_ID`, `CONTINUOUS_DETAIL_SHEET`/`_ID` (ตามคำตัดสินเรื่องแท็บ) | `CONTINUOUS_DAILY_ENABLED` ยังไม่ตั้ง |
| 5 | cutover (ทำหลังผ่าน preflight checklist) | `STABLE_RECOVERY_GATE_ENABLED=true`, `CONTINUOUS_REPORT_CUTOVER_ENABLED=true`, `CONTINUOUS_CUTOVER_OPERATOR_ENABLED=true`, `CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED=true`, `CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT=<hash ของล็อกเดิมที่เจ้าของยืนยัน>` แล้วสั่ง operator `START_REVIEW` → `VIEWS` → `DAILY_J` → `REPORTS` → `ACTIVATE` → `RELEASE` ที่ `/admin/stable-sync/continuous-cutover` | แต่ละ action ตอบ `ok:true` และ `servedVersion` ตรงเวอร์ชันที่ deploy; หลัง `RELEASE` claim ถูกปล่อย |
| 6 | canary รายการเดียว (หลัง RELEASE สำเร็จ) | `CONTINUOUS_CUTOVER_OPERATOR_ENABLED=false`, `CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED=false`, `CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED=false`, `CONTINUOUS_DAILY_ENABLED=true`, `CONTINUOUS_CANARY_OPERATOR_ENABLED=true` โดยคง `STABLE_RECOVERY_GATE_ENABLED=true` (**`UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED` ต้องไม่ตั้ง**) | อ่านกลับแถว ยอด สูตร `I/J/R/S/U` และรายงาน; ส่งซ้ำจำกัดรายการแล้วไม่เพิ่ม; Undo รายการเดียวกันแล้วอ่านกลับ |
| 7 | ขยายวง | ปิด `CONTINUOUS_CANARY_OPERATOR_ENABLED` ตามขั้นตอน operator | 24 ชั่วโมงแรก: failed jobs, REVIEW, รายการซ้ำ วันละครั้ง |

**คำเตือนขั้น 4b:** ถ้าตั้ง `SYNC_ALERT_DURABLE_ENABLED=true` แต่ไม่ตั้งหรือตั้ง `SYNC_ALERT_DURABLE_SINCE` ผิดรูปแบบ ระบบจะ**ทำงานแบบ main อย่างเงียบ ๆ** (แจ้งเหตุ DLQ ตรงแบบเดิม ไม่มี error) ให้ตรวจว่าค่าเป็น ISO-8601 UTC เช่น `2026-12-01T02:00:00Z` และหลัง deploy ตรวจว่ามีการ sweep เกิดขึ้น

**เงื่อนไขก่อนขั้น 5 และ 6:** ขั้น 5 เริ่มได้เมื่อผ่าน preflight checklist ด้านล่างครบทุกข้อ; ขั้น 6 เริ่มได้เมื่อ PR ที่เพิ่ม `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED` merge และ Worker ที่ deploy อยู่มีโค้ดนั้นแล้ว และค่านี้ไม่ได้ตั้ง (ตรวจจาก config ที่ deploy)

**จังหวะเวลาของขั้น 5–6:** ตามแผนเร่ง `ACTIVATE` ในช่วง 02:00–05:00 ของเช้ามืดวันศุกร์ 20 พ.ย. 2569 (สำรอง เสาร์ 21 พ.ย.); รายการที่ยืนยันก่อน `ACTIVATE` ลงแท็บเดิม และหลังจากนั้นลงแท็บต่อเนื่อง ยอดคงเหลือรวมทั้งสองแท็บตามหัวข้อ "งบตั้งต้นเมื่อเริ่มกลางเดือน" 

ห้ามเปิดในรอบนี้ เพราะต้องใช้ notice worker หรือยังไม่ผ่านการทดสอบ provider จริง: `CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED`, `CONTINUOUS_NOTICE_DISPATCH_ENABLED`, `CONTINUOUS_REVIEW_CLOSE_ENABLED`, `CONTINUOUS_PUBLICATION_ENABLED`, `CONTINUOUS_UNDO_SERIALIZATION_ENABLED`, `CONTINUOUS_REVOKE_REVIEW_*`, `CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED`, `CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED`, `CONTINUOUS_PROVIDER_CANARY_ENABLED`, `EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED`, `EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED` (เปิดได้ชั่วคราวเพื่ออ่านอย่างเดียวเมื่อเจ้าของอนุมัติ)

## Preflight checklist ก่อน `START_REVIEW` (ต้องครบทุกข้อ ไม่อย่างนั้นห้ามเริ่ม)

เมื่อเริ่มแล้วต้องไปให้ถึง `RELEASE` ข้อใดขาดจะทำให้ action ล้มกลางทางขณะที่ซิงก์ชีตทุกประเภทหยุด

- [ ] วันและเวลา: ช่วง 02:00–05:00 ของวันที่เจ้าของยืนยัน (ศุกร์ 20 พ.ย. หรือสำรอง เสาร์ 21 พ.ย.) ไม่ใช่วันพุธที่เป็นวันจ่าย payroll; มีผู้สั่ง action และเจ้าของพร้อมตัดสินตลอดช่วง
- [ ] ขั้น 1–4 เสร็จและอ่านผลกลับแล้ว: migration ไม่ค้าง, Worker ที่ deploy เป็น SHA ที่อนุมัติ, flag ขั้น 4a–4d ตั้งแล้ว และ `CONTINUOUS_DAILY_ENABLED` ยังไม่ตั้ง (operator ทำงานเฉพาะตอนที่ยังไม่ตั้ง)
- [ ] snapshot ล่าสุดก่อนเริ่ม (ไม่เกิน 30 นาที): Worker version `MATCH` กับ hash ที่กรอก และทุกข้อในตาราง "เงื่อนไขของ `START_REVIEW` ที่อ่านจาก snapshot" ด้านล่างผ่าน
- [ ] header `x-malipang-expected-worker-version` ของทุก request ถึง `/admin/stable-sync/continuous-cutover` และ `/admin/stable-sync/continuous-canary` ตรงกับ Worker version ที่รันอยู่ (`src/admin/handler.ts` ตรวจ ไม่ตรงได้ `WORKER_VERSION_MISMATCH`) และใช้ admin token ที่ถูกต้อง
- [ ] `CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED=true` และ `CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT` = ค่าจาก workflow `review_fingerprint` (รันหลัง snapshot ล่าสุด) = SHA-256 ของข้อมูลระบุตัวตนล็อกเดิม เป็น JSON array ตามลำดับ `[spreadsheet, operation_token, notice_stamp, notice_identity, created_at, phase, review_reason]` (ตาม `startPrewriteReview` ใน `src/admin/continuous-cutover-operator.ts`) ที่เจ้าของยืนยัน; คำนวณจากข้อมูลส่วนตัว ห้ามลงใน Issue
- [ ] ตรวจผลการเขียนเดิมของล็อก (ครั้งที่ทำให้ล็อกค้าง 14 พ.ย.) ในชีตแบบอ่านอย่างเดียวแล้ว และเจ้าของยืนยันว่าไม่ต้องเขียนซ้ำ
- [ ] ชื่อแท็บและ sheet ID 4 ค่าสำหรับขั้น `VIEWS` เลือกแล้วและตั้งใน config; แท็บ `V52_EXPENSE_RAW` และ `รายละเอียดการซื้อ` เดิมไม่เกิน 4,000 แถว
- [ ] request ของ `ACTIVATE` เตรียมไว้: body `{"action":"ACTIVATE","expenseIds":["<รหัสที่ 1>","<รหัสที่ 2>"]}` — ชื่อช่องใน HTTP คือ `expenseIds` (ภายในโค้ดคือ `mustBeCancelledOrAbsentExpenseIds`) ใช้ชื่ออื่นจะได้ `CUTOVER_RECEIPTS_INVALID`; รหัสมาจากหลักฐานส่วนตัว
- [ ] สำเนา Owner Master ภายใน 1 วันก่อน และ backup D1 ภายใน 1 ชั่วโมงก่อน (#295 ขั้นที่ 3)
- [ ] เจ้าของยืนยันว่างบหัวเดือน พ.ย. ในแท็บ `รายวัน` เดิมถูกต้อง และแท็บรายวันต่อเนื่องไม่มีแถว `AA:AC` ของ พ.ย.

### เงื่อนไขของ `START_REVIEW` ที่อ่านจาก snapshot

ตัวตรวจอยู่ใน `startPrewriteReview` (`src/admin/continuous-cutover-operator.ts:62-77`) และ trigger `continuous_operator_insert` ของ migration `0031` ถ้าข้อใดไม่ผ่าน action จะถูกปฏิเสธทั้งชุด (D1 batch เดียว) ไม่มีอะไรเปลี่ยน แต่ห้ามลองสั่งเพื่อดูผล ให้แก้ตามคอลัมน์ขวาหรือหยุด snapshot นับรวมทุก workbook จึงเข้มกว่าตัวตรวจที่นับเฉพาะ workbook นี้ ถ้าพบแถวที่น่าจะเป็นของ workbook อื่นก็ยังต้องหยุดและตรวจแยกแบบส่วนตัวก่อน

หลังขั้น 2 ส่วนเหล่านี้ต้องไม่มี `TABLE_ABSENT` (ถ้ามี = migration ไม่ครบ หยุด) ก่อนขั้น 2 การเห็น `TABLE_ABSENT` เป็นเรื่องปกติ

| ส่วนใน snapshot | ต้องเป็น | อ้างโค้ด | ถ้าไม่ผ่าน |
|---|---|---|---|
| `workbook_claims` | มีแถวเดียว: `REVIEW` / `OPERATION` / `STABLE_DAILY_REVIEW` / notice `YES` | `:62`, `:69`, trigger `0031` บรรทัด 17 | โค้ดรับ reason `STABLE_DAILY_*` อื่นด้วย แต่ trigger ของ `0031` รับเฉพาะ `STABLE_DAILY_REVIEW` จึงใช้ได้ค่าเดียว; ถ้า reason/phase อื่นหรือ notice `NO` ใช้ `START_REVIEW` ไม่ได้ (และ `START` ต้องไม่มี claim เลย) หยุดและถามเจ้าของ ห้ามแก้แถว claim ด้วยมือ |
| (ในชีต ไม่อยู่ใน snapshot) | ช่องสถานะของ notice ในชีตยังแสดงว่าพักอยู่ | `:63` `stableNoticePaused` | **ห้ามแก้ช่องสถานะ/notice ในชีตก่อนวันทำ** ถ้าถูกแก้ไปแล้ว ตัวตรวจจะได้ `CUTOVER_REVIEW_IDENTITY_UNVERIFIED` หยุดและถามเจ้าของ |
| `processing_sync_jobs`, `processing_staff_outbox` | `0` | `:76` | รอให้งานจบหรือ lease หมด แล้ว snapshot ใหม่; ถ้ายังไม่เป็น `0` หลัง 15 นาที หยุด ไม่เริ่มในรอบนี้ ห้ามแก้สถานะงานด้วยมือหรือ replay คิว |
| `projection_writes`, `cancellation_writes` | ทุกแถว state `VERIFIED` และไม่มีแถว token_scope `REVIEW_CLAIM` | `:17` (`noUnknown`), `:71-72` | `IN_FLIGHT`/`REVIEW` = ผลการเขียนชีตยังไม่รู้; `REVIEW_CLAIM` = ล็อกเดิมเขียนไปแล้วบางส่วน ทั้งสองกรณีใช้ `START_REVIEW` ไม่ได้ หยุด อ่านชีตแบบอ่านอย่างเดียวว่าเขียนจริงหรือไม่ แล้วเสนอแผนแยกให้เจ้าของ (แถวเหล่านี้ลบไม่ได้ด้วย trigger และห้ามแก้ด้วยมือ) |
| `recovery_operations` | ไม่มี state `ADMITTED` และไม่มีแถว token_scope `REVIEW_CLAIM` | `:73`, `:75` | `ADMITTED` = recovery ที่ arm ไว้ยังไม่จบ; `REVIEW_CLAIM` = ล็อกเดิมผูกกับ recovery หยุดและถามเจ้าของ ห้ามปิดด้วยมือ |
| `recovery_epochs` | ไม่มี `ARMED` หรือ `REVIEW` (`COMPLETE`/`CLOSED` ได้) | `:74` | หยุดและถามเจ้าของ |
| `cutover_operator` | `(no rows)` | `:70` | เคยเริ่ม cutover แล้ว `START_REVIEW` ใช้ซ้ำไม่ได้ อ่าน state แล้วทำตามหัวข้อ "Rollback หลังขั้น 5 (operator)" |
| `report_cutover_attempts` | `(no rows)` | `:77` | เคยมี report cutover แล้ว หยุดและถามเจ้าของ |

## งบตั้งต้นเมื่อเริ่มกลางเดือน

ตามโค้ด (`src/sheets/mixed-daily-accounting.ts` บรรทัด 28–34, 67, 70 และ `src/sheets/legacy-month-coverage.ts`):
- **งบตั้งต้นของเดือน** = แถวของเดือนนั้นในช่วง `AA4:AC243` ของแท็บรายวันต่อเนื่อง (AA = ปี ค.ศ., AB = เดือน, AC = ยอด ไม่ติดลบ, มีได้แถวเดียวต่อเดือน) ถ้าไม่มีแถว ใช้ยอดในช่อง E ของแถวหัวเดือน "รายรับทั้งหมดในบัญชี" ในแท็บ `รายวัน` เดิม ถ้ามีทั้งสองที่ ใช้ `AA:AC`
- **ยอดคงเหลือ** = งบตั้งต้น − รายจ่ายของเดือนนั้นในแท็บ `รายวัน` เดิม (อ่านสดทุกครั้ง) − รายจ่ายในแท็บต่อเนื่อง
- ดังนั้นการเริ่มกลางเดือนให้ใส่ **งบเต็มของเดือน** (หรือไม่ใส่ถ้างบหัวเดือนในแท็บเดิมถูกต้อง) **ห้ามใส่ "งบเต็ม − รายจ่ายในแท็บเดิม"** เพราะรายจ่ายแท็บเดิมจะถูกหักสองครั้ง

**คำตัดสินของเจ้าของ (2026-11-18):** เดือน พ.ย. ใช้งบหัวเดือนในแท็บ `รายวัน` เดิม **ไม่ใส่แถว `AA:AC`** (เจ้าของตรวจว่างบหัวเดือนถูกต้อง) ยกเลิกคำตัดสิน "งบเต็มลบรายจ่าย" ที่จะหักซ้ำ

**เดือนถัดไป (เช็กลิสต์หลัง cutover — ต้องเสร็จก่อน 1 ธ.ค. 2569 00:00):** ทุกครั้งที่ลงรายการ ระบบตรวจบล็อกเดือนนั้นในแท็บ `รายวัน` เดิม ถ้าแท็บเดิมไม่มีบล็อกเดือน ธ.ค. 2569 (แถวหัว "รายรับทั้งหมดในบัญชี" เดือน 12 และแถว "รวม") รายการแรกของเดือน ธ.ค. จะล้มแบบแน่นอน (`LEGACY_COVERAGE`) และพักทั้ง workbook ตามหัวข้อ `InsertDailyDefiniteFailure` ต้องตรวจและเตรียมบล็อกนั้น (หรือแถว `AA:AC` ของเดือน ธ.ค. ตามที่เจ้าของเลือก) ก่อน 1 ธ.ค. 00:00 เดือนของปีถัดไป (ม.ค. 2570) ใช้เส้นทางปีใหม่ที่ต้องมีแถว `AA:AC` ของเดือนนั้น

## ผลกระทบระหว่างขั้น 5–7 (recovery gate)

- **ผล:** เมื่อ `STABLE_RECOVERY_GATE_ENABLED=true` ตัว gate (`stableRecoveryGateBlocked` ใน `src/sheets/stable-recovery-admission.ts`) อนุญาตให้เขียนชีตเฉพาะเป้าหมายที่ operator arm ไว้ทีละรายการ **การซิงก์ชีตอื่นทั้งหมดหยุด** ทั้งการลงเวลา payroll รายวัน/รายสัปดาห์ ตารางกะ และค่าใช้จ่ายรายการอื่น งานไม่หาย: ถูกเก็บใน outbox (`sync_jobs` สถานะ PENDING) และข้อความในคิวถูก ACK
- **ระยะเวลา (เจ้าของตัดสินแล้ว):** ทำให้จบภายใน 02:00–05:00 ไม่ทำวันที่มีรอบจ่าย payroll; ถ้าติดเกิน 8 ชั่วโมงให้หยุดถามเจ้าของ การปิด gate กลางทางไม่ทำให้ซิงก์กลับมา (operator ยังถือล็อก) และทำให้ operator ทำต่อไม่ได้ จึงไม่ใช้
- **ช่วงที่ซิงก์หยุดจริงยาวกว่าขั้น 5–7:** ตั้งแต่ `START`/`START_REVIEW` (operator ถือ workbook claim แบบ HELD) จนถึง `RELEASE` ผู้เขียนชีตทุกตัวรอ claim อยู่แล้ว และ gate ทำให้หยุดต่อจนกว่าจะปิด gate
- **การปล่อยงานที่ค้าง:** หลังขั้น 7 ผ่าน ปิด `STABLE_RECOVERY_GATE_ENABLED` (deploy config) แล้ว cron `sheets_recovery` จะส่งงาน PENDING ที่ค้างอีกครั้งเองทีละไม่เกิน 4 งานต่อรอบเมื่อเปิด pacing ไม่ต้อง replay คิวด้วยมือ; งาน FAILED หรือ lease หมดอายุจะถูกพักเป็น REVIEW ถ้า `STABLE_REDRIVE_HOLD_ENABLED=true` ตรวจด้วย snapshot ว่าช่วงจำนวนงานผิดปกติไม่เพิ่ม

## การยกเลิกค่าใช้จ่ายอัตโนมัติเมื่อเปิด `CONTINUOUS_DAILY_ENABLED` (ขั้น 6)

เดิมเมื่อแท็บต่อเนื่องเปิดใช้ ระบบจะเปลี่ยนค่าใช้จ่ายที่ยืนยันแล้วเป็น "ยกเลิก" ใน D1 เองในบางกรณีที่การเขียนชีตล้มแบบแน่นอนก่อนส่งคำขอ (`src/sheets/unwritten-expense-cancellation-candidate.ts`) ตามคำตัดสินของเจ้าของ (#296 ข้อ 7) พฤติกรรมนี้อยู่หลัง `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED`: **ไม่ตั้ง = พักงานรอคนตรวจ ไม่ยกเลิก** ซึ่งเป็นค่าที่ใช้ใน release นี้; `true` = ยกเลิกแบบเดิม ใช้เมื่อเจ้าของอนุมัติแยกเท่านั้น

## ถ้าเขียนแถวรายวันล้มแบบแน่นอนหลังเปิดแท็บต่อเนื่อง (`InsertDailyDefiniteFailure`)

ตั้งแต่ขั้น 6 (`CONTINUOUS_DAILY_ENABLED=true`) การเพิ่มแถวในแท็บรายวันต่อเนื่องอาจล้มก่อนส่งคำขอเขียนด้วยเหตุที่แน่นอน 4 แบบ (`src/sheets/insert-daily-writer.ts`): `CAPACITY` (แท็บถึง 5,000 แถวหรือไม่มีแถวว่าง), `MONTH_OPENING` (แถวงบตั้งต้นของเดือนใน `AA:AC` ไม่มี มีหลายแถว หรือค่าไม่ถูกต้อง), `ROW_FORMULA` (สูตรช่วยของแถวไม่ตรงแบบ), `LEGACY_COVERAGE` (ตรวจยอดของแท็บเดิมไม่ได้)

**ผล:** เมื่อ `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED` ไม่ตั้ง (ค่าของ release นี้) ระบบไม่ยกเลิกรายการ และ error ถูกส่งต่อ (`src/sheets/stable-expense-job.ts:212-215`) ทำให้ workbook claim เป็น `REVIEW` ทั้ง workbook (`retainForReview` ใน `src/sheets/stable-workbook-claim.ts`) reason เป็น `INSERT_DAILY_<เหตุ>` **การซิงก์ชีตทุกประเภทหยุด รวม HR การลงเวลาและ payroll** ไม่ได้หยุดเฉพาะค่าใช้จ่ายรายการนั้น ไม่มีการเขียนชีตเกิดขึ้นสำหรับรายการนั้น และรายการใน D1 ยังเป็นสถานะยืนยัน

**ข้อจำกัดของ release นี้:** ยังไม่มี action ที่อนุมัติให้ปล่อย claim ที่มี reason นี้ — `START_REVIEW` รับเฉพาะ `STABLE_DAILY_REVIEW` และใช้ไม่ได้อีกเมื่อมีแถว `continuous_cutover_operator` แล้ว ส่วนเส้นทางปิด review (`CONTINUOUS_REVIEW_CLOSE_ENABLED`) อยู่ในรายการห้ามเปิดรอบนี้ การกู้จึงต้องเป็นแผนแยกที่เจ้าของอนุมัติ

**คำตัดสินของเจ้าของ (2026-11-18):** ยอมรับความเสี่ยงนี้ ไม่ทำ scoped hold ก่อนขั้น 6 ถ้าเกิดจะออกแบบวิธีปลดล็อกตอนนั้น โดยระหว่างนั้นซิงก์ชีตทุกประเภทหยุด ข้อเสนอให้พักเฉพาะรายการ (scoped hold) ใน #296 คงไว้เป็นงานในอนาคต ไม่ใช่เงื่อนไขของ release นี้

**ป้องกันก่อนขั้น 6 และทุกวันในช่วง 24 ชั่วโมงแรกของขั้น 7 (อ่านอย่างเดียว):** แท็บรายวันต่อเนื่องยังมีแถวว่างเหลือมากและห่างจาก 5,000 แถว, แถวงบตั้งต้นของเดือนใน `AA:AC` มีแถวเดียวและค่าไม่ติดลบ, สูตรช่วยของแถวล่าสุดตรงแบบ, แท็บเดิมที่ใช้ตรวจยอดไม่ถูกแก้โครงสร้าง

**เมื่อเกิด:**
1. ยืนยันจาก snapshot: `workbook_claims` เป็น `REVIEW` และ reason ขึ้นต้น `INSERT_DAILY_` บันทึกเวลา (เวลาไทย) และช่วงจำนวนใน #296 โดยไม่ใส่ชื่อร้าน ยอดเงิน หรือ ID
2. แจ้งเจ้าของทันทีว่า HR/payroll หยุดซิงก์ชีต งานไม่หาย (ค้างใน outbox) และพนักงานยังบันทึกผ่าน LINE OA ได้
3. ห้ามปลด REVIEW เหมา ห้าม replay คิว ห้ามแก้แถว claim หรือ journal ด้วยมือ ห้ามตั้ง `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED=true` เพื่อให้ผ่าน (เป็นการยกเลิกรายการ ต้องได้อนุมัติแยก)
4. อ่านชีตแบบอ่านอย่างเดียวตามเหตุ: `CAPACITY` จำนวนแถวของแท็บ; `MONTH_OPENING` แถวใน `AA:AC` ของเดือน; `ROW_FORMULA` สูตรช่วยของแถวท้าย; `LEGACY_COVERAGE` แท็บเดิม แล้วสรุปให้เจ้าของพร้อมแผนแก้ชีต
5. ออกแบบวิธีปลดล็อกตามคำตัดสินข้างบน เป็นงานแยก (Production Change ใหม่) ให้เจ้าของอนุมัติ ถ้าเกิน 8 ชั่วโมงให้ตัดสินกับเจ้าของว่าจะ rollback ตามหัวข้อด้านล่างหรือไม่

## Rollback หลังขั้น 5 (operator)

Cutover operator (`POST /admin/stable-sync/continuous-cutover`, `src/admin/continuous-cutover-operator.ts`) มี action ตามลำดับ `START` หรือ `START_REVIEW` → `VIEWS` → `DAILY_J` → `REPORTS` → `ACTIVATE` → `RELEASE` และ**ไม่มี action ย้อน cutover** — `RELEASE` ไม่ใช่การย้อนกลับ แต่เป็นขั้นปิดงาน: ตรวจรายงานที่ติดตั้ง ยืนยันว่า cutover เป็น `ACTIVE` แล้วปล่อย workbook claim เพื่อให้ซิงก์กลับมาทำงาน

- **action ใดล้ม:** operator และ workbook claim ถูกตั้งเป็น REVIEW เอง ไม่ retry อัตโนมัติ การซิงก์ชีตทั้งหมดยังหยุด ต้องตรวจผลในชีตและ D1 แล้วให้เจ้าของตัดสินทางแก้ต่อ
- **ก่อน `ACTIVATE`:** ตัวเขียนยังเป็นแบบเดิม ถ้าจะยกเลิก: แท็บที่ `VIEWS` สร้างไม่ถูกลบอัตโนมัติ (เจ้าของลบเอง) และคอลัมน์ J ของแท็บรายวัน/สูตรรายงานที่ `DAILY_J`/`REPORTS` เขียนต้องคืนจากสำเนา Owner Master หรือ version history; จากนั้นตัดสินเรื่อง claim ที่ operator ถืออยู่แยก
- **หลัง `ACTIVATE`:** ห้ามย้อน Worker ไปเวอร์ชันก่อน release (Worker เดิมเขียนแท็บเดิมต่อ); แถว cutover ใน D1 เป็น `ACTIVE` และแก้หรือลบไม่ได้ (มี trigger กัน) ทางเขียนแบบเดิมถูกกันถาวร; สิ่งที่ย้อนได้คือคืนคอลัมน์ J/สูตรรายงานจากสำเนา และลบแท็บใหม่ด้วยมือ แต่ตัวเขียนไม่กลับไปแท็บเดิม
- **ปิด `CONTINUOUS_DAILY_ENABLED` หลัง activation:** ทำได้ (deploy config) แต่ไม่ใช่การกลับไปแท็บเดิม — งานซิงก์ค่าใช้จ่ายจะได้ `CONTINUOUS_DAILY_LEGACY_WRITE_BLOCKED` ถูกเก็บไว้ใน outbox (ไม่หาย) และ ACK ข้อความ ค่าใช้จ่ายจึงหยุดลงชีตจนกว่าจะเปิดกลับหรือมี forward-fix; งาน HR/payroll ไม่กระทบ ใช้เป็นการหยุดฉุกเฉินได้ ห้าม deploy config ค่าเริ่มต้นทั้งชุดทับ
- **`ACTIVATE` ต้องระบุรหัสค่าใช้จ่าย 2 รายการ** ใน body `{"action":"ACTIVATE","expenseIds":[...]}` — ชื่อช่องใน HTTP คือ `expenseIds` (`src/admin/handler.ts`, `continuous-cutover-operator.ts`; ภายในคือ `mustBeCancelledOrAbsentExpenseIds`) ตัวตรวจบังคับเพียงว่าแต่ละรหัสต้องเป็น "ยกเลิก" หรือไม่มีอยู่ใน D1 จึงยืนยันตัวตนไม่ได้ ใช้สองรายการที่เจ้าของสั่งลบตาม #296 ข้อ 6 จากหลักฐานส่วนตัว ห้ามลงใน Issue
- **Canary operator** (`POST /admin/stable-sync/continuous-canary`): `PREPARE`, `ARM_CONFIRM`, `CONFIRM`, `VERIFY`, `ARM_DUPLICATE`, `VERIFY_DUPLICATE`, `ARM_UNDO`, `UNDO`, `RECONCILE_CONFIRM`, `RECONCILE_UNDO` และ `ABORT` สำหรับยกเลิก canary สังเคราะห์ (`exp_canary_*`) โดยเก็บผลเขียนที่ไม่แน่ชัดไว้ให้ตรวจ

### ช่องทาง Canary ขั้น 6

หลัง merge workflow และ deploy SHA ที่ผ่าน review แล้ว ใช้ `prod-canary-action.yml` จาก `main` ผ่าน GitHub `production` environment เท่านั้น: หนึ่ง run ต่อหนึ่ง action, ยืนยัน `OWNER APPROVES <ACTION> <sha7>`, SHA เต็ม, hash ของ Worker version ที่ทำงาน 100%, การ fence ผู้เขียนภายนอก และเจ้าของเฝ้าดูจริงทุกครั้ง. Workflow ตรวจ main, Worker, สถานะ cutover และ Canary ใน D1 ก่อน/หลัง; ไม่แสดง token หรือ ID และไม่ retry อัตโนมัติ. การตรวจนี้ไม่แทน backup/preflight, การตรวจชีตและรายงาน หรือ approval ตามขั้นตอน release.

ลำดับปกติ `PREPARE` → `CONFIRM` → `ARM_CONFIRM` → รอ queue และตรวจ D1/ชีต/รายงาน → `ARM_DUPLICATE` → รอ queue → `VERIFY_DUPLICATE` → `UNDO` → `ARM_UNDO` → รอ queue → `VERIFY`. ถ้าคำตอบหรือ readback ไม่แน่ชัดให้หยุด ห้ามสั่งซ้ำ; ตรวจหลักฐานก่อนใช้ `RECONCILE_CONFIRM` หรือ `RECONCILE_UNDO` เฉพาะเมื่อเงื่อนไขโค้ดรองรับ. Workflow ไม่เปิด `ABORT` เป็นทางลัด; การจัดการ incident ต้องใช้แผนที่ตรวจและอนุมัติแยก. การรอ queue หรือ provider ยังไม่เสร็จไม่ใช่เหตุให้ retry action.

## แท็บ RAW และรายละเอียดแบบต่อเนื่อง (สเปกจากโค้ด)

**คำตัดสินของเจ้าของ (2026-11-18):** ให้ cutover operator สร้างแท็บในขั้น `VIEWS` ที่เจ้าของอนุมัติ (แทนคำตัดสินเดิมที่ให้เจ้าของสร้างเอง ซึ่งทำไม่ได้เพราะตัวตรวจล้มถ้ามีแท็บอยู่ก่อน และคอลัมน์ Z ต้องเป็น marker ที่สร้างในคำขอเดียวกัน) เจ้าของเลือกชื่อแท็บและ sheet ID 4 ค่าล่วงหน้า

**ข้อยกเว้นเรื่องการเขียน Owner Master:** ระบบเขียนไฟล์ได้เฉพาะในขั้นของ operator ที่เจ้าของอนุมัติทีละขั้น (`VIEWS`, `DAILY_J`, `REPORTS`, `ACTIVATE`, `RELEASE` และขั้นของ canary operator) ภายใต้ workbook claim และอ่านผลกลับทุกครั้ง นอกจากนั้นทีมยังห้ามเขียนไฟล์

สิ่งที่ operator จะสร้างในขั้น `VIEWS`:

| แท็บ | ชื่อ | ขนาด | หัวแถว 1 | เนื้อหา |
|---|---|---|---|---|
| RAW ต่อเนื่อง | ค่า `CONTINUOUS_RAW_SHEET` (เสนอ `V52_EXPENSE_RAW_ต่อเนื่อง`) | 1,000 แถว × 26 คอลัมน์ (A:Z), ตรึงแถว 1 | `Expense_ID`, `Transaction_Date`, `Description`, `Amount_Baht`, `Payment_Key`, `Source_Wallet`, `Category`, `Status`, `Message_ID`, `Trace_ID`, `Submitted_By_Staff_ID`, `Branch_ID`, `Document_ID`, `Document_Type`, `Vendor`, `Document_Number`, `Order_ID`, `Sales_Addback_Basis` (A:R) | แถว 2–1000: สูตรใน A:Q อ่านค่าจาก carrier ใน Z, Z เป็น marker `MPL1_EMPTY_<แถว>_<สุ่ม>`, R เว้นให้กรอกตามธรรมเนียม addback |
| รายละเอียดต่อเนื่อง | ค่า `CONTINUOUS_DETAIL_SHEET` (เสนอ `รายละเอียดการซื้อ_ต่อเนื่อง`) | 1,000 × 26, ตรึงแถว 1 | `Purchase_Item_ID`, `Expense_ID`, `Document_ID`, `วันที่ซื้อ`, `บริษัท/ร้านค้า`, `เลขที่เอกสาร`, `รายการสินค้า`, `จำนวน`, `หน่วย`, `ราคาต่อหน่วย`, `ส่วนลดรายการ`, `จำนวนเงินรายการ`, `ส่วนลด/ปรับยอดระดับเอกสาร`, `ยอดจ่ายจริงของ Expense`, `หมวด`, `สาขา`, `สถานะ`, `Evidence ref (private)`, `Created_At`, `Updated_At / Cancelled_At` (A:T) | แถว 2–1000: สูตรใน A:T, Z เป็น marker |
| view รวม RAW | `V52_EXPENSE_RAW_ALL` (ตายตัว) | 9,999 × 18 | สูตร spill ใน A1 รวม `V52_EXPENSE_RAW` เดิม + RAW ต่อเนื่อง | ใช้กับรายงาน |
| view รวมรายละเอียด | `V52_PURCHASE_DETAIL_ALL` (ตายตัว) | 9,999 × 20 | สูตร spill ใน A1 รวม `รายละเอียดการซื้อ` เดิม + รายละเอียดต่อเนื่อง | ใช้กับรายงาน |

Sheet ID: **ไม่ต้องหาหลังสร้าง** เพราะ operator ใช้ค่าที่ตั้งไว้ล่วงหน้าเป็น ID ของแท็บใหม่ — เจ้าของเลือกจำนวนเต็มไม่ติดลบ 4 ค่าที่ไม่ซ้ำกันและไม่ซ้ำ ID ของแท็บใดที่มีอยู่ (ID ของแท็บที่มีอยู่ดูได้จาก `gid=` ใน URL ของแต่ละแท็บ) แล้วตั้งเป็น `CONTINUOUS_RAW_SHEET_ID`, `CONTINUOUS_DETAIL_SHEET_ID`, `CONTINUOUS_RAW_VIEW_ID`, `CONTINUOUS_DETAIL_VIEW_ID`; ส่วน `CONTINUOUS_DAILY_SHEET_ID` ต้องเป็น `gid` ของแท็บ `รายวันต่อเนื่อง_แบบร่าง` ที่มีอยู่

เงื่อนไขที่ตัวตรวจบังคับก่อนสร้าง: ชื่อทั้ง 4 ไม่ซ้ำกันและยังไม่มีในไฟล์; `SHEET_EXPENSE_RAW` เป็น `V52_EXPENSE_RAW` และแท็บรายละเอียดเดิมชื่อ `รายละเอียดการซื้อ`; แท็บ RAW/รายละเอียดเดิมมีไม่เกิน 4,000 แถว (ขนาด grid ต้องตรวจในไฟล์จริงก่อน); ต้องถือ workbook claim และเปิด `STABLE_RECOVERY_GATE_ENABLED`, `STABLE_SHEETS_PACING_ENABLED`, `CONTINUOUS_REPORT_CUTOVER_ENABLED` ขั้นถัดไปของ operator (`DAILY_J`, `REPORTS`) เขียนคอลัมน์ J ของแท็บรายวันและสูตรรายงาน ซึ่งเป็นการเขียน Owner Master ที่ต้องอนุมัติเช่นกัน

## ข้อควรรู้เรื่องแจ้งเหตุแบบ durable (ก่อนขั้น 4b)

- **ช่วงขั้น 2 ถึง 4b ตาราง `sync_alert_incidents` โตได้:** trigger ของ 0025 บันทึก incident ทุกครั้งที่งานเปลี่ยนเป็น FAILED/REVIEW หรือ workbook เข้า REVIEW ตั้งแต่รัน migration แต่การลบ incident เก่า (retention) ทำงานเฉพาะเมื่อ durable alerts เปิด จำนวนแถวเท่ากับจำนวนเหตุการณ์ผิดปกติในช่วงนั้น ไม่ได้โตตามจำนวนรายการปกติ
- **incident ที่ยังเปิดอยู่ก่อน cutoff จะไม่ถูกแจ้งอีก:** ก่อนตั้ง `SYNC_ALERT_DURABLE_SINCE` ให้ตรวจ incident ที่ยัง `OPEN` และยังไม่แจ้งด้วยตนเอง (อ่านอย่างเดียว เมื่อเจ้าของอนุมัติ) เช่น `SELECT kind,category,count(*) AS n FROM sync_alert_incidents WHERE state='OPEN' AND alerted_at IS NULL GROUP BY 1,2` แล้วจัดการเหตุที่ยังต้องทำก่อน เพราะหลังเปิด sweep จะตั้งเป็น `PRE_CUTOFF_SUPPRESSED` โดยไม่ส่ง

## ขีดจำกัด D1 ต่อ invocation (R3)

ผลวัดใน PR: ต่อหนึ่ง dispatch ของงานค่าใช้จ่าย**หนึ่งข้อความ**ใช้สูงสุด 31 calls / 49 statements (main ก่อน #291: 26 / 44) — ไม่รวมงานอื่นใน batch เดียวกัน (batch ที่มีงานชีตหลายข้อความจะเขียนได้ตัวเดียว ที่เหลือถูกพักด้วย D1 batch เดียว) **ยังไม่ยืนยันแผนของบัญชี Cloudflare** — Workers Paid อนุญาต 1,000 queries ต่อ invocation แต่ Free อนุญาต 50 และเทสต์เดิมใน repo จำกัด subrequest ไว้ที่ 50 ก่อนขั้น 3 เจ้าของต้องยืนยันแผนจากหน้า Billing; ถ้าเป็น Free ขอบเหลือราว 19 calls ต่อ invocation (นับ batch เป็น 1) ซึ่งแคบ ต้องประเมินใหม่ก่อน release

## ถ้า migration ล้มกลางไฟล์

ตำแหน่ง ALTER: ใน `0048` `ALTER TABLE continuous_notice_dispatches ADD COLUMN owner_token` เป็น statement แรก ส่วนใน `0055` `ALTER TABLE continuous_publication_intents ADD COLUMN financial_journal_revision` อยู่หลัง trigger ชุดแรก (บรรทัดที่ 25)

เอกสาร Cloudflare ระบุว่า migration ที่ล้มจะถูก rollback แต่ไม่ได้กำหนดขอบเขต transaction ถ้าสงสัยว่า `0048` หรือ `0055` ค้างครึ่งไฟล์:

1. อ่าน `SELECT name FROM pragma_table_info('<ตาราง>')` ของ `continuous_notice_dispatches` (0048) หรือ `continuous_publication_intents` (0055) เก็บเป็น JSON `{"<ตาราง>":["<คอลัมน์>",...]}`
2. `node scripts/migration-forward-fix.mjs migrations/<ไฟล์> <columns.json> > forward-fix.sql` (ไม่ต่อฐานข้อมูล)
3. เมื่อเจ้าของอนุมัติ: `wrangler d1 execute malipang-v5-2 --remote --file=forward-fix.sql` แล้วตรวจว่า object ของไฟล์ครบ (เทียบกับ schema ของ rehearsal)
4. บันทึก ledger เพื่อไม่ให้ `migrations apply` ครั้งถัดไปรันไฟล์นี้ซ้ำแล้วล้มที่ ALTER (รันซ้ำได้):
   `wrangler d1 execute malipang-v5-2 --remote --command "INSERT INTO d1_migrations(name) SELECT '<ชื่อไฟล์>' WHERE NOT EXISTS(SELECT 1 FROM d1_migrations WHERE name='<ชื่อไฟล์>')"`
   แล้วรัน `migrations apply` ต่อสำหรับไฟล์ที่เหลือ

## Rollback

- ขั้นที่ 3–4: workflow `rollback_worker` ไปเวอร์ชันที่ deploy run นั้นแทนที่ หรือ PR คืนค่า flag แล้ว `deploy` (schema แบบเพิ่ม Worker เดิมทำงานได้ตามผล rehearsal: smoke 13 ข้อของ #295 จำลองการเขียนของ Worker เดิมบน schema ใหม่ผ่านทั้งหมด)
- ขั้นที่ 5 เป็นต้นไป: ดูหัวข้อ "Rollback หลังขั้น 5 (operator)" ห้าม deploy config ค่าเริ่มต้นทับหลัง cutover
- ไม่ย้อน schema
