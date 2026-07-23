# Architecture และ Operating Model — MaliPang Backend V5.2

อัปเดต: 23 กรกฎาคม 2026

## 1. จุดประสงค์ของระบบ

ระบบนี้มีหน้าที่รับข้อมูลจาก LINE OA ของร้านมะลิปัง แล้วประมวลผลข้อมูลที่เกี่ยวข้องกับ:

- ลงเวลาเข้างานและออกงาน
- ค่าแรงรายวันและรายสัปดาห์
- ค่าใช้จ่ายแบบข้อความ
- สลิปธนาคารและวอลเล็ต
- หลักฐานใบเสร็จหรือเอกสารซื้อของ
- การรายงานผลไป Google Sheets
- การตรวจย้อนหลัง แก้ไข และกู้คืนข้อมูล

เป้าหมายหลักไม่ใช่เพียงให้ระบบตอบ LINE ได้ แต่ต้องทำให้ข้อมูลเงิน เวลา และหลักฐานของร้าน:

1. ไม่สูญหาย
2. ไม่บันทึกซ้ำ
3. ตรวจย้อนหลังได้
4. แก้ไขอย่างมี audit trail
5. ดูแลได้โดยเจ้าของหรือนักพัฒนาเพียงคนเดียว
6. มีต้นทุนคงที่ต่ำและไม่ผูกกับบริการจำนวนมากเกินจำเป็น

## 2. หลักการออกแบบ

### 2.1 D1 เป็น Source of Truth

ข้อมูลธุรกรรมจริงอยู่ใน D1 ส่วน Google Sheets เป็นหน้ารายงานและหน้าตั้งค่าบางส่วน

ห้ามออกแบบให้:

- สูตรใน Google Sheets เป็นตัวตัดสินธุรกรรมหลัก
- Apps Script เป็นตัวคำนวณหลักของ V5.2
- การเขียน Sheets สำเร็จเป็นเงื่อนไขเดียวที่ถือว่ารับข้อมูลสำเร็จ

### 2.2 ทุกเหตุการณ์ต้อง Idempotent

LINE อาจส่งเหตุการณ์เดิมซ้ำ ระบบต้องใช้ Message ID, Webhook Event ID, transaction reference หรือ image hash เพื่อป้องกันรายการซ้ำ

### 2.3 หลักฐานต้องแยกจากข้อมูลรายงาน

- D1 เก็บข้อมูลธุรกรรมและ audit metadata
- R2 เก็บรูปหลักฐานแบบ private
- Google Sheets แสดงข้อมูลที่เจ้าของร้านต้องตรวจหรือใช้งาน

### 2.4 ความถูกต้องมาก่อนความเร็ว

การตอบเร็วมีความสำคัญ แต่ห้ามลด validation ที่ป้องกัน:

- เวลาเข้างานผิด
- พิกัดผิด
- สลิปซ้ำ
- ยอดเงินผิด
- ค่าแรงซ้ำ
- การเขียนทับสูตรบัญชี

## 3. Architecture หลัก

```text
LINE OA
  |
  | POST /webhook/line
  | ตรวจ X-Line-Signature
  v
Cloudflare Worker — Ingress
  |
  | ตรวจ idempotency และสร้างงาน
  v
Cloudflare Queue: malipang-jobs
  |
  +-----------------------------+
  |                             |
  v                             v
Attendance / Vision          Expense / Vision
  |                             |
  v                             v
Durable Object              Validation + Confirmation
จัดลำดับ IN/OUT                WAITING_CONFIRM / CONFIRMED
  |                             |
  +-------------+---------------+
                v
               D1
        Operational Source of Truth
                |
       +--------+---------+
       |                  |
       v                  v
      R2             Sheets Sync Queue
Private Evidence          |
                          v
                  Google Sheets Direct API
                          |
                          v
                  LINE Result / Owner Report
```

## 4. หน้าที่ของแต่ละส่วน

### 4.1 LINE Webhook Ingress

รับผิดชอบ:

- ตรวจลายเซ็น LINE จาก raw request body
- ปฏิเสธ request ที่ไม่ถูกต้อง
- ป้องกัน redelivery และ Message ID ซ้ำ
- แยก message type เบื้องต้น
- สร้างงานลง Queue โดยไม่ทำงานหนักใน request เดียว

ห้าม:

- ประมวลผลรูปทั้งหมดภายใน webhook request
- เขียนข้อมูลสำคัญโดยไม่มี idempotency key
- ส่งข้อความสำเร็จก่อนมีหลักฐานว่างานถูกบันทึกแล้ว

### 4.2 Queue และ DLQ

Queue ใช้แยกการรับ LINE ออกจากงานที่ใช้เวลา เช่น ดาวน์โหลดรูป อ่านภาพ เขียน Sheets และส่งผลกลับ

ต้องมี:

- retry
- dead-letter queue
- failed-job visibility
- stale-job recovery
- reconcile/backfill

### 4.3 Durable Object

ใช้จัดลำดับเหตุการณ์ Attendance ต่อพนักงานต่อวัน เพื่อป้องกัน IN/OUT ที่เข้าพร้อมกันหรือสลับลำดับ

