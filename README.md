# MaliPang Backend V5.2 Solo — Production

Backend กลางของร้าน **มะลิปัง (MaliPang)** สำหรับรับข้อมูลจาก LINE OA, ประมวลผล Attendance / Payroll / Expense บน Cloudflare, เก็บข้อมูลจริงใน D1, เก็บหลักฐานใน R2 และ Sync รายงานไป Google Sheets โดยตรง

ระบบออกแบบให้ใช้งานจริงในร้านได้ด้วยทีมเล็กและดูแลได้โดยนักพัฒนาคนเดียว โดยให้ความสำคัญกับ **ความถูกต้อง, auditability, idempotency, rollback และต้นทุนต่ำ** มากกว่าการทำระบบที่ซับซ้อนเกินจำเป็น

> **Production status:** ระบบ V5.2 เปิดใช้งาน Production แล้วเมื่อ 29 กรกฎาคม 2026
>
> **Core runtime:** Cloudflare Workers + D1 + Durable Objects + Queues/DLQ + R2 + LINE Messaging API + Google Sheets API + OpenAI Vision
>
> **Legacy Apps Script:** ไม่ใช่ core runtime ของ V5.2 แต่ยังถือเป็น external legacy dependency จนกว่าจะผ่าน parity / shutdown gate แยก ห้ามปิด Trigger, Deployment หรือลบ Legacy sheets จากงาน V5.2 โดยพลการ

---

## 1. Production Snapshot ล่าสุด

Snapshot นี้ใช้สำหรับอ้างอิงสถานะที่ผ่าน Production verification ล่าสุด ไม่ใช่ค่าที่ควร hard-code ลง logic

| รายการ | สถานะ |
|---|---|
| Environment | `production` |
| Runtime mode | `production` |
| Production source SHA | `8918ceb6cd8841c1619fbc30f66532188ba6007e` |
| Production Worker version | `fd37c92e-c5de-417f-8728-b646c6fdb71a` |
| Worker traffic | `100%` |
| Health | PASS |
| Readiness | PASS |
| LINE architecture | `REPLY_FIRST_FREE_PLAN` |
| LINE Push quota ณ incident verification | `300/300` (EXHAUSTED) |
| Employee flow with Push quota = 0 | PASS |
| Google Sheets sync | PASS |
| Sync jobs หลัง verification | `810 COMPLETED`, pending/processing = 0 |
| Lost event ใหม่ | 0 |
| Duplicate business record ที่ตรวจ | 0 |
| Issue #93 | CLOSED / completed |

Worker URL:

<https://malipang-backend-v5-2.eakkachai-dev.workers.dev>

### สิ่งที่ Production verification ล่าสุดพิสูจน์แล้ว

- Attendance valid image สามารถบันทึก Punch ได้ 1 ครั้งและตอบผลผ่าน LINE Reply API
- Attendance stale/invalid image ถูกปฏิเสธโดยไม่สร้าง Attendance และตอบสาเหตุผ่าน Reply API
- LINE Push quota หมดไม่ทำให้ employee interaction ปกติล่ม
- Notification failure ไม่ย้อนกลับไปประมวลผล Attendance ซ้ำ
- D1 และ Google Sheets reconcile ตรงกันใน flow ที่ทดสอบ
- Daily Payroll sync สำเร็จ
- ไม่มี duplicate Attendance / Payroll / Expense จาก incident #93

---

## 2. เป้าหมายของระบบ

MaliPang Backend V5.2 มีหน้าที่หลักดังนี้

1. รับ LINE webhook ของพนักงานและ Owner อย่างปลอดภัย
2. ตรวจรูปลงเวลาและหลักฐานร้าน
3. บันทึก Attendance แบบ idempotent
4. คำนวณ Daily Payroll และ Weekly Payroll
5. จัดการ Wage แบบ effective-dated
6. รองรับ Shift Schedule และ Owner Override พร้อม audit
7. รองรับ Expense text / receipt / bank slip / online order
8. เก็บหลักฐานรูปใน private R2
9. Sync ข้อมูลไป Google Sheets โดยไม่ให้ Sheets เป็น source of truth
10. มี retry, queue, failed jobs, DLQ, reconcile และ recovery path
11. ทำงานกับ LINE OA Free plan ได้โดยใช้ Reply API เป็นหลัก
12. รองรับ Production release / rollback แบบ exact SHA และมีหลักฐาน audit

