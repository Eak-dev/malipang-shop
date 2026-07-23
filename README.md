# MaliPang Backend V5.2 Solo — Cloudflare Core

Backend กลางของร้านมะลิปังสำหรับรับข้อมูลจาก LINE OA ประมวลผล Attendance, Payroll และ Expense บน Cloudflare แล้วเขียนรายงานไป Google Sheets โดยตรง ออกแบบให้ดูแลและติดตั้งได้โดยนักพัฒนาคนเดียว

> **สถานะ Apps Script:** V5.2 ไม่ใช้ Apps Script เป็น core runtime แต่ระบบ Apps Script เดิมอาจยังติดตั้งอยู่ภายนอก repository ระหว่างการย้ายระบบ ห้ามปิด Trigger, Deployment หรือลบ Legacy sheets จนกว่าจะตรวจ inventory, backup และผ่าน cutover gate ตามเอกสาร

## สถานะล่าสุด

**V5.2 RC2 — Shadow/UAT**

- Worker deploy และเชื่อม LINE OA จริงแล้ว
- D1, Queue, DLQ, Durable Object, R2 และ Google Sheets API ใช้งานจริงแล้ว
- OpenAI `gpt-4.1-mini` เป็นตัวอ่านรูปหลัก; ปิด Workers AI หลัง regression test รูปจริงคืน `UNKNOWN` ทุกภาพ
- Automated tests ผ่าน `91` รายการ, live expense text ผ่าน `161/161`, รูปนาฬิกาผ่าน `7/7` และสลิปธนาคาร/วอลเล็ตผ่าน `3/3`
- ทดสอบ LINE รูปนาฬิกาจริงแบบ IN และ OUT สำเร็จ
- ระบบยังอยู่ใน Shadow/UAT แต่เปิดการตอบกลับ LINE เพื่อทดสอบ Flow ค่าใช้จ่ายครบวงจร
- Attendance เปิดใช้งาน และ Expense เปิดเฉพาะผู้ใช้ที่ได้รับสิทธิ์เพื่อทดสอบ Shadow/UAT

ยังไม่ถือเป็น Production จนกว่าจะผ่าน UAT รูปจริงตามเกณฑ์ ปรับข้อมูลพนักงาน/ค่าแรงจริง ตรวจ Legacy Apps Script และเปิด LINE output อย่างตั้งใจ

Worker: <https://malipang-backend-v5-2.eakkachai-dev.workers.dev>

## ระบบทำงานอย่างไร

```text
LINE OA
  -> POST /webhook/line + ตรวจ X-Line-Signature
  -> Cloudflare Queue: malipang-jobs
  -> ดาวน์โหลด Preview + Original จาก LINE
  -> OpenAI gpt-4.1-mini
  -> อ่าน Timestamp + GPS overlay และยืนยันหลักฐานนาฬิการ้าน
  -> R2 เก็บรูปหลักฐาน
  -> Durable Object จัดลำดับ IN/OUT ต่อพนักงานต่อวัน
  -> D1 บันทึก Attendance + Daily Payroll + Weekly Payroll
  -> Queue สร้างงาน Google Sheets ก่อนตอบ LINE
  -> Google Sheets Direct API
```

Google Sheets เป็นหน้ารายงาน ไม่ใช่ฐานข้อมูลหรือเครื่องคำนวณหลัก ข้อมูลจริงและการคำนวณอยู่ใน D1/TypeScript

## ความสามารถใน RC2

### Attendance และ Payroll

- Official Time ใช้ Timestamp ตัวหนังสือสีขาวบนภาพเท่านั้น ไม่ใช้เวลา LINE หรือเลขบนหน้าปัด
- รูปต้องมีวัน เวลา พิกัด Latitude/Longitude และชื่อสถานที่/ที่อยู่ใน Overlay สีขาว ซึ่งอยู่มุมใดของภาพก็ได้
- ตรวจพิกัดเทียบรัศมีร้าน (ค่าเริ่มต้น 120 เมตร) และ Timestamp ต้องห่างจากเวลา LINEไม่เกิน 3 นาที
- นาฬิกาประจำร้านใช้เป็นหลักฐานสถานที่เท่านั้น ระบบไม่ใช้เวลา/วันที่บนหน้าปัดคำนวณค่าแรง
- ป้องกัน LINE redelivery และ Message ID ซ้ำ
- ใช้ Durable Object ป้องกัน IN/OUT ชนกัน
- คำนวณสาย ออกก่อน ค่าแรงรายวัน และยอดรายสัปดาห์บน Worker
- Missing punch และข้อมูลที่ต้องตรวจจะไม่ถูกปล่อยเป็นยอดพร้อมจ่าย
- มี Admin Correction พร้อม audit trail