กฎสำคัญ:

- เหตุการณ์เดียวกันห้ามสร้าง punch ซ้ำ
- Missing punch ห้ามกลายเป็นยอดพร้อมจ่ายอัตโนมัติ
- การแก้ไขโดย Admin ต้องมี audit trail

### 4.4 D1

D1 เก็บ:

- LINE event และ idempotency keys
- Attendance events
- Daily/weekly payroll snapshots
- Expense cases และสถานะ
- Sheets sync jobs
- Metrics และ failed jobs
- Admin corrections
- Audit fields

การเปลี่ยน Schema ต้องมี migration และ rollback/forward-fix plan

### 4.5 R2

R2 เก็บหลักฐานภาพแบบ private เช่น:

- รูปลงเวลา
- สลิปธนาคาร
- รูปใบเสร็จ

ห้าม:

- เปิด bucket เป็น public
- ใส่ URL ถาวรแบบ public ลง Sheets
- ลบหลักฐานโดยไม่มี retention policy และ owner approval

### 4.6 Vision

Vision ปัจจุบันใช้ OpenAI structured extraction เป็นหลัก

ทุกผลลัพธ์ต้องผ่าน deterministic validation ใน TypeScript อีกชั้น ไม่ใช้ผล AI เป็นคำตัดสินสุดท้ายเพียงอย่างเดียว

ตัวอย่าง validation:

- Timestamp และ GPS ครบ
- พิกัดอยู่ในรัศมี
- ภาพไม่เก่าเกินกำหนด
- ยอดก่อนส่วนลด - ส่วนลด = ยอดจ่ายจริง
- สถานะสลิปสำเร็จ
- เลขอ้างอิงไม่ซ้ำ

### 4.7 Google Sheets

Google Sheets ใช้เพื่อ:

- ตั้งค่าพนักงานและสิทธิ์บางส่วน
- ดู Attendance, Payroll และ Expense
- ใช้รายงานและกระทบยอด
- รองรับรูปแบบบัญชีเดิมของร้าน

ห้ามเขียนทับคอลัมน์สูตรที่เอกสาร mapping ระบุว่าต้องรักษาไว้

## 5. Flow สำคัญ

### 5.1 Attendance

```text
รับรูป
-> ตรวจ LINE signature/idempotency
-> เก็บหลักฐาน R2
-> อ่าน Timestamp + GPS overlay
-> ยืนยันนาฬิการ้านเป็นหลักฐานสถานที่
-> ตรวจ radius และ photo age
-> Durable Object จัด IN/OUT
-> D1 บันทึก Attendance
-> คำนวณ Payroll snapshot
-> สร้าง Sheets sync job
-> ตอบ LINE
```

Official Time ใช้ Timestamp สีขาวบนภาพเท่านั้น นาฬิกาประจำร้านเป็นหลักฐานประกอบ ไม่ใช่แหล่งเวลาค่าแรง

### 5.2 Expense แบบข้อความ

```text
รับข้อความ
-> parse รายการ/จำนวน/วิธีจ่าย
-> ถ้าเป็น Quick Save ที่กติกาชัดเจน ให้บันทึกตาม flow
-> รายการอื่นสร้าง WAITING_CONFIRM
-> ผู้ใช้แก้วันที่/หมวด/วิธีจ่าย/แหล่งเงิน
-> Save
-> D1 CONFIRMED
-> สร้าง Sheets sync job
-> เขียน V52_EXPENSE_RAW และรายวัน
```

### 5.3 Bank Slip

```text
รับรูป
-> เก็บ R2
-> จำแนก BANK_SLIP
-> อ่านธนาคาร วันที่ เวลา เลขอ้างอิง คู่รายการ และยอด
-> deterministic validation
-> duplicate check ด้วย reference + image hash
-> WAITING_CONFIRM
-> ผู้ใช้กด Save
-> D1 CONFIRMED
-> Google Sheets sync
```

สลิปธนาคารล็อก Payment เป็น transfer และ Source Wallet เป็น SHOP_BANK

### 5.4 Reconcile

หาก D1 ถูกต้องแต่แถว Google Sheets หาย:

- ห้ามสร้างธุรกรรมใหม่
- ใช้ reconcile/backfill สร้าง Sheets sync job จาก D1
- ตรวจ row mapping และสูตรหลัง sync

## 6. Environment Model

### 6.1 Local/Test

ใช้สำหรับ:

- typecheck
- unit/regression test
- local D1 migration
- dry-run deployment

ห้ามใช้ Production secrets ใน test fixture

### 6.2 Shadow/UAT

ลักษณะ:

- Worker เชื่อมบริการจริง
- ใช้ข้อมูลจริงเฉพาะผู้ได้รับสิทธิ์
- มี LINE output เฉพาะที่ตั้งใจทดสอบ
- ตรวจ D1/R2/Sheets เทียบกันทุกวัน
- Apps Script เดิมยังไม่ถูกลบจนกว่าจะผ่าน cutover gate

### 6.3 Production