---

## 3. Source of Truth และ Operating Model

### D1 = Operational Source of Truth

D1 เป็นแหล่งข้อมูลจริงสำหรับ V5.2 ได้แก่

- Employee
- Wage history
- Shift schedule
- Attendance
- Daily payroll
- Weekly payroll
- Expense
- Sync jobs
- Failed jobs
- Audit records

### Google Sheets = Reporting / Owner Interface

Google Sheets ใช้สำหรับ

- Owner ตรวจข้อมูล
- Staff config input บางส่วน
- Shift schedule input / mirror
- Attendance report
- Daily payroll report
- Weekly payroll report
- Wage history report
- Expense report
- System log / operational view

Google Sheets **ไม่ใช่ฐานข้อมูลหลัก** และ **ไม่ใช่ calculation engine หลัก** ของ V5.2

### R2 = Private Evidence Store

R2 ใช้เก็บหลักฐาน เช่น

- รูปลงเวลา
- รูปใบเสร็จ
- รูปสลิป
- หลักฐานที่ต้องใช้ตรวจย้อนหลัง

R2 ต้อง private เสมอ และห้ามลบ evidence โดยไม่มี retention policy / Owner-approved process

---

## 4. Architecture ภาพรวม

```text
Employee / Owner
      |
      v
LINE Official Account
      |
      | POST /webhook/line
      | X-Line-Signature verification
      v
Cloudflare Worker
      |
      +--> Cloudflare Queue: malipang-jobs
      |        |
      |        +--> LINE_EVENT
      |        +--> SHEETS_SYNC
      |        +--> LINE_NOTIFICATION fallback
      |
      +--> LINE content download
      |
      +--> Vision classification / extraction
      |        |
      |        +--> CLOCK
      |        +--> RECEIPT
      |        +--> BANK_SLIP
      |        +--> ONLINE_ORDER
      |        +--> UNKNOWN
      |
      +--> Attendance Durable Object
      |        |
      |        +--> serialize IN/OUT per employee/day
      |
      +--> D1
      |        |
      |        +--> Attendance
      |        +--> Payroll
      |        +--> Shift
      |        +--> Wage history
      |        +--> Expense
      |        +--> Sync / failed jobs / audit
      |
      +--> R2 private evidence
      |
      +--> LINE Reply API (primary employee response)
      |
      +--> LINE Push API (fallback / async only)
      |
      +--> Google Sheets Direct API
```

---

## 5. LINE OA Strategy — REPLY_FIRST_FREE_PLAN

### เหตุผล

LINE OA ของระบบนี้ใช้กับพนักงานเป็นหลัก และเป้าหมายคือ **ใช้ฟรีเป็นหลัก**

ดังนั้น Normal employee interaction ใช้ **Reply API** ก่อนเสมอเมื่อ event มี `replyToken` ที่ใช้งานได้

### Reply API ใช้กับ

- Attendance สำเร็จ
- Attendance rejection
- รูปเก่า / stale image
- GPS ไม่ผ่าน
- Timestamp ไม่ผ่าน
- อ่านหลักฐานไม่สำเร็จ
- Expense interaction ที่ตอบ event เดิมได้
- Postback interaction ที่ตอบ event เดิมได้

### Push API ใช้เฉพาะ

- ไม่มี valid `replyToken`
- Reply API ล้มเหลวและต้อง fallback
- notification ที่เกิดภายหลังแบบ asynchronous
- Owner/system alert ที่จำเป็น

### หลักการสำคัญ

```text
Business transaction != Notification delivery
```

Attendance commit และ LINE notification มี idempotency boundary แยกกัน

ถ้า Reply/Push ล้มเหลว:

- ห้ามสร้าง Attendance ใหม่
- ห้าม run Vision ใหม่โดยไม่จำเป็น
- ห้าม run Payroll ใหม่
- ห้ามสร้าง Sheets business record ซ้ำ
- ต้องมี failed/retry state ที่ตรวจสอบได้

### Push quota exhaustion

เมื่อ Push ถูกจำกัดเพราะ monthly quota:

- classify เป็น `LINE_PUSH_QUOTA_EXHAUSTED`
- แสดง `DEGRADED/EXHAUSTED`
- ไม่ retry ถี่แบบไม่มีโอกาสสำเร็จ
- **ไม่ทำให้ employee Reply flow ล่ม**
- `/admin/readiness` ยัง PASS ได้ถ้า LINE authentication และ Reply capability ใช้งานได้

