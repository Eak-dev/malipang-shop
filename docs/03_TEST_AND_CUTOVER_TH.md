# ทดสอบและ Cutover

## Automated

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

## Regression test รูปนาฬิกาจริง

รูปมาตรฐานและคำตอบที่คาดหวังอยู่ใน `tests/fixtures/clock-photos` โดยใช้เวลาจากเลขสีขาว และเดือน/วันที่จากเลขสีเขียวบนหน้าปัดเท่านั้น ไม่ใช้ลายน้ำเป็นคำตอบ ไฟล์ `.jpg` ถูก Git ignore เพราะมีข้อมูลสถานที่จริง แต่ `cases.json` สามารถเก็บใน Git ได้

```bash
MALIPANG_VISION_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

Endpoint ทดสอบรับเฉพาะ JPEG ไม่เกิน 5 MiB ต้องใช้ Admin Token และไม่บันทึกรูปลง R2

ผล baseline วันที่ 22 กรกฎาคม 2026: OpenAI `gpt-4.1-mini` อ่านชนิดรูป เวลา เดือน และวันที่ถูก `7/7`; `gpt-4o-mini` อ่าน Photo 2 ผิดเป็น `04:19`; Workers AI คืน `UNKNOWN 7/7` จึงปิดไว้ก่อน ส่วน weekday ไม่ใช้ตัดสิน Attendance และให้คืน `null`

## UAT ขั้นต่ำ

- รูปนาฬิกาจริงอย่างน้อย 50 รูป
- Win/Tualek/Eak ส่งเข้า–ออกและส่งซ้ำ
- วันที่ผิด วันบนหน้าปัดผิด รูปมืด/เอียง/บัง
- หลายคนส่งพร้อมกัน
- ปิดอินเทอร์เน็ตหรือทำ Google เขียนล้มเหลวเพื่อดู retry
- ตรวจ D1, R2 และ `V52_*` ทุกวัน
- Expense cash บันทึกทันที และ transfer ต้องกดยืนยัน
- ผู้ไม่มีสิทธิ์ Expense ต้องถูกปฏิเสธ
- แก้ missing punch ผ่าน `/admin/attendance/correct`
- `/admin/readiness` ต้องผ่านทั้ง D1, LINE, Sheets และ R2
- ทดสอบให้ job เข้า DLQ และเจ้าของได้รับ LINE alert
- ลบ/แก้แถว Shadow แล้วทดสอบ `/admin/reconcile-sheets`

## เกณฑ์เปิดจริง

- Lost event = 0
- Duplicate payroll = 0
- Critical discrepancy กับระบบเดิม = 0 ติดต่อกัน 7 วัน
- รูปมาตรฐานอ่านถูกอย่างน้อย 99%
- Queue retry, DLQ และ rollback ทดสอบแล้ว

ระหว่าง Shadow ใช้ `RUNTIME_MODE=shadow` และ `SHADOW_LINE_OUTPUT=false` เมื่อผ่านจึงเปลี่ยนเป็น `production` และสลับ LINE Webhook