### Vision

- Primary: OpenAI `gpt-4.1-mini` พร้อม Structured JSON
- Workers AI ปิดไว้ก่อน เพราะ baseline รูปจริงคืน `UNKNOWN 7/7`
- OpenAI daily guard ปัจจุบัน `25` ครั้ง/วัน
- แยกรูปเป็น `CLOCK`, `RECEIPT`, `BANK_SLIP`, `ONLINE_ORDER` หรือ `UNKNOWN`
- Admin สามารถตรวจรูป LINE ซ้ำได้โดยไม่สร้าง Attendance ใหม่

### Reliability

- D1 เป็น source of truth
- R2 เก็บหลักฐานแบบ private
- Sheets Sync Job ถูกบันทึกก่อนส่งข้อความสำเร็จกลับ LINE
- Retry, DLQ, failed jobs, reconcile/backfill และ stale-job recovery
- Metrics สำหรับ LINE download, Workers AI, OpenAI, R2, Sheets และเวลารวม
- `/admin/readiness` ตรวจ D1, LINE, Google Sheets และ R2 จริง

### Expense

- รองรับข้อความค่าใช้จ่ายและ Flex Message แบบเดียวกับ Flow หลักของ Apps Script เดิม
- `ทอน`, `change` และ `โอน` ภาษาไทยเป็น Quick Save พร้อมการ์ด Saved และ Undo
- รายการปกติแสดง Summary Flex และแก้วิธีจ่าย แหล่งเงิน หมวด และวันที่ก่อนบันทึกได้
- Undo เปลี่ยนสถานะเป็น `CANCELLED` และ Sync กลับ Google Sheets โดยไม่ลบ audit trail
- รายการที่ยืนยันแล้วเขียนทั้ง `V52_EXPENSE_RAW` และแท็บ `รายวัน` ตามรูปแบบบัญชีเดิม
- Mapping Wallet ของ First Choice และ The 1 ตรงกับ Master เดิม
- รองรับชื่อย่อบัตรจาก Apps Script เดิมครบ เช่น `kb/kasikorn`, `fc/first`, `citi`, `thanachart`, `hp`, `theone/the_one`
- Auto Category ใช้คำค้นไทยและอังกฤษจาก Expense Category Master รวมถึง `gas`, `electric`, `water`, `salary`, `delivery`, `custard`, `seal`, `tool` และ `ads`
- รองรับ KBank/K+, SCB และเป๋าตัง/G-Wallet เป็น Bank slip โดยอ่านสถานะ วันที่ เวลา เลขอ้างอิง คู่รายการ และยอดจ่ายจริง
- สลิปที่อ่านครบจะสร้างรายการ `WAITING_CONFIRM` และแสดง Flex ให้ตรวจหมวด/วันที่ก่อน Save; ยังไม่เขียน Google Sheets จนกดยืนยัน
- Bank slip ทุกธนาคารและวอลเล็ตล็อก Payment เป็น `transfer` และ Source Wallet เป็น `SHOP_BANK` ซึ่งแสดงในชีท `รายวัน` ว่า `บัญชีร้าน`
- เป๋าตังที่มีราคาก่อนสิทธิ์และส่วนลดจะบันทึกเฉพาะยอดจ่ายจริง เช่น `40 - 24 = 16` บาท
- กันสลิปซ้ำทั้งเลขอ้างอิงและ hash รูป และปฏิเสธสลิปที่ไม่แสดงสถานะสำเร็จ วันที่ เลขอ้างอิง คู่รายการ ยอดจ่ายจริง หรือยอดคำนวณไม่ตรง
- รูป Receipt/Online order ที่ยังไม่ใช่ Bank slip จะเก็บเป็นเอกสารรอตรวจ
- ยังไม่ใช่ระบบแตกสินค้าจากใบเสร็จเต็มรูปแบบ
- Shadow/UAT config ปัจจุบันตั้ง `EXPENSE_ENABLED=true` แต่รับเฉพาะพนักงานที่มี `can_submit_expense=1`