---

## 6. Attendance

### 6.1 Official Time

เวลาที่ใช้เป็นเวลาทางการมาจาก **Timestamp + GPS overlay สีขาวบนรูปเท่านั้น**

ไม่ใช้:

- เวลา LINE message เป็นเวลาเข้างาน
- ตัวเลขเวลาบนหน้าปัดนาฬิการ้านเป็นเวลาค่าแรง
- weekday บนนาฬิกา

นาฬิการ้านใช้เป็น **หลักฐานว่าถ่ายที่ร้าน / shop clock evidence** เท่านั้น

### 6.2 หลักฐานที่รูปต้องมี

1. Timestamp สีขาว
2. วันที่
3. เวลา
4. Latitude / Longitude
5. ชื่อสถานที่หรือที่อยู่
6. นาฬิกาสีดำประจำร้านในภาพที่ AI ตรวจได้

### 6.3 Validation หลัก

- GPS เทียบ `ATTENDANCE_STORE_LAT/LNG`
- รัศมี `ATTENDANCE_ALLOWED_RADIUS_M`
- อายุรูป `ATTENDANCE_MAX_PHOTO_AGE_MIN`
- Timestamp confidence
- shop clock evidence confidence
- duplicate / redelivery protection

### 6.4 ค่า Production ปัจจุบัน

| Setting | Value |
|---|---|
| Store location | `13.89682 / 100.60830` |
| Allowed radius | `120 m` |
| Maximum photo age | `3 min` |
| Overlay min confidence | `0.90` |
| Clock min confidence | `0.70` |

### 6.5 Punch ordering

Durable Object ใช้ key ตามพนักงานและวัน เพื่อป้องกัน

- IN พร้อมกัน
- OUT พร้อมกัน
- redelivery
- race condition

ระบบต้องรักษา invariant ว่า Attendance business record ไม่ซ้ำจาก webhook retry

### 6.6 Attendance response

เมื่อผ่าน:

- บันทึก Attendance
- update Daily/Weekly Payroll ตามกติกา
- enqueue Sheets sync
- ตอบ LINE ผ่าน Reply API

เมื่อไม่ผ่าน:

- ไม่สร้าง Attendance
- ตอบสาเหตุผ่าน Reply API
- rejection notification failure ต้อง observable

### 6.7 ภาษา

Attendance success/rejection แสดง 3 ภาษา:

1. ไทย
2. English
3. မြန်မာ

ข้อความสำเร็จจะแสดงข้อมูลที่ตรวจจริง เช่น

- Photo timestamp
- GPS check: Passed
- Shop clock evidence: Passed
- late minutes ถ้ามี

---

## 7. Payroll

### 7.1 Payroll cycle ปัจจุบัน

```text
Thursday -> Wednesday
Pay date = Wednesday เดียวกับวันปิดรอบ
```

First real-money cycle ที่เตรียมไว้:

```text
Period Start : 2026-07-30
Period End   : 2026-08-05
Pay Date     : 2026-08-05
```

รอบ `2026-07-23..2026-07-29` เป็น historical/audit context ไม่ใช่ first real-money apply ของ release ปัจจุบัน

### 7.2 Wage baseline รอบแรก

พนักงานจริง 4 คนใช้ baseline:

- 500 THB/day
- effective from `2026-07-30`

ค่าแรงต้องมาจาก effective-dated wage history ไม่ควร hard-code ใน business logic

### 7.3 Payroll safety

- Missing punch ห้ามกลายเป็นยอดพร้อมจ่ายอัตโนมัติ
- Payroll Preview เป็น read-only calculation path
- Payroll Apply ต้อง idempotent
- Apply ต้องใช้ Run ID ที่ควบคุมได้
- Duplicate payroll run ต้องเป็น 0
- Weekly cycle key ใช้ Thursday period start

### 7.4 Payroll Apply

**Payroll Apply ไม่ควรถูกรันจากงานทั่วไปหรือ smoke test**

ต้องมี Owner approval สำหรับรอบเงินจริง และตรวจ:

- Attendance ครบ
- Missing Punch
- Owner overrides
- Wage snapshot
- Late / deduction
- OT ถ้ามี
- Pending Review = 0 หรือได้รับการอนุมัติอย่างชัดเจน
- D1 ↔ Sheets reconcile

