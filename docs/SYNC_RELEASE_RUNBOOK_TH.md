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
| 4b | แจ้งเหตุแบบ durable | `SYNC_ALERT_DURABLE_ENABLED=true`, `SYNC_ALERT_DURABLE_SINCE=<เวลาที่เปิด, ISO UTC>`, (`SYNC_ALERT_INCIDENT_RETENTION_DAYS` ถ้าไม่ใช้ค่าเริ่มต้น 30) | ไม่มีการแจ้งเหตุย้อนหลังก่อน cutoff |
| 4c | ส่วนเสริม | `WORKBOOK_BATCH_FAIRNESS_ENABLED=true`, `EXPENSE_SAVED_SYNC_NOTE_ENABLED=true` | งาน HR และค่าใช้จ่ายสลับกันได้, การ์ด LINE แสดงข้อความใหม่ |
| 4d | เป้าหมายแท็บ | `STABLE_CANCELLATION_PREIMAGE_ENABLED=true`, `CONTINUOUS_DAILY_SHEET`/`_ID`, `CONTINUOUS_RAW_SHEET`/`_ID`, `CONTINUOUS_DETAIL_SHEET`/`_ID` (ตามคำตัดสินเรื่องแท็บ) | `CONTINUOUS_DAILY_ENABLED` ยังไม่ตั้ง |
| 5 | cutover | `STABLE_RECOVERY_GATE_ENABLED=true`, `CONTINUOUS_REPORT_CUTOVER_ENABLED=true`, `CONTINUOUS_CUTOVER_OPERATOR_ENABLED=true` แล้วสั่ง operator ตามขั้นตอนของ `/admin/stable-sync/continuous-cutover` | operator อยู่สถานะพร้อม, ไม่มีงานค้าง `PROCESSING` |
| 6 | canary รายการเดียว | `CONTINUOUS_DAILY_ENABLED=true`, `CONTINUOUS_CANARY_OPERATOR_ENABLED=true` | อ่านกลับแถว ยอด สูตร `I/J/R/S/U` และรายงาน; ส่งซ้ำจำกัดรายการแล้วไม่เพิ่ม; Undo รายการเดียวกันแล้วอ่านกลับ |
| 7 | ขยายวง | ปิด `CONTINUOUS_CANARY_OPERATOR_ENABLED` ตามขั้นตอน operator | 24 ชั่วโมงแรก: failed jobs, REVIEW, รายการซ้ำ วันละครั้ง |

ห้ามเปิดในรอบนี้ เพราะต้องใช้ notice worker หรือยังไม่ผ่านการทดสอบ provider จริง: `CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED`, `CONTINUOUS_NOTICE_DISPATCH_ENABLED`, `CONTINUOUS_REVIEW_CLOSE_ENABLED`, `CONTINUOUS_PUBLICATION_ENABLED`, `CONTINUOUS_UNDO_SERIALIZATION_ENABLED`, `CONTINUOUS_REVOKE_REVIEW_*`, `CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED`, `CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED`, `CONTINUOUS_PROVIDER_CANARY_ENABLED`, `EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED`, `EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED` (เปิดได้ชั่วคราวเพื่ออ่านอย่างเดียวเมื่อเจ้าของอนุมัติ)

## แท็บ RAW และรายละเอียดแบบต่อเนื่อง (สเปกจากโค้ด)

**ข้อขัดกับคำตัดสินที่ว่าเจ้าของสร้างแท็บเอง:** ในโค้ดปัจจุบัน แท็บ RAW/รายละเอียดแบบต่อเนื่องถูกสร้างโดย cutover operator ขั้น `VIEWS` (`bootstrapContinuousReportViews` ใน `src/sheets/report-view-bootstrap.ts`) ในคำขอเดียวพร้อมแท็บ view อีก 2 แท็บ และตัวตรวจจะ**ล้มทันทีถ้ามีแท็บชื่อหรือ ID เดียวกันอยู่ก่อน** (`REPORT_VIEW_TARGET_UNVERIFIED`) อีกทั้งคอลัมน์ Z ทุกแถวต้องเป็น marker สุ่มที่สร้างในคำขอนั้นเท่านั้น จึงสร้างด้วยมือล่วงหน้าแทนไม่ได้ ต้องให้เจ้าของตัดสินใหม่ระหว่าง (ก) ให้ operator สร้างแท็บในขั้น `VIEWS` ที่เจ้าของอนุมัติ หรือ (ข) แก้โค้ดให้รับแท็บที่สร้างด้วยมือ (งานใหญ่ ต้องออกแบบการตรวจใหม่)

สิ่งที่ operator จะสร้าง (ทางเลือก ก):

