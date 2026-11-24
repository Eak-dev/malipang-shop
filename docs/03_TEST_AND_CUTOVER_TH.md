# ทดสอบและ Cutover

## Automated

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

## Receipt identity / linked evidence (local เท่านั้น)

หลัง `npm run build:test` รัน `node --test tests/expense-receipt-guards.test.mjs tests/expense-receipt-identity.test.mjs tests/expense-confirm-integration.test.mjs tests/expense-linked-receipt-migration.test.mjs`.
ต้องพิสูจน์ exact duplicate, OCR review hold, concurrent confirm/link, batch rollback,
queue/LINE failure และ cash/source behavior โดยใช้ fixture เท่านั้น.

Migration 0019 สร้าง invoice index ใหม่ก่อนลบ index เดิม ข้อยกเว้นจำกัดเฉพาะ
`expense_id IS NULL`, exact order ไม่ว่าง และ key `receipt:linked:v1:`; แถว primary,
review-only แบบเดิม, reference key และ image hash ยังมี unique guards. ห้ามแก้ issuer
หรือเลขต้นฉบับเพื่อหลบ constraint. รันซ้ำต้องไม่เปลี่ยนข้อมูล พร้อม integrity/FK ผ่าน.

ก่อน release ต้องอนุมัติ remote migration แยก, backup/restore ทดสอบ, ตรวจ schema และ
ลง 0019 ก่อน runtime ใหม่. ทดสอบ old runtime/new schema ด้วย fixture ด้วย. UAT ที่ได้รับ
อนุญาตต้องส่ง Online Order แล้วตามด้วย Receipt/Tax Invoice/Delivery Order ที่มี exact
order และเลขเดียวกัน: Expense 1, เอกสาร 2, link/audit เพิ่ม 1, ไม่มี sync เพิ่มจน confirm;
ส่งซ้ำหรือพร้อมกันต้องไม่เพิ่มเอกสารชนิดเดียวกัน และ supporting ต้องไม่ถูก CONFIRMED.

Rollback Worker ใช้ schema ใหม่ต่อได้ แต่การกลับ invoice index เดิมทำได้เฉพาะเมื่อ
query group ตาม `legal_vendor_name,document_number` ภายใต้ predicate เดิมไม่พบซ้ำ.
หลังรับ linked evidence แล้วอาจสร้าง index เดิมไม่ได้: ต้อง fail closed, คง schema ใหม่
และ forward-fix; ห้ามลบ/เปลี่ยนหลักฐานเพื่อบังคับ rollback schema. Old Worker จะไม่สร้าง
ยอดใหม่ให้ exact order เดิม แต่อาจกลับไปปฏิเสธเอกสารชนิดใหม่ จึงต้องแจ้งข้อจำกัดนี้.

## Regression test รูปนาฬิกาจริง

รูปมาตรฐานและคำตอบที่คาดหวังอยู่ใน `tests/fixtures/clock-photos` โดยใช้ Timestamp และพิกัดจาก Overlay ตัวหนังสือสีขาวเป็นข้อมูลหลัก ส่วนนาฬิกาประจำร้านใช้เป็นหลักฐานสถานที่เท่านั้น ไฟล์ `.jpg` ถูก Git ignore เพราะมีข้อมูลสถานที่จริง แต่ `cases.json` สามารถเก็บใน Git ได้