---

## 8. Shift Schedule

### Default Production schedule ที่เตรียมไว้

ช่วง:

```text
2026-07-30 .. 2026-12-31
```

พนักงาน 4 คน

```text
155 days / employee
620 rows total
04:00 -> 16:00
status = EXPECTED
```

First payroll cycle:

```text
28 rows total
```

### Insert-only rule

Default generation และ Sheet import ต้อง insert-only

ห้าม overwrite Owner override ที่มีอยู่แล้ว

### Status ที่รองรับ

- `EXPECTED`
- `DAY_OFF`
- `CANCELLED`

### Owner Override

`POST /admin/shifts/override`

ใช้สำหรับเปลี่ยนพนักงาน 1 คน / 1 วัน พร้อม

- previous state
- new state
- actor
- reason
- timestamp
- append-only audit

---

## 9. Expense

รองรับทั้ง text และ image flow

### ประเภทหลัก

- ใบเสร็จซื้อของเข้าร้าน
- สลิปโอนเงิน / ชำระเงิน
- Online order
- Expense text

### Text flow

- Quick Save สำหรับคำที่อนุญาต
- Summary Flex ก่อน Save
- แก้ Payment / Source / Category / Date ได้
- Undo เปลี่ยนเป็น `CANCELLED`
- audit trail ต้องคงอยู่

### Bank Slip

รองรับ regression contract สำหรับ

- KBank / K+
- SCB
- เป๋าตัง / G-Wallet

Bank slip ที่ยืนยันแล้วใช้

```text
Payment = transfer
Source Wallet = SHOP_BANK
```

สลิปต้องตรวจ

- success status
- date/time
- reference
- sender/receiver
- paid amount
- duplicate reference / image hash

### WAITING_CONFIRM

สลิปที่อ่านครบจะสร้างรายการรอยืนยันก่อน

ห้ามเขียน finalized expense ลง Google Sheets ก่อน Save

### Daily sheet

ค่าใช้จ่ายที่ยืนยันแล้วเขียนลง `รายวัน` โดยไม่เขียนทับ formula columns ที่สงวนไว้

---

## 10. Vision

### Production provider

Primary production extraction:

```text
OpenAI model: gpt-4.1-mini
```

Workers AI ถูกปิดเป็นค่าเริ่มต้นหลัง baseline รูปจริงไม่ผ่านตามเกณฑ์ที่ต้องการ

### Classification

- `CLOCK`
- `RECEIPT`
- `BANK_SLIP`
- `ONLINE_ORDER`
- `UNKNOWN`

### Guard

`OPENAI_DAILY_FALLBACK_LIMIT=100`

Admin regression calls และ production employee calls ต้องสามารถแยก metric/count ได้

### Privacy

รูปจริงที่มี

- พิกัด
- เวลา
- ที่อยู่
- หลักฐานพนักงาน

ห้าม commit เข้า Git

---

## 11. Google Sheets Integration

Spreadsheet หลัก:

```text
MaliPang_OWNER_MASTER
```

### Input / Config sheets

- `HR_STAFF_CONFIG`
- `HR_SHIFT_SCHEDULE`

### Report / system sheets

