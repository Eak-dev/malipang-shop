# Operations สำหรับผู้ดูแลคนเดียว

## ทุกวัน

1. เปิด `/health` เพื่อตรวจ configuration
2. เปิด `/admin/readiness` เพื่อตรวจ D1, LINE, Google Sheets และ R2 จริง
3. เปิด `/admin/status`
4. ตรวจ `openFailedJobs` และ sync ที่ FAILED
5. ตรวจ `V52_DAILY_PAYROLL` แถว REVIEW ก่อนจ่ายเงิน

## Sheets ไม่อัปเดต

ข้อมูล D1 ยังเป็นข้อมูลจริง แก้สิทธิ์ Service Account แล้วเรียก:

```bash
curl -X POST 'https://<worker>/admin/retry-sync' -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

หาก D1 มีข้อมูลแต่แถวใน Sheets หายหรือ Sync Job เดิมขึ้น COMPLETED ให้สั่ง Backfill ช่วงวันที่:

```bash
curl -X POST 'https://<worker>/admin/reconcile-sheets' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"fromDate":"2026-07-01","toDate":"2026-07-31","limitPerType":200}'
```

คำสั่งนี้ใช้ D1 เป็นข้อมูลจริงและเขียนแท็บ `V52_*` ใหม่แบบ idempotent รวมทั้ง backfill ค่าใช้จ่ายที่ยืนยันแล้วลง `รายวัน` โดยไม่แตะสูตร

## Expense document review และ recovery

- Receipt/Tax Invoice/Online Order ที่เป็น `WAITING_CONFIRM` ต้องตรวจ vendor, final paid, payment source, category และ date บน Flex ก่อน Save
- Delivery Order เดี่ยวและเอกสารที่ยอด/วันที่จ่ายไม่ครบเป็น `WAITING_REVIEW`; ห้ามสร้างยอดเองจากราคา list หรือ expected delivery
- เมื่อ Receipt/Tax Invoice ถูกยืนยันและยอด line item รวมตรงกับยอดจ่ายจริง `รายวัน` จะลงหนึ่งแถวต่อ item. ตรวจว่าผลรวมแถว item เท่ากับยอด Expense ใน D1 และ `V52_EXPENSE_RAW` ยังมีเพียงหนึ่งแถว summary. หากยอดแบ่งไม่ได้จากหลักฐาน (เช่น voucher/subsidy/shipping) ระบบจะลง summary เดียวเพื่อรักษายอดบัญชี.
- หากเดือนใน `รายวัน` เต็ม ระบบขยาย row ก่อน `รวม` อัตโนมัติแบบ formula-safe. ถ้า Sheets ตอบ error ให้ปล่อย sync job retry; ห้ามแทรกแถวหรือย้าย total ด้วยมือระหว่าง job กำลัง retry
- ตรวจ D1 `expense_events`, `expense_documents`, `expense_document_items`, `expense_document_cases`, `expense_document_links` และ `expense_audit_log` ก่อน reconcile เสมอ. Reconcile ใช้ key `Expense_ID|Item_ID` จึงเขียนซ้ำไม่ได้. Undo/CANCELLED ต้องล้างทุก row key ของ Expense นั้น แต่คงหลักฐานและ audit ไว้
- แถว summary เก่าที่มีอยู่ก่อนระบบ line-item จะไม่ถูกแปลงอัตโนมัติ. หากตรวจสอบรายการหนึ่งแล้วว่าเป็น `CONFIRMED`, มี Primary Receipt/Tax Invoice และผลรวม line item ตรงกับยอดจ่ายจริง ให้ใช้ `POST /admin/reconcile-expense-items` พร้อม `{"expenseId":"<id>"}` เพื่อแทนที่เฉพาะแถว summary ของ Expense นั้นด้วยแถว item. คำสั่งจะปฏิเสธรายการที่แบ่งยอดอย่างปลอดภัยไม่ได้, ไม่เรียก OCR/Vision และไม่สร้าง Expense ใหม่; ตรวจผลรวม, mapping, สูตรรายเดือน และ `V52_EXPENSE_RAW` หลังทำทุกครั้ง.

## LINE Reply และ Push quota

ผลจาก event พนักงาน ทั้ง Attendance, Expense และ postback ใช้ Reply API กับ `replyToken` ของ event เดิมเป็นหลัก จึงไม่ถูกนับในโควตาข้อความ Push รายเดือน และไม่ตั้งใจหน่วงคำตอบปกติไป Queue เมื่อ reply token ยังใช้ได้

หากไม่มี reply token หรือ Reply API ตอบล้มเหลว ระบบจะสร้าง `LINE_NOTIFICATION` Push fallback แบบ deterministic/durable โดยไม่ย้อนกลับไปรัน Vision, Commit Attendance, Payroll หรือ Sheets อีก การ retry notification จึงไม่สร้าง Punch หรือ Expense ซ้ำ

Cron จะกู้ outbox ที่ค้างจาก Queue enqueue ล้มเหลวแบบ atomic และใช้ retry key เดิม การกู้นี้ส่งเฉพาะ payload ผลลัพธ์เดิม ไม่ replay LINE event หรือธุรกรรม ส่วน outbox ที่เป็น `LINE_PUSH_QUOTA_EXHAUSTED` จะไม่ถูก Cron กู้ซ้ำทุก 5 นาที

หาก Push ตอบ 429 เพราะโควตารายเดือนหมด ระบบจัดประเภทเป็น `LINE_PUSH_QUOTA_EXHAUSTED`, เก็บ failed job/metric ให้ตรวจได้ และหยุด retry ถี่ เพราะเงื่อนไขนี้ไม่ฟื้นจนกว่าโควตาจะกลับมา ส่วน 429 แบบ rate limit ชั่วคราวยังใช้ bounded backoff ตามเดิม

ตรวจ `/admin/status` หรือ `/admin/readiness` เพื่อดู target limit, consumption และสถานะ Push การหมดโควตา Push แสดง `DEGRADED/EXHAUSTED` แต่ไม่ทำให้ readiness ล้ม หาก LINE authentication และ Reply capability ยังผ่าน

`POST /admin/attendance/notification-smoke` เป็นการทดสอบ Push fallback เท่านั้น และจำกัดกับ `OWN001` (Eak) ไม่ใช่หลักฐานว่า Reply API ทำงาน การยืนยัน Reply path ต้องใช้ event inbound ปัจจุบันที่มี reply token และตรวจว่าไม่มี Push fallback job ถูกสร้างเมื่อ Reply สำเร็จ

Flex ที่ผู้ใช้ต้องกด `Save` หรือ `Cancel` เพื่อให้ Workflow เดินต่อยังเป็น actionable notification แบบ strict หากส่งไม่สำเร็จ Queue จะ retry และกรณีสลิปเดิมมี `WAITING_CONFIRM` อยู่แล้ว ระบบจะส่งการ์ดเดิมซ้ำแทนการสร้าง Expense ซ้ำหรือปฏิเสธว่าเป็นสลิปซ้ำ

ตรวจ D1 ก่อนเสมอว่าธุรกรรมถูกสร้างหรือไม่ ห้าม replay Event โดยเดา ส่วน LINE operation ที่จำเป็นต่อการทำงาน เช่น ดาวน์โหลดรูปหลักฐานและ Owner DLQ alert ยังคงถือว่าเป็น error และเข้าสู่ retry ตามปกติ

## แก้เวลาเข้า–ออก

```bash
curl -X POST 'https://<worker>/admin/attendance/correct' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"employeeId":"EMP001","workDate":"2026-07-20","timeIn":"04:05","timeOut":"16:00","reason":"ตรวจจากรูปหลักฐานแล้ว"}'
```

การแก้ไขจะคำนวณ Daily/Weekly ใหม่, sync Durable Object และบันทึก `admin_audit`

## Rollback

เปลี่ยน LINE Webhook กลับ URL เดิม ห้ามลบ D1/R2 และ export `failed_jobs`, `inbound_events`, `admin_audit` ก่อนแก้ระบบ
