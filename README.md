# MaliPang Backend V5.2 Solo — Production

Backend กลางของร้าน **มะลิปัง (MaliPang)** สำหรับรับข้อมูลจาก LINE OA, ประมวลผล Attendance / Payroll / Expense บน Cloudflare, เก็บข้อมูลจริงใน D1, เก็บหลักฐานใน R2 และ Sync รายงานไป Google Sheets โดยตรง

ระบบออกแบบให้ใช้งานจริงในร้านได้ด้วยทีมเล็กและดูแลได้โดยนักพัฒนาคนเดียว โดยให้ความสำคัญกับ **ความถูกต้อง, auditability, idempotency, rollback และต้นทุนต่ำ** มากกว่าการทำระบบที่ซับซ้อนเกินจำเป็น

> **Production status:** ระบบ V5.2 เปิดใช้งาน Production แล้วเมื่อ 29 กรกฎาคม 2026
>
> **Core runtime:** Cloudflare Workers + D1 + Durable Objects + Queues/DLQ + R2 + LINE Messaging API + Google Sheets API + OpenAI Vision
>
> **Legacy Apps Script:** ไม่ใช่ core runtime ของ V5.2 แต่ยังถือเป็น external legacy dependency จนกว่าจะผ่าน parity / shutdown gate แยก ห้ามปิด Trigger, Deployment หรือลบ Legacy sheets จากงาน V5.2 โดยพลการ

> **V1.1 Identity & Access:** เพิ่ม role/branch scope, LINE HR registration และ Owner approval โดย D1 เป็นแหล่งสิทธิ์หลัก; Issue #100 ทำ canonical owner migration แบบ atomic ที่รักษาตัวตนเดิมและประวัติทั้งหมด

> **Canonical staff IDs:** `OWN001 = Eak`, `OWN002 = Nea`, `EMP001 = Win`, `EMP002 = Tualek`, `EMP003 = Laws non`. สิทธิ์มาจาก role/scope/status และ LINE binding ที่ยืนยันแล้ว ไม่ใช่ prefix ของ Staff ID

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
- Owner DLQ alert เมื่อ job เข้าสู่ Dead Letter Queue เพื่อให้ผู้ดูแลรับรู้เหตุผิดปกติของ Production

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

### 6.5 IN / OUT

Durable Object ใช้ serialize Punch ต่อพนักงาน/วัน เพื่อป้องกัน IN/OUT ชนกัน

หลักการ:

- Punch แรกของวัน = IN
- Punch ถัดไป = OUT / COMPLETE ตาม state ปัจจุบัน
- Duplicate webhook หรือ Message ID ซ้ำต้องไม่สร้าง Attendance ซ้ำ
- Missing punch ต้องไม่กลายเป็น payroll พร้อมจ่ายอัตโนมัติ

### 6.6 LINE message

Attendance success/rejection ใช้ 3 ภาษา:

1. ไทย
2. English
3. မြန်မာ

Success message ระบุข้อมูลที่ตรวจจริง เช่น

- Photo timestamp
- GPS check: Passed
- Shop clock evidence: Passed
- Late / Early leave ตามผลคำนวณ

---

## 7. Payroll

### 7.1 รอบ Payroll ปัจจุบัน

รอบมาตรฐาน:

```text
Thursday -> Wednesday
Pay date = Wednesday (Period End)
```

First real payroll cycle:

```text
2026-07-30 -> 2026-08-05
Pay date: 2026-08-05
```

### 7.2 Baseline ค่าแรง

พนักงานจริงที่ authorize ใน release baseline:

- Eak
- Win
- Tualek
- Laws non

Baseline:

```text
500 THB / day
Effective from: 2026-07-30
```

ค่า effective date นี้คือ controlled system baseline สำหรับรอบจริง ไม่ได้อ้างว่าเป็นอัตราในอดีตทั้งหมด

### 7.3 Daily Payroll

Worker คำนวณจาก Attendance + Shift + Wage snapshot