- `HR_WAGE_HISTORY`
- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`
- `รายวัน`

### Important rule

`HR_WAGE_HISTORY` เป็น system/report output ไม่ใช่ sheet สำหรับแก้ baseline โดยตรง

ค่า Wage Effective Date ต้องมาจาก source config / controlled import path

### Sync architecture

ทุก sync job มี business identity และ version

ระบบเก็บ row mapping/index ใน D1 เพื่อ update แถวเดิมโดยไม่ scan ทั้ง sheet ทุกครั้ง

### Quota-safe write

หลัง production incident ที่ Google Sheets HTTP 429:

- จำกัด forced/default schedule writes ที่ 40 requests/minute
- exponential backoff
- jitter
- honor `Retry-After`
- persisted attempt count
- idempotent recovery

### Incident ที่เคยเกิด

Default schedule 620 แถวเคยปล่อย Sheets writes เร็วเกิน quota และเกิด `RESOURCE_EXHAUSTED`

หลัง fix:

- failed quota records recovered แบบ idempotent
- 620/620 reconcile ตรง
- missing = 0
- duplicate = 0

---

## 12. Reliability Model

ระบบยึดหลัก:

```text
Correctness > convenience
Auditability > hidden automation
Idempotency > blind retry
Rollback > destructive repair
```

### Queue / DLQ

Main queue:

```text
malipang-jobs
```

Dead-letter queue:

```text
malipang-jobs-dlq
```

### Retry

- bounded retry
- exponential backoff
- jitter
- provider-specific classification
- deterministic identity

### Failed jobs

failed jobs ต้องแยก

- transient failure
- permanent failure
- quota exhaustion
- DLQ max retry

ห้าม replay historical jobs แบบเหมารวม

### Reconcile

`/admin/reconcile-sheets`

ใช้ D1 เป็น source of truth แล้วสร้าง reporting sync ใหม่

Reconcile ห้ามสร้าง business transaction ใหม่

---

## 13. Issue #93 — Attendance ไม่มี LINE ตอบกลับ

### Incident

EMP_TEST ส่งรูปลงเวลาประมาณ `04:13` วันที่ 29 กรกฎาคม 2026

ผลจริง:

- Attendance `IN` ถูก commit 1 ครั้ง
- D1 ถูกต้อง
- Sheets sync สำเร็จ
- LINE Push confirmation ล้มเหลวด้วย 429

ส่งรูปเดิมอีกครั้งประมาณ `08:49`

- ถูก reject เป็น stale อย่างถูกต้อง
- ไม่สร้าง Attendance
- rejection Push ก็ล้มเหลวด้วย 429

### Root Cause

Attendance business processing และ LINE notification ไม่มี retry/idempotency boundary ที่แยกกันชัดเจน

### Phase 1 Fix

PR #94 เพิ่ม

- durable `LINE_NOTIFICATION`
- deterministic retry key
- bounded retry
- permanent failure visibility
- protection against re-running Attendance

แต่ Production smoke ยังล้มเพราะ LINE OA Free plan ใช้ Push quota `300/300`

### Final Fix

Production architecture เปลี่ยนเป็น:

```text
REPLY_FIRST_FREE_PLAN
```

Normal employee interaction ใช้ Reply API

Push เป็น fallback / async เท่านั้น

### Production verification

- valid Attendance: PASS
- stale/invalid rejection: PASS
- Push quota = exhausted: employee flow ยัง PASS
- lost = 0
- duplicate = 0
- D1 ↔ Sheets = PASS

Issue #93 ปิดแล้ว

---

## 14. Release / Version History ที่สำคัญ

ส่วนนี้บันทึก evolution ของ V5.2 ที่เกี่ยวกับ Production launch และ Payroll release

### PR #64 — Payroll Thursday–Wednesday

- เปลี่ยนรอบ Payroll เป็น Thu–Wed
- Pay Date = Period End (Wednesday)
- cycle key ปรับตาม Thursday start

### PR #84 / #85 — Release / runtime evidence hardening

- ปรับ workflow ให้เก็บ evidence ได้ดีขึ้น
- lock release behavior และ first payroll dates
- เพิ่ม safe release verification

### PR #87 — LINE retry boundary fix

- ลดปัญหา LINE 429 debt
- แยก behavior ของ retry ให้เหมาะกับ provider failure

### PR #88 — Weekly payroll sync key

- แก้ weekly sync ให้ใช้ Thursday cycle key ถูกต้อง

### PR #89 — First payroll baseline / Silent Shadow

- lock first real payroll `2026-07-30..2026-08-05`
- เตรียม 4 authorized employees
- Silent Shadow release path

### PR #90 — Shift schedule hardening

- default generation insert-only
- Owner override endpoint
- append-only shift audit
- migration `0010_shift_schedule_audit.sql`

### PR #91 — Production release config

- เตรียม Production cutover config
- alignment กับ release date / runtime

### PR #92 — Google Sheets quota-safe sync

- schedule writes ที่ 40/minute
- exponential backoff
- jitter
- Retry-After
- persisted attempt count

### PR #94 — Attendance notification isolation

- durable notification job
- LINE retry key
- notification retry ไม่ re-run Attendance

### PR #95 / Production SHA `8918ceb...` — Reply-first Free Plan

- employee response ใช้ Reply API เป็นหลัก
- Push quota exhaustion = degraded ไม่ใช่ backend outage
- recovery สำหรับ stranded notification outbox
- verified Production with Push quota exhausted

---

## 15. Migrations

Production release ใช้ migration chain แบบ additive

### 0007

Payroll / effective wage / shift / OT foundation

### 0008

Pay date / payroll run support

### 0009

Evidence management / retention metadata

### 0010

Shift schedule audit และ append-only protection

### Safety rule

Emergency rollback ไม่ drop tables/columns ของ additive migration

Rollback Worker version ก่อน แล้วทำ forward-fix ถ้าจำเป็น

---

## 16. Runtime Configuration

ค่าที่ตรวจเข้า Production config ปัจจุบัน:

| Setting | Value |
|---|---|
| `APP_ENV` | `production` |
| `RUNTIME_MODE` | `production` |
| `SHADOW_LINE_OUTPUT` | `false` |
| `ATTENDANCE_ENABLED` | `true` |
| `EXPENSE_ENABLED` | `true` |
| `SHEETS_SYNC_ENABLED` | `true` |
| `R2_EVIDENCE_ENABLED` | `true` |
| `EVIDENCE_RETENTION_ENABLED` | `false` |
| `LINE_LOADING_ENABLED` | `true` |
| `WORKERS_AI_ENABLED` | `false` |
| `OPENAI_FALLBACK_ENABLED` | `true` |
| `OPENAI_MODEL` | `gpt-4.1-mini` |
| `OPENAI_DAILY_FALLBACK_LIMIT` | `100` |
| `ATTENDANCE_ALLOWED_RADIUS_M` | `120` |
| `ATTENDANCE_MAX_PHOTO_AGE_MIN` | `3` |
| `SHEET_STAFF_CONFIG` | `HR_STAFF_CONFIG` |
| `SHEET_ATTENDANCE_RAW` | `V52_ATTENDANCE_RAW` |
| `SHEET_DAILY_PAYROLL` | `V52_DAILY_PAYROLL` |
| `SHEET_WEEKLY_PAYROLL` | `V52_WEEKLY_PAYROLL` |
| `SHEET_WAGE_HISTORY` | `HR_WAGE_HISTORY` |
| `SHEET_SHIFT_SCHEDULE` | `HR_SHIFT_SCHEDULE` |
| `SHEET_EXPENSE_RAW` | `V52_EXPENSE_RAW` |
| `SHEET_EXPENSE_DAILY` | `รายวัน` |
| `SHEET_SYSTEM_LOG` | `V52_SYSTEM_LOG` |

`SHADOW_LINE_OUTPUT=false` ปิด output เฉพาะเมื่อ runtime เป็น Shadow; ใน Production `RUNTIME_MODE=production` ระบบส่ง Reply/Push ตาม logic ปัจจุบัน

---

## 17. Secrets

ห้าม commit secret ลง Git

Secrets หลัก:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_OWNER_USER_ID`
- `ADMIN_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY_BASE64`
- `GOOGLE_SPREADSHEET_ID`
- `OPENAI_API_KEY`