## Google Sheets

Spreadsheet: `MaliPang_OWNER_MASTER`

ระบบอ่านพนักงานจาก `HR_STAFF_CONFIG` และเขียนรายงานลง:

- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`
- `รายวัน` เฉพาะค่าใช้จ่ายที่ยืนยันแล้ว โดยค้นบล็อกเดือนและแถวว่างก่อนแถว `รวม`

ระบบเก็บ row index ใน D1 เพื่ออัปเดตแถวเดิมโดยไม่ต้องค้นทั้งชีททุกครั้ง และมี `/admin/reconcile-sheets` สำหรับสร้างงานรายงานใหม่จาก D1 การเขียน `รายวัน` จะไม่แก้สูตรใน I/J/R/S/U และ Undo จะล้างเฉพาะช่องข้อมูลที่ Backend เคยเขียน

สำหรับ Bank slip ที่ยืนยันแล้ว ระบบลงเดือน/วัน/คำอธิบายใน B/C/D, ยอดจ่ายจริงใน H (เงินโอน), หมวดใน V และ `บัญชีร้าน` ใน W ส่วนสถาบัน เลขอ้างอิง ยอดก่อนส่วนลด ส่วนลด ผู้ส่ง/ผู้รับ และ R2 key เก็บใน D1/R2 เพื่อ audit โดยไม่ยัดข้อมูลเพิ่มลงคอลัมน์สูตรของชีทเดิม

## ค่าที่เปิดใช้งานตอนนี้

| Setting | Value |
|---|---|
| `RUNTIME_MODE` | `shadow` |
| `SHADOW_LINE_OUTPUT` | `true` |
| `ATTENDANCE_ENABLED` | `true` |
| `ATTENDANCE_STORE_LAT/LNG` | `13.89682 / 100.60830` |
| `ATTENDANCE_ALLOWED_RADIUS_M` | `120` |
| `ATTENDANCE_MAX_PHOTO_AGE_MIN` | `3` |
| `EXPENSE_ENABLED` | `true` |
| `SHEETS_SYNC_ENABLED` | `true` |
| `SHEET_EXPENSE_DAILY` | `รายวัน` |
| `R2_EVIDENCE_ENABLED` | `true` |
| `WORKERS_AI_ENABLED` | `false` |
| `OPENAI_FALLBACK_ENABLED` | `true` |
| `OPENAI_MODEL` | `gpt-4.1-mini` |

Shadow/UAT ปัจจุบันประมวลผลและบันทึกข้อมูลจริง พร้อมส่ง Loading/Reply/Push กลับ LINE เพื่อทดสอบครบ Flow โดยสิทธิ์บันทึกค่าใช้จ่ายยังควบคุมด้วย `can_submit_expense`

## ผลทดสอบบริการจริง

UAT วันที่ 22 กรกฎาคม 2026:

- `/health` ผ่าน
- `/admin/readiness` ผ่าน D1, LINE OA, Google Sheets และ R2
- LINE IN/OUT แบบหน้าปัดเป็นเวลาหลักเคยผ่านในรุ่นก่อน แต่ต้องทดสอบ Live ใหม่หลังเปลี่ยนเป็น Timestamp + GPS
- รูปหลักฐานทั้ง IN/OUT พบใน R2 จริง
- Attendance, Daily Payroll และ Weekly Payroll sync ไป Sheets สำเร็จ
- Admin Correction และ audit trail ทำงานจริง
- Failed jobs หลังการทดสอบ: `0`
- `npm run check`: automated tests ผ่าน `91` รายการ (`3` live integration suites ถูก skip โดยค่าเริ่มต้น)
- Live expense text matrix หลัง Deploy ผ่าน `161/161`
- Contract รูปจริง 7 รูป: Photo 1–5 ต้องผ่าน Timestamp + GPS; Photo 6–7 ต้องไม่ผ่าน `GPS_MISSING`; รอ Live baseline ใหม่หลัง Deploy
- Regression สลิปจริง KBank, SCB และเป๋าตังผ่าน `3/3`: จำแนกเป็น `BANK_SLIP`, อ่านวันที่/เวลา/เลขอ้างอิง/ยอดได้ และ validation ผ่าน; KBank ปี `26` ถูก normalize เป็น `2026`, เป๋าตังบันทึกยอดจริง `16` จาก `40 - 24`
- เลขเวลา/วันที่และ weekday บนหน้าปัดไม่ใช้ตัดสิน Attendance; ระบบใช้ Timestamp สีขาวบนภาพเท่านั้น

การทดสอบนี้ยืนยันเส้นทางหลัก แต่ยังไม่แทน UAT หลายวันและรูปหลายสภาพแสง

## ตรวจโค้ดและ Deploy

ต้องใช้ Node.js 22 ขึ้นไป

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

Deploy และ migrate:

```bash
npm run db:migrate:remote
npm run deploy
```

คำสั่ง Deploy และ remote migration เป็นงาน Production/High Risk ต้องมี Issue, Backup, UAT, Rollback และ owner approval แยก การ Merge PR ไม่ถือเป็นการอนุมัติให้รันคำสั่งเหล่านี้

## Secrets ที่ต้องตั้งใน Cloudflare

ตั้งด้วย `npx wrangler secret put <NAME>` เท่านั้น ห้ามใส่ค่าจริงใน GitHub หรือ `wrangler.jsonc`

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_OWNER_USER_ID`
- `ADMIN_TOKEN` อย่างน้อย 32 ตัวอักษร
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY_BASE64`
- `GOOGLE_SPREADSHEET_ID`
- `OPENAI_API_KEY`

## Admin endpoints

ทุก endpoint ใต้ `/admin/*` ต้องใช้ `Authorization: Bearer <ADMIN_TOKEN>`

- `GET /admin/status`
- `GET /admin/readiness`
- `POST /admin/bootstrap-sheets`
- `POST /admin/import-employees-from-sheet`
- `POST /admin/import-employees`
- `POST /admin/expense-access`
- `POST /admin/expense/evaluate` สำหรับทดสอบข้อความโดยไม่บันทึก D1/Sheets
- `POST /admin/attendance/correct`
- `POST /admin/retry-sync`
- `POST /admin/reconcile-sheets`
- `POST /admin/vision/inspect`
- `POST /admin/vision/evaluate` สำหรับ regression test รูป JPEG จริงเท่านั้น ไม่เก็บรูปและต้องใช้ Admin Token
- `POST /admin/vision/evaluate-evidence` สำหรับอ่านรูปที่อยู่ใน R2 ซ้ำด้วย key โดยไม่สร้าง Expense และต้องใช้ Admin Token
- `GET /admin/evidence/<R2 key>`

ทดสอบข้อความค่าใช้จ่ายกับ Worker จริงโดยไม่สร้างรายการ:

```bash
MALIPANG_EXPENSE_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
npm run test:expense-text
```

ชุดทดสอบรูปนาฬิกาจริงอยู่ที่ `tests/fixtures/clock-photos` รันกับ Worker ที่ deploy แล้วด้วย ไฟล์ `.jpg` ถูก Git ignore เพราะมีเวลา ที่อยู่ และพิกัดจริง ส่วน `cases.json` เก็บเฉพาะผลที่คาดหวัง:

```bash
MALIPANG_VISION_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

ระหว่างเปรียบเทียบโมเดลหรือทดสอบเฉพาะรูป สามารถเพิ่ม `MALIPANG_OPENAI_MODEL=gpt-4.1-mini` และ `MALIPANG_CLOCK_CASES=photo-02` ได้

Regression contract ของ KBank, SCB และเป๋าตังอยู่ใน `tests/fixtures/bank-slip-cases.json` ส่วนรูปจริงไม่ commit ลง Git ให้ส่ง path ผ่าน JSON environment แล้วรัน:

```bash
MALIPANG_VISION_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
MALIPANG_BANK_SLIP_IMAGE_MAP='{"kbank-kplus":"/path/kbank.jpg","scb-easy":"/path/scb.jpg","paotang-gwallet":"/path/paotang.jpg"}' \
npm run test:bank-slips
```

การทดสอบผ่าน `/admin/vision/inspect` และ `/admin/vision/evaluate` ใช้ตัวนับ `openai_admin_test_calls` แยกจากรูปจริงของพนักงาน จึงไม่กินโควตา `openai_fallback_calls` ฝั่ง Production ส่วนรูปที่ไม่ผ่านจะตอบ LINE ด้วยสาเหตุ วิธีแก้ และรหัสตรวจสอบ โดยไม่แสดงข้อผิดพลาดดิบหรือข้อมูลลับของผู้ให้บริการ AI ค่าเริ่มต้นฝั่ง Production จำกัดไว้ 100 ครั้งต่อวัน

ข้อความ LINE สำหรับ Attendance ทั้งสำเร็จและไม่ผ่านแสดง 3 ภาษาตามลำดับ: ไทย, English และ မြန်မာ โดยเมื่อบันทึกสำเร็จจะระบุ `Photo timestamp`, `GPS check: Passed` และ `Shop clock evidence: Passed` ตามข้อมูลที่ระบบตรวจจริง ส่วนข้อความและ Flex UI ของ Expense ใช้ English เท่านั้น แต่รายละเอียดรายการที่ผู้ใช้พิมพ์เป็นภาษาไทยยังคงเก็บและแสดงได้ตามเดิม

### กติกาภาพลงเวลา (Timestamp + GPS)

1. ต้องเห็นนาฬิกาสีดำประจำร้านชัดพอให้ AI ยืนยันลักษณะเฉพาะได้ แต่นาฬิกาเป็นหลักฐานประกอบเท่านั้น
2. ต้องมี Overlay ตัวหนังสือสีขาวซึ่งมีวันที่ เวลา พิกัดตัวเลข Latitude/Longitude และชื่อสถานที่/ที่อยู่ โดยอยู่ตำแหน่งใดในภาพก็ได้
3. ระบบใช้วันและเวลาจาก Overlay เป็น `Work_Date` และ `Official_Time` เพียงแหล่งเดียว
4. ระบบตรวจพิกัดเทียบ `ATTENDANCE_STORE_LAT/LNG`, รัศมี `ATTENDANCE_ALLOWED_RADIUS_M` และตรวจภาพเก่าด้วย `ATTENDANCE_MAX_PHOTO_AGE_MIN`
5. ภาพที่ไม่มี GPS, Overlay ไม่ใช่สีขาว, อยู่นอกรัศมี, Timestamp เก่า หรือยืนยันนาฬิการ้านไม่ได้ จะไม่ถูกบันทึกและ LINE จะแจ้งสาเหตุสามภาษา

## ก่อนเปิด Production

1. ตรวจ `HR_STAFF_CONFIG` ให้ LINE User ID, ตารางงาน, ค่าแรง, grace และค่าหักเป็นข้อมูลจริง
2. ทดสอบรูปนาฬิกาจริงอย่างน้อย 50 รูป หลายระยะ แสง และมุม
3. ทดสอบ IN/OUT, ส่งซ้ำ, missing punch, concurrency, retry, DLQ และ reconcile
4. ตรวจ Accuracy อย่างน้อย 99%, lost event = 0 และ duplicate payroll = 0
5. ตรวจ R2 lifecycle ลบหลักฐานตามนโยบายที่กำหนด
6. ตรวจ Apps Script triggers/deployments และ Backup ก่อนปิดระบบเดิม
7. ตรวจ LINE webhook ให้ชี้ Runtime หลักเพียงระบบเดียว และปิด Auto-reply ที่ทำให้ตอบซ้ำ
8. เปลี่ยน `RUNTIME_MODE` เป็น `production` และเปิด LINE output หลังอนุมัติ UAT เท่านั้น
9. เฝ้าดู D1, failed jobs, Queue, Sheets และค่าใช้ OpenAI ในช่วงเปิดจริง

## เอกสารเพิ่มเติม

- [ติดตั้งระบบ](docs/01_SETUP_TH.md)
- [Google Sheets mapping](docs/02_SHEET_MAPPING_TH.md)
- [ทดสอบและ Cutover](docs/03_TEST_AND_CUTOVER_TH.md)
- [คู่มือดูแลระบบ](docs/04_OPERATIONS_TH.md)
- [LINE Flex และ Flow ค่าใช้จ่าย](docs/05_LINE_FLEX_FLOW_TH.md)
- [สถานะ Legacy Apps Script](docs/06_LEGACY_APPS_SCRIPT_STATUS_TH.md)
- [Architecture และ Operating Model](docs/07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md)
- [Release และ Cutover Plan](docs/08_RELEASE_AND_CUTOVER_PLAN_TH.md)
- [Owner Action Checklist](docs/09_OWNER_ACTION_CHECKLIST_TH.md)
- [Codex Task Template](docs/10_CODEX_TASK_TEMPLATE_TH.md)