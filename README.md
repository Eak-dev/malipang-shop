# MaliPang Backend V5.2 Solo — No Apps Script

รุ่นปรับปรุงสำหรับดูแลโดยนักพัฒนาคนเดียว รับข้อมูลจาก LINE OA ประมวลผล Attendance/Payroll บน Cloudflare และเขียน Google Sheets API โดยตรง

สถานะ: **RC สำหรับ Shadow/UAT** — โค้ดและ automated tests ผ่าน แต่ต้องทดสอบกับบัญชี LINE/Cloudflare/Google จริงก่อน Production

## ขอบเขตรุ่นนี้

- Attendance จากรูปนาฬิกา โดยใช้เวลาในรูปเป็น Official Time
- Payroll รายวันและรายสัปดาห์
- Expense ข้อความ เช่น `ไข่ ทอน 375` และ `ค่าไฟ โอน 1200`
- รูป Receipt/Bank slip เก็บเข้าคิวตรวจเท่านั้น ไม่ลงยอดอัตโนมัติ
- Google Sheets เป็นรายงาน ส่วน D1 เป็นข้อมูลจริง
- ไม่ใช้ Apps Script
- OpenAI fallback ปิดเป็นค่าเริ่มต้น ใช้ Workers AI ก่อน

## โครงสร้างที่ลดแล้ว

```text
LINE OA -> Worker -> Queue เดียว -> Workers AI -> Durable Object -> D1
                                                    |-> R2 evidence
                                                    `-> Google Sheets API
```

ต้องสร้าง Cloudflare resource เพียง D1, Queue, DLQ และ R2 ส่วน Durable Object สร้างตอน deploy

## ตรวจโค้ด

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

## ติดตั้งแบบสั้น

1. อ่าน `docs/01_SETUP_TH.md`
2. สร้าง Cloudflare resources 4 รายการ
3. ใส่ D1 ID ใน `wrangler.jsonc`
4. ตั้ง Secrets 6 ค่า
5. Migrate และ Deploy
6. เรียก `/admin/bootstrap-sheets`
7. เรียก `/admin/import-employees-from-sheet`
8. ทดสอบกับ LINE OA ทดสอบก่อน Cutover

ไฟล์ Google Sheets ที่ตรวจโครงสร้างแล้ว: `MaliPang_OWNER_MASTER` (`1d8Cv76JicUo7jO4KykQ35Xg60GAjMOyJCeYT92xkKL8`)

ระบบอ่านพนักงานจาก `HR_STAFF_CONFIG` และเขียนผล Shadow ลง `V52_*` จึงไม่ทับสูตร HR เดิม

## Admin endpoints

- `GET /admin/status`
- `POST /admin/bootstrap-sheets`
- `POST /admin/import-employees-from-sheet`
- `POST /admin/expense-access`
- `POST /admin/attendance/correct`
- `POST /admin/retry-sync`
- `GET /admin/evidence/<R2 key>`

ทุก endpoint ต้องใช้ `Authorization: Bearer <ADMIN_TOKEN>` และ token ต้องยาวอย่างน้อย 32 ตัวอักษร
