# MaliPang Backend V5.2 Solo — No Apps Script

Backend กลางของร้านมะลิปังสำหรับรับข้อมูลจาก LINE OA ประมวลผล Attendance และ Payroll บน Cloudflare แล้วเขียนรายงานไป Google Sheets โดยตรง ออกแบบให้ดูแลและติดตั้งได้โดยนักพัฒนาคนเดียว

## สถานะล่าสุด

**V5.2 RC2 — Shadow/UAT**

- Worker deploy และเชื่อม LINE OA จริงแล้ว
- D1, Queue, DLQ, Durable Object, R2 และ Google Sheets API ใช้งานจริงแล้ว
- OpenAI `gpt-4.1-mini` เป็นตัวอ่านรูปหลัก; ปิด Workers AI หลัง regression test รูปจริงคืน `UNKNOWN` ทุกภาพ
- Automated tests ผ่าน `51` รายการ, live expense text ผ่าน `38/38` และ live photo regression ผ่าน `7/7`
- ทดสอบ LINE รูปนาฬิกาจริงแบบ IN และ OUT สำเร็จ
- ระบบยังอยู่ใน Shadow/UAT แต่เปิดการตอบกลับ LINE เพื่อทดสอบ Flow ค่าใช้จ่ายครบวงจร
- Attendance เปิดใช้งาน และ Expense เปิดเฉพาะผู้ใช้ที่ได้รับสิทธิ์เพื่อทดสอบ Shadow/UAT

ยังไม่ถือเป็น Production จนกว่าจะผ่าน UAT รูปจริงตามเกณฑ์ ปรับข้อมูลพนักงาน/ค่าแรงจริง และเปิด LINE output อย่างตั้งใจ

Worker: <https://malipang-backend-v5-2.eakkachai-dev.workers.dev>

## ระบบทำงานอย่างไร

```text
LINE OA
  -> POST /webhook/line + ตรวจ X-Line-Signature
  -> Cloudflare Queue: malipang-jobs
  -> ดาวน์โหลด Preview + Original จาก LINE
  -> OpenAI gpt-4.1-mini
  -> ตรวจเวลา เดือน และวันที่จากหน้าปัด
  -> R2 เก็บรูปหลักฐาน
  -> Durable Object จัดลำดับ IN/OUT ต่อพนักงานต่อวัน
  -> D1 บันทึก Attendance + Daily Payroll + Weekly Payroll
  -> Queue สร้างงาน Google Sheets ก่อนตอบ LINE
  -> Google Sheets Direct API
```

Google Sheets เป็นหน้ารายงาน ไม่ใช่ฐานข้อมูลหรือเครื่องคำนวณหลัก ข้อมูลจริงและการคำนวณอยู่ใน D1/TypeScript

## ความสามารถใน RC2

### Attendance และ Payroll

- Official Time ใช้เวลาจากหน้าปัดนาฬิกาเท่านั้น
- ตรวจชั่วโมง นาที เดือน วันที่ ความมั่นใจ และความต่างจากเวลา LINE
- ไม่ให้ weekday ที่ AI อ่านคลาดเคลื่อนทำให้ติด REVIEW หากเดือน วันที่ และเวลาผ่าน
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

- รองรับข้อความค่าใช้จ่ายแบบง่ายและ flow ยืนยัน
- ชุดข้อความเงินสด/โอน/บัตร/วันที่/หมวด/ข้อความผิด ผ่าน Worker จริง `38/38`
- รองรับเก็บรูป Receipt/Bank slip เป็นเอกสารรอตรวจ
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

ระบบเก็บ row index ใน D1 เพื่ออัปเดตแถวเดิมโดยไม่ต้องค้นทั้งชีททุกครั้ง และมี `/admin/reconcile-sheets` สำหรับสร้างงานรายงานใหม่จาก D1

## ค่าที่เปิดใช้งานตอนนี้

| Setting | Value |
|---|---|
| `RUNTIME_MODE` | `shadow` |
| `SHADOW_LINE_OUTPUT` | `true` |
| `ATTENDANCE_ENABLED` | `true` |
| `EXPENSE_ENABLED` | `true` |
| `SHEETS_SYNC_ENABLED` | `true` |
| `R2_EVIDENCE_ENABLED` | `true` |
| `WORKERS_AI_ENABLED` | `false` |
| `OPENAI_FALLBACK_ENABLED` | `true` |
| `OPENAI_MODEL` | `gpt-4.1-mini` |

Shadow/UAT ปัจจุบันประมวลผลและบันทึกข้อมูลจริง พร้อมส่ง Loading/Reply/Push กลับ LINE เพื่อทดสอบครบ Flow โดยสิทธิ์บันทึกค่าใช้จ่ายยังควบคุมด้วย `can_submit_expense`

## ผลทดสอบบริการจริง

UAT วันที่ 22 กรกฎาคม 2026:

- `/health` ผ่าน
- `/admin/readiness` ผ่าน D1, LINE OA, Google Sheets และ R2
- LINE IN: หน้าปัด `04:27`, เวลา LINE `04:26`, ผล `NORMAL / OK`
- LINE OUT: หน้าปัดและเวลา LINE `07:04`, บันทึกเป็น OUT สำเร็จ
- รูปหลักฐานทั้ง IN/OUT พบใน R2 จริง
- Attendance, Daily Payroll และ Weekly Payroll sync ไป Sheets สำเร็จ
- Admin Correction และ audit trail ทำงานจริง
- Failed jobs หลังการทดสอบ: `0`
- `npm run check`: automated tests ผ่าน `51` รายการ (`2` live suites ถูก skip โดยค่าเริ่มต้น)
- Regression รูปจริง 7 รูป: เวลา เดือน วันที่ และ validation ผ่าน `7/7` ด้วย `gpt-4.1-mini`
- Weekday OCR ไม่เชื่อถือและไม่ใช้ตัดสิน Attendance; ระบบคืน `weekday=null`

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

## ก่อนเปิด Production

1. ตรวจ `HR_STAFF_CONFIG` ให้ LINE User ID, ตารางงาน, ค่าแรง, grace และค่าหักเป็นข้อมูลจริง
2. ทดสอบรูปนาฬิกาจริงอย่างน้อย 50 รูป หลายระยะ แสง และมุม
3. ทดสอบ IN/OUT, ส่งซ้ำ, missing punch, concurrency, retry, DLQ และ reconcile
4. ตรวจ Accuracy อย่างน้อย 99%, lost event = 0 และ duplicate payroll = 0
5. ตรวจ R2 lifecycle ลบหลักฐานตามนโยบายที่กำหนด
6. ปิด Auto-reply ของ LINE OA เพื่อไม่ให้ตอบซ้ำกับ Backend
7. เปลี่ยน `RUNTIME_MODE` เป็น `production` และเปิด LINE output หลังอนุมัติ UAT เท่านั้น
8. เฝ้าดู D1, failed jobs, Queue, Sheets และค่าใช้ OpenAI ในช่วงเปิดจริง

## เอกสารเพิ่มเติม

- [ติดตั้งระบบ](docs/01_SETUP_TH.md)
- [Google Sheets mapping](docs/02_SHEET_MAPPING_TH.md)
- [ทดสอบและ Cutover](docs/03_TEST_AND_CUTOVER_TH.md)
- [คู่มือดูแลระบบ](docs/04_OPERATIONS_TH.md)