ใช้ Cloudflare secret management เท่านั้น

```bash
npx wrangler secret put <NAME>
```

ห้ามแสดงค่าจริงใน README, Issue, PR, CI logs หรือ Chat

---

## 18. Admin Endpoints

ทุก `/admin/*` ต้องใช้ Admin authorization

### System

- `GET /admin/status`
- `GET /admin/readiness`
- `POST /admin/bootstrap-sheets`
- `POST /admin/retry-sync`
- `POST /admin/reconcile-sheets`

### Employee / Shift

- `POST /admin/import-employees-from-sheet`
- `POST /admin/import-employees`
- `POST /admin/import-shifts-from-sheet`
- `POST /admin/shifts/generate-defaults`
- `POST /admin/shifts/override`

### Attendance

- `POST /admin/attendance/correct`
- `POST /admin/attendance/notification-smoke`

> `notification-smoke` เป็น Push fallback smoke ไม่ใช่หลักฐาน Reply API; Reply path ต้องทดสอบด้วย inbound event จริงที่มี reply token

### Vision

- `POST /admin/vision/inspect`
- `POST /admin/vision/evaluate`
- `POST /admin/vision/evaluate-evidence`
- `GET /admin/evidence/<R2 key>`

### Expense

- `POST /admin/expense-access`
- `POST /admin/expense/evaluate`

### Payroll

มี Preview / Apply path ภายใต้ admin flow; Apply เป็น high-risk mutation และต้องทำตาม payroll release gate เท่านั้น

---

## 19. Health / Readiness semantics

### `/health`

ตรวจ basic runtime configuration

Production expected:

