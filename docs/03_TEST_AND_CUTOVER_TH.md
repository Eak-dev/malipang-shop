# ทดสอบและ Cutover

## Automated

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

## Regression test รูปนาฬิกาจริง

รูปมาตรฐานและคำตอบที่คาดหวังอยู่ใน `tests/fixtures/clock-photos` โดยใช้ Timestamp และพิกัดจาก Overlay ตัวหนังสือสีขาวเป็นข้อมูลหลัก ส่วนนาฬิกาประจำร้านใช้เป็นหลักฐานสถานที่เท่านั้น ไฟล์ `.jpg` ถูก Git ignore เพราะมีข้อมูลสถานที่จริง แต่ `cases.json` สามารถเก็บใน Git ได้

```bash
MALIPANG_VISION_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

Endpoint ทดสอบรับเฉพาะ JPEG ไม่เกิน 5 MiB ต้องใช้ Admin Token และไม่บันทึกรูปลง R2

กติกาใหม่คาดว่า Photo 1–5 ผ่านเพราะมี Timestamp และ GPS ครบ ส่วน Photo 6–7 ต้องไม่ผ่านด้วย `GPS_MISSING` เพราะมี Timestamp แต่ไม่มีพิกัดบนภาพ ต้องรัน Live baseline ใหม่หลัง Deploy

## Regression test สลิปธนาคารและวอลเล็ต

contract อยู่ใน `tests/fixtures/bank-slip-cases.json` และครอบคลุม KBank/K+, SCB และเป๋าตัง/G-Wallet รูปจริงไม่เก็บใน Git ให้ส่ง path ผ่าน `MALIPANG_BANK_SLIP_IMAGE_MAP` แล้วรัน `npm run test:bank-slips`

ผล baseline วันที่ 22 กรกฎาคม 2026 ผ่าน `3/3`: ทั้งหมดเป็น `BANK_SLIP` และ validation ผ่าน KBank แปลงปีสองหลัก `26` เป็น `2026`, SCB ใช้ยอด 50 บาท และเป๋าตังแยกยอด 40 บาท/ส่วนลด 24 บาท/ยอดจ่ายจริง 16 บาทถูกต้อง

## UAT ขั้นต่ำ

ผล baseline ข้อความค่าใช้จ่ายวันที่ 22 กรกฎาคม 2026: accepted/quick-save/confirm/reject และ Wallet mapping ผ่าน Worker จริง `44/44`; Quick Save สร้าง `CONFIRMED` และ Sheets job, รายการปกติสร้าง `WAITING_CONFIRM`, ข้อความผิดไม่เขียน D1 ใน integration test

- รูปนาฬิกาจริงอย่างน้อย 50 รูป
- Win/Tualek/Eak ส่งเข้า–ออกและส่งซ้ำ
- ทดสอบ Overlay ไม่มี GPS, ตัวหนังสือไม่ขาว, Timestamp เก่า, พิกัดนอกรัศมี และรูปที่ไม่มีนาฬิการ้าน
- หลายคนส่งพร้อมกัน
- ปิดอินเทอร์เน็ตหรือทำ Google เขียนล้มเหลวเพื่อดู retry
- ตรวจ D1, R2 และ `V52_*` ทุกวัน
- Expense `ทอน`, `change` และ `โอน` ภาษาไทยบันทึกทันที; transfer ภาษาอังกฤษ บัตร หรือรายการไม่มี token แสดง Summary Flex ให้ตรวจและกดยืนยัน
- ผู้ไม่มีสิทธิ์ Expense ต้องถูกปฏิเสธ
- Bank slip ที่สำเร็จต้องขึ้น Summary Flex และยังไม่เข้า Sheets ก่อนกด Save; หลัง Save ต้องลง H และ W=`บัญชีร้าน`
- ส่งสลิปเดิมซ้ำทั้งไฟล์เดิมและเลขอ้างอิงเดิมต้องไม่สร้าง Expense ซ้ำ
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
