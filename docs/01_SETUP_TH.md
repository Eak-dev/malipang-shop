# ติดตั้ง V5.2 Solo

## 1. ตรวจโค้ด

```bash
npm ci
npm run check
npx wrangler login
```

## 2. สร้าง Cloudflare resources

```bash
npx wrangler d1 create malipang-v5-2
npx wrangler queues create malipang-jobs
npx wrangler queues create malipang-jobs-dlq
npx wrangler r2 bucket create malipang-v5-evidence
```

นำ D1 ID ไปแทน `REPLACE_D1_DATABASE_ID` ใน `wrangler.jsonc`

## 3. ตั้ง Secrets

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_OWNER_USER_ID
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY_BASE64
npx wrangler secret put GOOGLE_SPREADSHEET_ID
npx wrangler secret put OPENAI_API_KEY
```

`LINE_OWNER_USER_ID` คือ User ID ของเจ้าของที่ใช้รับแจ้งเตือน DLQ, `ADMIN_TOKEN` ต้องสุ่มอย่างน้อย 32 ตัวอักษร และระบบ Vision ปัจจุบันใช้ `OPENAI_API_KEY` ที่ตั้งเป็น Cloudflare Secret

ตรวจ `ATTENDANCE_STORE_LAT`, `ATTENDANCE_STORE_LNG`, รัศมี และเวลาภาพสูงสุดใน `wrangler.jsonc` ก่อน Deploy ค่าปัจจุบันตั้งจากพิกัดหน้าร้านในชุดรูปทดสอบ และควรยืนยันกับพิกัดจริงของร้านอีกครั้ง

## 4. Google

เปิด Google Sheets API สร้าง Service Account และแชร์ `MaliPang_OWNER_MASTER` ให้ Service Account เป็น Editor จากนั้นใช้ Spreadsheet ID:

```text
1d8Cv76JicUo7jO4KykQ35Xg60GAjMOyJCeYT92xkKL8
```

## 5. Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

## 6. Bootstrap และ import พนักงาน

```bash
curl -X POST 'https://<worker>/admin/bootstrap-sheets' -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl -X POST 'https://<worker>/admin/import-employees-from-sheet' -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

ตรวจ `/admin/readiness` ให้ `d1`, `line`, `sheets`, `r2`, `attendanceConfig` เป็น `ok: true` และตรวจ `/admin/status` แล้วจึงเชื่อม LINE OA ทดสอบ