```text
ok = true
mode = production
```

### `/admin/readiness`

ตรวจ service dependency จริง เช่น

- D1
- LINE auth / reply capability
- Google Sheets
- R2
- Attendance config

LINE Push quota exhausted สามารถแสดง degraded ได้โดยไม่ทำให้ readiness ล้ม หาก normal employee Reply flow ยังทำงาน

Google Sheets timeout แบบ transient ต้องแยกจาก auth/schema failure จริง

---

## 20. Testing

ต้องใช้ Node.js 22+

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

### Automated validation ล่าสุดใน hotfix series

ชุดทดสอบหลัง notification architecture มี automated tests มากกว่า 160 tests โดย live fixture บางชุดถูก skip โดย default ตาม environment

ทุก PR ที่แก้ code ต้องผ่าน:

- typecheck
- unit/regression tests
- `npm run check`
- Wrangler dry-run
- `git diff --check`
- CI

### Live tests

Live tests ใช้เฉพาะ task ที่อนุญาต เพราะอาจกระทบ

- LINE quota
- Production data
- D1
- Sheets
- OpenAI usage

ห้ามใช้ real Attendance punch เป็น smoke test โดยไม่มี test identity / controlled plan

---

## 21. Deploy / Production Change

### Local validation

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

### Remote migration / deploy

```bash
npm run db:migrate:remote
npm run deploy
```

คำสั่ง remote เป็น Production mutation

ต้องมี:

- Production Change scope
- exact SHA
- CI PASS
- backup
- rollback version
- readiness
- UAT/smoke plan
- Owner authorization

Merge PR **ไม่เท่ากับ deploy approval** ตาม repository policy เว้นแต่งานนั้นมี Owner authorization ชัดเจนครอบคลุม release end-to-end

---

## 22. Backup / Rollback

ก่อน migration หรือ release สำคัญต้องสร้าง fresh D1 backup

Production launch backup ที่เคย verified:

```text
malipang-v5-2-before-b4277edfe-20260729-051421.sql.gz
SHA-256:
aa9bb5d11d1209e678440e4ffc228a53113c06ff4e6485873f9f5dac995ef2b5
```

ผ่าน:

- gzip integrity
- private R2 download checksum
- SQLite restore integrity

### Rollback principle

1. rollback Worker version
2. คง additive migrations
3. คง D1/R2/Audit data
4. ห้าม drop table/column ตอน incident
5. ตรวจ Health / Readiness / Queue / Lost / Duplicate / Sheets หลัง rollback
6. เปิด Bug Issue พร้อมหลักฐาน

---

## 23. Production Incidents / Lessons Learned

### Google Sheets quota burst

ปัญหา:

- schedule 620 rows สร้าง writes เร็วเกิน quota
- Google ตอบ 429 `RESOURCE_EXHAUSTED`

แก้:

- 40 writes/minute
- exponential backoff
- jitter
- Retry-After
- idempotent recovery

### LINE Push quota exhausted

ปัญหา:

- Free plan Push `300/300`
- Attendance transaction ถูกต้องแต่ผู้ใช้ไม่เห็น confirmation ใน architecture เดิม

แก้:

- Reply-first
- Push fallback only
- notification isolation
- `LINE_PUSH_QUOTA_EXHAUSTED`
- degraded readiness semantics

### Key lesson

ระบบ employee operation ต้องไม่ผูก business correctness กับ external notification quota

---

## 24. Legacy Apps Script

V5.2 ไม่ใช้ Apps Script เป็น core runtime

แต่ Legacy Apps Script อาจยังมี

- trigger
- deployment
- spreadsheet-bound script
- flow เดิมบางส่วน

จึงห้าม:

- ปิด trigger
- ลบ deployment
- ลบ legacy sheet
- เปลี่ยน LINE webhook เพื่อ shutdown legacy

จนกว่าจะผ่าน Legacy shutdown project และ Owner approval แยก

เป้าหมายคือให้ Legacy ลดบทบาทหลังพิสูจน์ Production parity และ payroll cycle จริง

---

## 25. Production Monitoring ที่ควรดูทุกวัน

หลังร้านปิดควรตรวจอย่างน้อย

- `/health`
- `/admin/readiness`
- Attendance วันนี้
- Missing Punch
- Queue pending/processing
- failed jobs ใหม่
- Push quota state
- Google Sheets sync
- lost event
- duplicate records
- D1 ↔ Sheets reconcile

