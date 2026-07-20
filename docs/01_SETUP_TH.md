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
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY_BASE64
npx wrangler secret put GOOGLE_SPREADSHEET_ID
```

`ADMIN_TOKEN` ต้องสุ่มอย่างน้อย 32 ตัวอักษร ส่วน `OPENAI_API_KEY` ไม่ต้องตั้งในรุ่นเริ่มต้น

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

ตรวจผลจาก `/admin/status` แล้วจึงเชื่อม LINE OA ทดสอบ