รองรับ:

- Work day
- Late
- Early leave
- Missing punch
- OT request / approved OT ตาม config
- Review state

### 7.4 Weekly Payroll

Weekly cycle key ใช้ Thursday start

ตัวอย่าง:

```text
2026-07-30..2026-08-05
```

Google Sheets ใช้ `V52_WEEKLY_PAYROLL`

Legacy weekly tab เดิมต้องเก็บไว้ ไม่ overwrite

### 7.5 Payroll Apply

Payroll Preview สามารถรันก่อนเพื่อดูผล

Payroll Apply เป็น **high-risk business mutation**

ห้าม Apply อัตโนมัติก่อน Owner ตรวจ:

- Attendance ครบ
- Missing Punch = 0 หรือได้รับการตัดสิน
- Wage snapshot ถูกต้อง
- Shift / Day off ถูกต้อง
- Net pay ถูกต้อง
- D1 ↔ Sheets reconcile ผ่าน

First payroll Apply ตั้งเป้าที่ 5 สิงหาคม 2026

---

## 8. Shift Schedule

### 8.1 Default schedule baseline

ช่วง release baseline:

```text
2026-07-30 -> 2026-12-31
```

พนักงาน 4 คน

Default:

```text
EXPECTED
04:00-16:00
```

รวม:

```text
155 วัน / คน
620 rows
```

First payroll cycle:

```text
28 rows
```

### 8.2 Insert-only

Generate/import default shift ต้อง insert-only

Existing Owner override ห้ามถูก overwrite

### 8.3 Owner override

`POST /admin/shifts/override`

รองรับสถานะ:

- `EXPECTED`
- `DAY_OFF`
- `CANCELLED`

ต้องระบุ actor + reason และสร้าง audit

### 8.4 Shift Audit

Migration 0010 เพิ่ม append-only audit

ห้าม update/delete audit history โดยพลการ

---

## 9. Expense

รองรับ:

- Expense text
- Receipt
- Bank slip
- Online order
- Flex confirmation
- Undo

### Text flow

Quick save รองรับคำสำคัญ เช่น

- `ทอน`
- `change`
- `โอน`

รายการทั่วไปแสดง Summary Flex ให้ตรวจแก้ก่อน Save

### Bank Slip

รองรับ:

- KBank / K+
- SCB
- เป๋าตัง / G-Wallet

ตรวจ:

- Success state
- Date/time
- Reference
- Sender / receiver
- Final paid amount

รายการที่ผ่าน validation จะอยู่ `WAITING_CONFIRM` ก่อน

ยังไม่เขียน Google Sheets จนกดยืนยัน

### Payment / Source Wallet

Bank transfer:

```text
Payment = transfer
Source wallet = SHOP_BANK
```

ในชีท `รายวัน` แสดงเป็น `บัญชีร้าน`

### Duplicate protection

ตรวจทั้ง:

- reference number
- image hash

Undo เปลี่ยนเป็น `CANCELLED`

audit trail ต้องคงอยู่

---

## 10. Vision

Primary provider:

```text
OpenAI gpt-4.1-mini
```

Workers AI ปิดไว้เพราะ baseline รูปจริงให้ผลไม่เสถียร

Production daily guard:

```text
100 calls/day
```

Classification:

- `CLOCK`
- `RECEIPT`
- `BANK_SLIP`
- `ONLINE_ORDER`
- `UNKNOWN`

Admin regression test แยก counter จาก Production employee flow

ห้าม commit รูปจริงที่มีข้อมูลเวลา/ที่อยู่/GPS ลง Git

---

## 11. Google Sheets

Spreadsheet หลัก:

```text
MaliPang_OWNER_MASTER
```

### Input / Config Sheets

- `HR_STAFF_CONFIG`
- `HR_SHIFT_SCHEDULE`

`HR_STAFF_CONFIG` รองรับ `Role` และ `Branch_ID` แบบ optional; `LINE_User_ID` ไม่จำเป็นสำหรับพนักงานใหม่ เพราะ LINE identity ที่ปลอดภัยต้องเชื่อมผ่านการส่ง `HR` และ Owner อนุมัติ

