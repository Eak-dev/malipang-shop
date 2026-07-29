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

## LINE Push ตอบผู้ใช้ไม่ได้

ข้อความ Push และ Flex ทั่วไปที่ใช้แจ้งผลหลังธุรกรรมสิ้นสุดแล้วเป็น notification แบบ best effort หาก LINE ตอบ 429 หรือ HTTP error ระบบจะเก็บ `line_push_ms` และ `line_notification_failure` แต่จะไม่เปลี่ยนธุรกรรมที่สำเร็จหรือเหตุการณ์ที่ถูกปฏิเสธอย่างถูกต้องให้เป็น `FAILED`

ผล Attendance ทั้งสำเร็จและปฏิเสธใช้ `LINE_NOTIFICATION` Queue แยกจากธุรกรรมลงเวลา แต่ละงานมี `X-Line-Retry-Key` คงที่เพื่อให้ LINE ป้องกันข้อความซ้ำ การ retry จึงส่งข้อความเดิมเท่านั้นและไม่ย้อนกลับไปรัน Vision, Commit Attendance, Payroll หรือ Sheets อีก ความผิดพลาดชั่วคราวจะ retry แบบ bounded backoff ส่วน 4xx ถาวรจะถูกเก็บใน `failed_jobs` โดยไม่สร้าง Punch ซ้ำ

Production smoke ของช่องทางนี้ใช้ `POST /admin/attendance/notification-smoke` ได้เฉพาะ `EMP_TEST` และต้องระบุ `SUCCESS` หรือ `REJECTION` พร้อม `runId` คำสั่งนี้สร้างเฉพาะ notification job และไม่สร้าง Attendance/Payroll/Sheets record

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