```bash
MALIPANG_VISION_BASE_URL=<ปลายทางทดสอบที่ได้รับอนุญาต> \
MALIPANG_ADMIN_TOKEN_FILE=<path ไฟล์ token ของปลายทางนั้น> \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

ค่าในวงเล็บเป็น placeholder: ห้ามใส่ URL ของ Production หรือ Worker จริงตามตัวอย่างเก่า และห้ามเก็บ URL/token จริงใน Git. ก่อนรันต้องยืนยันว่าปลายทางเป็นสภาพแวดล้อมทดสอบที่ได้รับอนุญาต ตรวจอำนาจ (authority) ของงานและผลข้างเคียง เช่น การเรียก provider ที่มีค่าใช้จ่ายและ metrics ที่ endpoint อาจบันทึก; ถ้ายังไม่ทราบปลายทางที่อนุญาต ให้คง live เป็น blocked และอย่าเดา

Endpoint ทดสอบรับเฉพาะ JPEG ไม่เกิน 5 MiB ต้องใช้ Admin Token และไม่บันทึกรูปลง R2

กติกาใหม่คาดว่า Photo 1–5 ผ่านเพราะมี Timestamp และ GPS ครบ ส่วน Photo 6–7 ต้องไม่ผ่านด้วย `GPS_MISSING` เพราะมี Timestamp แต่ไม่มีพิกัดบนภาพ ต้องรัน Live baseline ใหม่หลัง Deploy (ข้อนี้ใช้กับชุด `cases.json` เดิมเท่านั้น)

### ชุดรูปส่วนตัวใหม่ (manifest นอก Git)

ตั้ง `MALIPANG_CLOCK_PRIVATE_MANIFEST` เป็น path ของ manifest ส่วนตัวนอก repository เพื่อให้ `tests/clock-photo-fixtures.test.mjs` ใช้ชุดนั้นแทน `cases.json` ทั้งชุด; ไม่ตั้งค่า = ใช้ `cases.json` เดิมตามเดิม และเมื่อตั้งค่าแล้วจะไม่ถอยกลับไป `cases.json` เงียบ ๆ. manifest ต้องมีเจ็ดเคส (`photo-01` ถึง `photo-07`) ต่อเคสมี `file` (path สัมพัทธ์ภายในโฟลเดอร์ manifest), `sha256`, `receivedAt` ย้อนหลังที่มี time zone และ `ownerExpected`. expected ของเจ้าของถูกกำหนดในโค้ดทดสอบ: 01–05 `pass`, 06–07 `reject`; manifest ที่ไม่ตรงถูกปฏิเสธ จึงไม่ปรับตามผลของระบบ. ค่าวัน เวลา และพิกัดของเคส `pass` ใส่ใน `expectedReading` ได้ แต่ใช้เทียบก็ต่อเมื่อ `readingVerified` เป็น `true` หลังผู้ตรวจอิสระเทียบกับภาพแล้ว; เคส `reject` ห้ามมีค่าเหล่านี้. `sha256` ของเจ็ดรูปต้องไม่ซ้ำกัน แม้ตั้งชื่อไฟล์ต่างกัน และภาพที่ resolve symlink (ทั้งไฟล์และโฟลเดอร์) แล้วต้องอยู่ภายในโฟลเดอร์ของ manifest. ขาด manifest, ภาพ, sha256 ไม่ตรง/ซ้ำ, path ออกนอกโฟลเดอร์หรือรูปแบบผิด จะล้มด้วยรหัสเหตุคงที่ที่ไม่มี path ไม่ข้าม.

เคส 06–07 ต้อง `validation.ok=false`, ไม่มีวันเวลาและพิกัดที่ถูกสร้างขึ้น และรหัสต้องสอดคล้องกับลำดับตรวจใน `src/domain/attendance.ts` (ก่อน `GPS_MISSING`: `NOT_CLOCK`, `CLOCK_NOT_CONFIRMED`, `TIMESTAMP_MISSING`, `TIMESTAMP_NOT_WHITE`, `TIMESTAMP_FIELDS_MISSING`) โดยไม่กำหนด `GPS_MISSING` ล่วงหน้า; รหัสต้องตรงกับเงื่อนไขแรกที่ล้มของ reading นั้น (เช่น `kind` ไม่ใช่ `CLOCK` ต้องได้ `NOT_CLOCK` ไม่ใช่ `TIMESTAMP_FIELDS_MISSING`) และผล HTTP 200 ที่มี provider เป็น `none` หรือ `openai-error` ถือเป็นการอ่านล้มเหลว ไม่นับเป็นการปฏิเสธที่ถูกต้อง; แต่ละแกนของพิกัด (latitude, longitude) ต้องว่างแยกกัน. ข้อความ assertion และ diagnostics ไม่พิมพ์เวลา พิกัด ที่อยู่ path หรือข้อผิดพลาดจากการอ่านไฟล์; diagnostics มีเฉพาะรหัสเคส ผลรับ/ปฏิเสธ รหัส validation และค่า present/absent. test แบบ `synthetic` ในไฟล์เดียวกันใช้ข้อมูลสังเคราะห์ในเครื่อง ไม่ใช้รูปจริงหรือ network และไม่ใช่ผลทดสอบ live. Live ยังต้องมี `MALIPANG_VISION_BASE_URL` ที่ได้รับอนุญาตและ `MALIPANG_ADMIN_TOKEN_FILE`; ไม่มีค่าเริ่มต้น และขาดแล้วล้ม. flow ของระบบไม่เปลี่ยน เปลี่ยนเฉพาะชุดทดสอบและเอกสารนี้.

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

## การตรวจครบทุกกรณีที่ใช้ข้อมูลจริง

`npm run check` บังคับกรณี live ทั้งหก ไม่ข้ามเมื่อขาดการตั้งค่า: ต้องเตรียม `MALIPANG_VISION_BASE_URL`, `MALIPANG_EXPENSE_BASE_URL`, `MALIPANG_ADMIN_TOKEN_FILE`, `MALIPANG_BANK_SLIP_IMAGE_MAP`, ภาพนาฬิกาเจ็ดรูป และ `ONLINE_ORDER_PRIVATE_FIXTURES` ให้ตรงชุด expected เดิมก่อนรัน หากขาดให้รายงาน failure ไม่ถือเป็นผลทดสอบจริง. ต้องใช้สภาพแวดล้อมทดสอบและอำนาจที่เหมาะสม; ห้ามเก็บภาพหรือข้อมูลส่วนตัวใน Git. Flow runtime ไม่เปลี่ยน: เปลี่ยนเฉพาะเงื่อนไขชุดตรวจ.