### V5.2 Reporting Sheets

- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `HR_WAGE_HISTORY`
- `HR_SHIFT_SCHEDULE`
- `HR_OT_REQUESTS`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`
- `รายวัน`

### Source of truth rule

Google Sheets เป็น mirror/reporting

D1 เป็น source of truth

ถ้า Sheets sync มีปัญหา ห้ามแก้ด้วยการสร้าง business transaction ใหม่

### Row mapping

ระบบเก็บ row index ใน D1 เพื่ออัปเดตแถวเดิมโดยไม่ search ทั้งชีททุกครั้ง

### Formula safety

ห้าม overwrite สูตรนอก writable cells

ใน `รายวัน` ห้ามแก้สูตรใน column ที่ระบบเดิมใช้คำนวณ

---

## 12. Google Sheets Quota และ Sync Reliability

Production launch พบ quota incident จาก Shift 620 rows

Google Sheets ตอบ:

```text
HTTP 429 RESOURCE_EXHAUSTED
```

ระบบปรับให้:

- pacing ประมาณ 40 writes/minute
- exponential backoff
- jitter
- honor `Retry-After`
- persisted attempt state
- idempotent recovery

Recovery incident:

```text
400 quota-related sync records recovered
failed = 0
remaining = 0
```

Final Shift reconcile:

```text
D1:    620
Sheets:620
155 per employee
first cycle: 28
UAT: 0
missing: 0
duplicate: 0
```

### หลักการ

```text
D1 correctness > Sheets availability
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

Eak (ขณะนั้นยังใช้รหัสประวัติ `EMP_TEST`) ส่งรูปลงเวลาประมาณ `04:13` วันที่ 29 กรกฎาคม 2026

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
- Push exhaustion = degraded
- transaction / notification boundary แยกกัน

### Google Sheets transient timeout

ระหว่าง release #93 readiness เคย timeout 15 วินาทีหลายครั้ง แต่ subsequent readiness/direct Sheets check ผ่าน

บทเรียน:

- transient timeout != auth/config failure
- ห้าม weaken readiness เป็น PASS แบบบังคับ
- ต้องตรวจ service จริงซ้ำแบบ bounded ก่อนแก้โค้ด

---

## 24. Production Monitoring

สิ่งที่ควรตรวจทุกวัน:

### Core

- `/health`
- `/admin/readiness`

### Attendance

- IN/OUT ของวันนี้
- Missing Punch
- Validation rejection ที่ผิดปกติ

### Queue

- pending
- processing
- new failed jobs
- DLQ

### Data quality

- Lost = 0
- Duplicate = 0
- D1 ↔ Sheets reconcile

### LINE

- Reply capability
- Push quota status
- new notification failures

### Vision / Cost

- OpenAI call volume
- fallback limit
- abnormal classification rate

Owner alert ที่ไม่เร่งด่วนควรไป Board/log เมื่อทำได้ เพื่อสงวน Push quota ฟรีไว้กับเหตุการณ์สำคัญ

---

## 25. First Payroll Cycle Checklist

รอบ:

```text
2026-07-30 -> 2026-08-05
Pay date: 2026-08-05
```

ก่อน Apply:

1. ตรวจ Shift 28 rows ใน first cycle
2. ตรวจ Attendance ทั้ง 4 คน
3. Missing Punch / Review ต้องถูกตัดสิน
4. Wage effective 2026-07-30 = 500 THB/day ตาม baseline
5. ตรวจ Late / Early leave / OT
6. รัน Payroll Preview
7. ตรวจยอดต่อคน
8. ตรวจ D1 ↔ `V52_WEEKLY_PAYROLL`
9. ตรวจ duplicate payroll run = 0
10. Owner อนุมัติ
11. ค่อย Payroll Apply
12. หลัง Apply reconcile ซ้ำ