| แท็บ | ชื่อ | ขนาด | หัวแถว 1 | เนื้อหา |
|---|---|---|---|---|
| RAW ต่อเนื่อง | ค่า `CONTINUOUS_RAW_SHEET` (เสนอ `V52_EXPENSE_RAW_ต่อเนื่อง`) | 1,000 แถว × 26 คอลัมน์ (A:Z), ตรึงแถว 1 | `Expense_ID`, `Transaction_Date`, `Description`, `Amount_Baht`, `Payment_Key`, `Source_Wallet`, `Category`, `Status`, `Message_ID`, `Trace_ID`, `Submitted_By_Staff_ID`, `Branch_ID`, `Document_ID`, `Document_Type`, `Vendor`, `Document_Number`, `Order_ID`, `Sales_Addback_Basis` (A:R) | แถว 2–1000: สูตรใน A:Q อ่านค่าจาก carrier ใน Z, Z เป็น marker `MPL1_EMPTY_<แถว>_<สุ่ม>`, R เว้นให้กรอกตามธรรมเนียม addback |
| รายละเอียดต่อเนื่อง | ค่า `CONTINUOUS_DETAIL_SHEET` (เสนอ `รายละเอียดการซื้อ_ต่อเนื่อง`) | 1,000 × 26, ตรึงแถว 1 | `Purchase_Item_ID`, `Expense_ID`, `Document_ID`, `วันที่ซื้อ`, `บริษัท/ร้านค้า`, `เลขที่เอกสาร`, `รายการสินค้า`, `จำนวน`, `หน่วย`, `ราคาต่อหน่วย`, `ส่วนลดรายการ`, `จำนวนเงินรายการ`, `ส่วนลด/ปรับยอดระดับเอกสาร`, `ยอดจ่ายจริงของ Expense`, `หมวด`, `สาขา`, `สถานะ`, `Evidence ref (private)`, `Created_At`, `Updated_At / Cancelled_At` (A:T) | แถว 2–1000: สูตรใน A:T, Z เป็น marker |
| view รวม RAW | `V52_EXPENSE_RAW_ALL` (ตายตัว) | 9,999 × 18 | สูตร spill ใน A1 รวม `V52_EXPENSE_RAW` เดิม + RAW ต่อเนื่อง | ใช้กับรายงาน |
| view รวมรายละเอียด | `V52_PURCHASE_DETAIL_ALL` (ตายตัว) | 9,999 × 20 | สูตร spill ใน A1 รวม `รายละเอียดการซื้อ` เดิม + รายละเอียดต่อเนื่อง | ใช้กับรายงาน |

Sheet ID: **ไม่ต้องหาหลังสร้าง** เพราะ operator ใช้ค่าที่ตั้งไว้ล่วงหน้าเป็น ID ของแท็บใหม่ — เจ้าของเลือกจำนวนเต็มไม่ติดลบ 4 ค่าที่ไม่ซ้ำกันและไม่ซ้ำ ID ของแท็บใดที่มีอยู่ (ID ของแท็บที่มีอยู่ดูได้จาก `gid=` ใน URL ของแต่ละแท็บ) แล้วตั้งเป็น `CONTINUOUS_RAW_SHEET_ID`, `CONTINUOUS_DETAIL_SHEET_ID`, `CONTINUOUS_RAW_VIEW_ID`, `CONTINUOUS_DETAIL_VIEW_ID`; ส่วน `CONTINUOUS_DAILY_SHEET_ID` ต้องเป็น `gid` ของแท็บ `รายวันต่อเนื่อง_แบบร่าง` ที่มีอยู่

เงื่อนไขที่ตัวตรวจบังคับก่อนสร้าง: ชื่อทั้ง 4 ไม่ซ้ำกันและยังไม่มีในไฟล์; `SHEET_EXPENSE_RAW` เป็น `V52_EXPENSE_RAW` และแท็บรายละเอียดเดิมชื่อ `รายละเอียดการซื้อ`; แท็บ RAW/รายละเอียดเดิมมีไม่เกิน 4,000 แถว (ขนาด grid ต้องตรวจในไฟล์จริงก่อน); ต้องถือ workbook claim และเปิด `STABLE_RECOVERY_GATE_ENABLED`, `STABLE_SHEETS_PACING_ENABLED`, `CONTINUOUS_REPORT_CUTOVER_ENABLED` ขั้นถัดไปของ operator (`DAILY_J`, `REPORTS`) เขียนคอลัมน์ J ของแท็บรายวันและสูตรรายงาน ซึ่งเป็นการเขียน Owner Master ที่ต้องอนุมัติเช่นกัน

## ถ้า migration ล้มกลางไฟล์

เอกสาร Cloudflare ระบุว่า migration ที่ล้มจะถูก rollback แต่ไม่ได้กำหนดขอบเขต transaction ถ้าสงสัยว่า `0048` หรือ `0055` ค้างครึ่งไฟล์:

1. อ่าน `SELECT name FROM pragma_table_info('<ตาราง>')` ของ `continuous_notice_dispatches` (0048) หรือ `continuous_publication_intents` (0055) เก็บเป็น JSON `{"<ตาราง>":["<คอลัมน์>",...]}`
2. `node scripts/migration-forward-fix.mjs migrations/<ไฟล์> <columns.json> > forward-fix.sql` (ไม่ต่อฐานข้อมูล)
3. เมื่อเจ้าของอนุมัติ: `wrangler d1 execute malipang-v5-2 --remote --file=forward-fix.sql` แล้วบันทึกชื่อไฟล์ใน `d1_migrations` ตามขั้นตอนที่อนุมัติใน #296

## Rollback

- ขั้นที่ 3–4: ปิด flag ล่าสุดหรือ rollback Worker ไปเวอร์ชันก่อนหน้า (schema แบบเพิ่ม Worker เดิมทำงานได้ตามผล rehearsal)
- ขั้นที่ 5 เป็นต้นไป: ทำตามขั้นตอนของ operator ห้าม deploy config ค่าเริ่มต้นทับหลัง cutover
- ไม่ย้อน schema