เปิดได้เมื่อผ่าน Release Gate เท่านั้น และต้องมี rollback path ก่อนเปลี่ยนค่า

## 7. Reliability Targets

เกณฑ์ขั้นต่ำก่อน Production:

- Lost LINE event = 0
- Duplicate attendance = 0
- Duplicate payroll = 0
- Duplicate finalized expense = 0
- Attendance accuracy จากชุดรูปจริงอย่างน้อย 99%
- Google Sheets reconcile ผ่าน
- Failed jobs ที่ค้างโดยไม่มีเจ้าของ = 0
- ไม่มี Secret ใน GitHub

เป้าหมายเวลาตอบ LINE ให้เก็บเป็น metrics และปรับจากข้อมูลจริง ไม่ลด validation เพื่อไล่ตัวเลข latency

## 8. Security Model

- LINE webhook ต้องตรวจ signature ทุกครั้ง
- `/admin/*` ใช้ Bearer token
- ADMIN_TOKEN ต้องมีความยาวและ entropy เพียงพอ
- Secrets เก็บใน Cloudflare Secret เท่านั้น
- Google Service Account ให้สิทธิ์เฉพาะ Spreadsheet ที่ต้องใช้
- R2 เป็น private
- Log ต้องไม่พิมพ์ token, private key หรือ raw secret
- รูปและข้อมูลพนักงานต้องมี retention policy

## 9. Development Operating Model

### เจ้าของร้าน

- กำหนดกติกาธุรกิจ
- ยืนยันค่าแรง ตารางงาน และวิธีบัญชี
- อนุมัติ UAT และ Production
- ไม่ต้องแก้โค้ดเอง

### ChatGPT / System Architect / Reviewer

- แปลงปัญหาหน้างานเป็น Requirement
- ตรวจผลกระทบ Attendance, Payroll, Expense และ Sheets
- สร้าง Acceptance Criteria
- ตรวจ Pull Request และ Risk
- เตรียม UAT และ Release Checklist

### Codex / Implementer

- อ่าน `AGENTS.md` และเอกสารที่กำหนด
- แก้โค้ดใน Branch แยก
- เพิ่ม Test
- รัน Validation
- เปิด Pull Request
- ไม่ Merge หรือ Deploy Production เอง

### GitHub Actions / Automated Gate

- `npm ci`
- `npm run check`
- `npx wrangler deploy --dry-run`

### Owner Approval Gate

เจ้าของร้านเป็นผู้อนุมัติการเปลี่ยน:

- payroll rule
- attendance rule
- accounting mapping
- D1 migration remote
- production secrets/config
- LINE webhook
- deployment production
- Apps Script trigger/deployment

## 10. Change Classification

### Low Risk

- เอกสาร
- test ที่ไม่เปลี่ยน runtime
- copy หรือ UI text ที่ไม่เปลี่ยน business rule

### Medium Risk

- parser
- Flex Message
- Google Sheets mapping ภายในขอบเขตเดิม
- metrics และ admin visibility

### High Risk

- payroll calculation
- IN/OUT sequencing
- idempotency
- D1 migration
- LINE webhook
- Google Sheets formula columns
- R2 lifecycle
- authentication/authorization
- production deployment

High Risk ต้องมี manual UAT และ rollback plan เสมอ

## 11. Legacy Apps Script Boundary

Apps Script เดิมถือเป็น external legacy dependency ระหว่าง migration

กฎ:

- ไม่เพิ่ม dependency ใหม่ไป Apps Script
- ไม่ให้ Codex แก้ source เดิมโดยไม่มีงานเฉพาะ
- ไม่ปิด Trigger หรือ Deployment โดยเดา
- ไม่ลบ Legacy sheets
- ตรวจ LINE webhook ให้มี runtime หลักเพียงตัวเดียว
- Backup source และข้อมูลก่อน decommission

รายละเอียดดู `docs/06_LEGACY_APPS_SCRIPT_STATUS_TH.md`

## 12. Cost Control

ควรติดตามอย่างน้อย:

- OpenAI calls ต่อวัน แยก Production/Admin test
- Queue retries และ DLQ
- R2 storage และ lifecycle
- D1 reads/writes
- Worker duration
- Google Sheets API errors/retries

ห้ามลดต้นทุนด้วยการปิด validation สำคัญ ให้ลดด้วย cache, guard, deduplication, fixture test และการจำกัด admin test calls

## 13. Definition of Healthy System

ระบบถือว่าสุขภาพดีเมื่อ:

- `/health` และ `/admin/readiness` ผ่าน
- Queue/DLQ ไม่มีงานค้างผิดปกติ
- D1 กับ Google Sheets reconcile ได้
- LINE ไม่ตอบซ้ำ
- Attendance/Payroll ไม่ซ้ำ
- Expense ที่ยังไม่ยืนยันไม่ลงบัญชี
- เจ้าของร้านตรวจรายงานประจำวันได้โดยไม่ต้องแก้ข้อมูลหลังบ้านบ่อย
- มีขั้นตอนกู้คืนที่ทำตามได้จริง