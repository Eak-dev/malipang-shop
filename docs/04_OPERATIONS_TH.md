# Operations สำหรับผู้ดูแลคนเดียว

## ทุกวัน

1. เปิด `/health`
2. เปิด `/admin/status`
3. ตรวจ `openFailedJobs` และ sync ที่ FAILED
4. ตรวจ `V52_DAILY_PAYROLL` แถว REVIEW ก่อนจ่ายเงิน

## Sheets ไม่อัปเดต

ข้อมูล D1 ยังเป็นข้อมูลจริง แก้สิทธิ์ Service Account แล้วเรียก:

```bash
curl -X POST 'https://<worker>/admin/retry-sync' -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

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
