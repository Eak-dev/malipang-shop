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