Payroll Apply รอบแรกเป็น Owner gate ไม่ควร auto-apply ตามเวลา

---

## 26. Legacy Apps Script

V5.2 Production live แล้วไม่ได้แปลว่า Legacy ปิดได้ทันที

Legacy ยังถือเป็น external dependency จนกว่าจะผ่าน:

1. inventory
2. backup
3. parity
4. 7-day observation ตามแผน
5. Stage-1 shutdown approval
6. final retirement approval

ห้าม:

- disable trigger
- ลบ deployment
- แก้ webhook
- ลบ legacy sheets

จากงาน V5.2 ปกติ

---

## 27. ต้นทุนและแนวทาง Free-plan-first

เป้าหมายของระบบร้านคือ **ต้นทุนต่ำ แต่ reliability สูง**

### LINE OA

Normal employee event ใช้ Reply API เป็นหลัก

ดังนั้นระบบไม่จำเป็นต้องอัป LINE OA plan เพียงเพื่อให้ Attendance ตอบพนักงาน

Push ฟรีที่มีจำกัดควรสงวนสำหรับ:

- fallback
- async notification
- incident alert ที่สำคัญ

### Cloudflare

ใช้ Workers / D1 / R2 / Queue ตาม usage และเฝ้าดู quota

### Vision

OpenAI Vision มี usage cost

ลดค่าใช้จ่ายด้วย:

- ไม่ re-run Vision เมื่อ notification ล้มเหลว
- admin regression counter แยกจาก Production employee counter
- daily guard
- ใช้ deterministic recovery

### Sheets

Google Sheets API ไม่ใช่ transactional DB

ต้อง pace write และใช้ D1 เป็น source of truth เสมอ

---

## 28. Security / Invariants

ห้ามเปลี่ยนโดยไม่มี requirement + Owner approval:

- LINE signature verification
- Admin auth
- Attendance official-time rule
- GPS/photo-age validation
- Duplicate protection
- Audit trail
- Payroll cycle/rules
- Formula safety ใน Sheets
- R2 private evidence

Never:

- commit secrets
- log credentials
- delete Production D1
- delete R2 evidence
- weaken idempotency
- overwrite Sheets formulas
- deploy Production จาก branch ที่ไม่ใช่ approved exact SHA

---

## 29. Development Workflow

ก่อนแก้ code อ่าน:

- `README.md`
- `AGENTS.md`
- docs 01–10 ที่เกี่ยวข้อง

หลังแก้ code:

```bash
npm run check
npx wrangler deploy --dry-run
```

Git workflow:

- 1 task / branch
- 1 task / PR
- focused/reversible change
- ไม่ push main โดยตรง
- merge ≠ deploy

Production release ต้องมี explicit authorization

---

## 30. เอกสารเพิ่มเติม

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
- [V1.1 Identity, Roles, Branch และ HR registration](docs/19_V11_IDENTITY_ACCESS_TH.md)

---

## 31. Current Production Summary

```text
System: MaliPang Backend V5.2
Status: PRODUCTION
Runtime: Cloudflare Workers
Database: D1
Evidence: R2 private
Reporting: Google Sheets Direct API
LINE: REPLY_FIRST_FREE_PLAN
Vision: OpenAI gpt-4.1-mini
Payroll: Thursday-Wednesday
First real cycle: 2026-07-30..2026-08-05
Production source at last verification:
8918ceb6cd8841c1619fbc30f66532188ba6007e
```

ระบบ Production ปัจจุบันถูกออกแบบให้ **ธุรกรรมร้านไม่ผูกกับ notification delivery**, **D1 ไม่ผูกกับ availability ของ Google Sheets**, และ **Employee LINE flow ไม่ผูกกับ Push quota รายเดือน** ซึ่งเป็นหลักสำคัญเพื่อให้ร้านใช้งานจริงได้ต่อเนื่องด้วยต้นทุนต่ำและสามารถกู้คืนได้โดยไม่สร้างข้อมูลซ้ำ
