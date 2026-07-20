# Validation Report — V5.2 Solo RC1

วันที่ตรวจ: 2026-07-20

## ผ่านในเครื่องพัฒนา

- TypeScript strict typecheck: PASS
- Unit tests: 19/19 PASS
- npm lockfile และ `npm ci`: พร้อมตรวจซ้ำ
- Wrangler deploy dry-run: PASS
- SQLite migration + seed smoke test: PASS
- Retry state transition `FAILED -> PROCESSING`: PASS
- LINE HMAC raw-body test: PASS
- Payroll/Expense/Clock date validation: PASS
- Mapping จาก `HR_STAFF_CONFIG`: PASS

## ตรวจข้อมูล Google Sheets จริงแล้ว

- Spreadsheet: `MaliPang_OWNER_MASTER`
- Timezone: `Asia/Bangkok`
- Canonical staff config: `HR_STAFF_CONFIG`
- พบประวัติบางแถวที่ชื่อ EMP001/EMP002 สลับกัน จึงไม่ import ชื่อจาก `HR_ATTENDANCE_RAW`
- ค่าใช้งานจริง: Scheduled 04:00–16:00, Daily wage 500, Grace 10 นาที
- V5.2 เขียนลง `V52_*` ระหว่าง Shadow เพื่อไม่ชนสูตรเดิม
- ไม่ได้แก้ไข Google Sheet ระหว่างการตรวจ

## ยังต้องทดสอบกับบริการจริง

- Deploy Cloudflare และ apply D1 migration จริง
- Workers AI กับรูปจริง 50 รูป
- LINE signature, loading, push และ redelivery จริง
- Queue retry/DLQ และ Durable Object concurrency จริง
- Service Account bootstrap/import/write กับ Spreadsheet จริง
- R2 upload/read/lifecycle จริง
- Shadow parity อย่างน้อย 7 วัน

## ข้อจำกัดเครื่องที่ใช้ตรวจ

macOS 12.6 ต่ำกว่าขั้นต่ำของ workerd รุ่นปัจจุบัน จึงรัน Miniflare local runtime ไม่ได้ แต่ Wrangler bundle dry-run และ SQLite migration ผ่าน ควรทดสอบ runtime ต่อบน Cloudflare Preview หรือ macOS 13.5+/Linux