สถานะที่ต้องการ:

```text
GREEN
```

ถ้ามีปัญหาให้รายงานเป็น

```text
ACTION REQUIRED
```

พร้อม employee/date/root cause ที่ Owner ต้องแก้

---

## 26. First Payroll Operational Checklist

สำหรับรอบ `2026-07-30..2026-08-05`

ก่อน Apply:

1. ตรวจ IN/OUT ทุกวัน
2. แก้ Missing Punch แบบ controlled correction
3. ตรวจ DAY_OFF / CANCELLED
4. ตรวจ Wage effective date
5. ตรวจ Late / deduction
6. ตรวจ OT ถ้ามี
7. Payroll Preview
8. ตรวจ 4 คนกับข้อมูลจริง
9. Pending Review = 0
10. D1 ↔ Sheets PASS
11. Owner approve
12. Payroll Apply ด้วย unique Run ID
13. ตรวจ Weekly Payroll หลัง Apply
14. ตรวจ duplicate payroll run = 0

---

## 27. Cost Philosophy

ระบบออกแบบให้ต้นทุนต่ำและใช้ Free tier เมื่อเหมาะสม

### LINE OA

ใช้ Free plan เป็นหลัก

- Reply-first สำหรับ employee interaction
- Push สงวนไว้สำหรับ fallback / async

### Cloudflare

ต้นทุนขึ้นกับ usage ของ

- Workers
- D1
- R2
- Queue

ต้อง monitor usage แต่ architecture ไม่ควรสร้าง unnecessary retry หรือ writes

### OpenAI

Vision มี usage cost ตามจำนวน request

Production guard ช่วยจำกัดจำนวน fallback call ต่อวัน

### Google Sheets

ไม่มี message cost แบบ LINE แต่มี quota/rate limit จึงต้องใช้ batching/pacing/retry ที่เหมาะสม

---

## 28. Repository Safety Rules สรุป

ห้าม:

- commit secrets
- deploy Production โดยไม่มี authorization
- remote D1 migration แบบไม่มี backup/gate
- delete Production D1 data
- delete R2 evidence
- weaken LINE signature verification
- bypass admin authorization
- ปิด idempotency
- ลบ audit trail
- เปลี่ยน payroll rule แบบเงียบ
- overwrite Sheets formulas
- ปิด Legacy Apps Script โดยไม่มี project/gate แยก
- เปลี่ยน LINE webhook โดยไม่มี cutover plan

---

## 29. เอกสารเพิ่มเติม

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
- [Fast-track UAT 23 กรกฎาคม 2026](docs/13_FAST_TRACK_UAT_2026-07-23.md)

---

## 30. Current Definition of Success

ระบบถือว่าทำงานถูกต้องเมื่อ:

- พนักงานส่งรูปแล้วได้รับผลผ่าน Reply API
- Push quota หมดแล้วยังลงเวลาได้
- Official Time มาจาก Timestamp + GPS overlay
- Attendance ไม่ซ้ำ
- Payroll snapshot ไม่ซ้ำ
- Expense ไม่ finalize ก่อน confirm
- D1 เป็น source of truth
- Sheets sync กลับมาสร้างใหม่จาก D1 ได้
- Lost event = 0
- Duplicate business record = 0
- Health / Readiness มีความหมายต่อ operations จริง
- Owner ตรวจข้อมูลได้จาก Sheets/ระบบหลังบ้าน
- Production rollback ทำได้โดยไม่ทำลายข้อมูล
- Legacy Apps Script สามารถลดบทบาทได้ทีละขั้นหลัง parity ผ่าน

---

## 31. สถานะปัจจุบันแบบสั้น

```text
MaliPang Backend V5.2
STATUS: PRODUCTION
LINE: REPLY_FIRST_FREE_PLAN
ATTENDANCE: LIVE
PAYROLL: LIVE / first real cycle 2026-07-30..2026-08-05
EXPENSE: LIVE
D1: SOURCE OF TRUTH
GOOGLE SHEETS: REPORTING + CONTROLLED INPUT
R2: PRIVATE EVIDENCE
PUSH QUOTA: NON-CRITICAL TO NORMAL EMPLOYEE FLOW
LOST: 0 at latest production verification
DUPLICATE: 0 at latest production verification
LEGACY APPS SCRIPT: NOT CORE, NOT YET RETIRED
```
