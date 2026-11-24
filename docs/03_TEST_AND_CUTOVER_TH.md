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
MALIPANG_VISION_BASE_URL=https://malipang-backend-v5-2.eakkachai-dev.workers.dev \
MALIPANG_ADMIN_TOKEN_FILE=secrets/ADMIN_TOKEN.txt \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

Endpoint ทดสอบรับเฉพาะ JPEG ไม่เกิน 5 MiB ต้องใช้ Admin Token และไม่บันทึกรูปลง R2

สำหรับชุดมาตรฐานใน `tests/fixtures/clock-photos` คาดว่า Photo 1–5 ผ่านเพราะมี Timestamp และ GPS ครบ ส่วน Photo 6–7 ต้องไม่ผ่านด้วย `GPS_MISSING` เพราะมี Timestamp แต่ไม่มีพิกัดบนภาพ ต้องรัน Live baseline ใหม่หลัง Deploy

## Regression test สลิปธนาคารและวอลเล็ต

contract อยู่ใน `tests/fixtures/bank-slip-cases.json` และครอบคลุม KBank/K+, SCB และเป๋าตัง/G-Wallet รูปจริงไม่เก็บใน Git ให้ส่ง path ผ่าน `MALIPANG_BANK_SLIP_IMAGE_MAP` แล้วรัน `npm run test:bank-slips`

ผล baseline วันที่ 22 กรกฎาคม 2026 ผ่าน `3/3`: ทั้งหมดเป็น `BANK_SLIP` และ validation ผ่าน KBank แปลงปีสองหลัก `26` เป็น `2026`, SCB ใช้ยอด 50 บาท และเป๋าตังแยกยอด 40 บาท/ส่วนลด 24 บาท/ยอดจ่ายจริง 16 บาทถูกต้อง

## ทดสอบตัวประเมินข้อความค่าใช้จ่ายบน Production

หลังรวม workflow `Production expense text evaluation` ให้รันจาก GitHub Actions บน `main` ด้วย SHA เต็มของ `main` ที่ตรวจแล้วในช่อง `expected_main_sha` จากนั้นให้ผู้อนุมัติของ environment `production` ตรวจและอนุมัติงานตามปกติ Workflow ใช้คีย์ Admin เดิมใน environment นั้นและส่งเฉพาะข้อความจำลอง 151 กรณีไปยัง `/admin/expense/evaluate` ระบบประเมินข้อความและคืนผลโดยไม่สร้างค่าใช้จ่าย รายงานผลรวมของชุดทดสอบเท่านั้น โดยตัวนับ Node รวม parent test เป็น 152 ข้อ

ผลจาก workflow อ้างอิง Worker ที่ให้บริการขณะรัน ให้บันทึก Worker version จาก Cloudflare ก่อนและหลังการทดสอบแยกจาก SHA ของ workflow งานนี้ครอบคลุมการแปลข้อความ ส่วนภาพ การส่งคิว และการเขียนรายงานให้ตรวจตามขั้นตอนของงานนั้น

## ทดสอบรูปส่วนตัวของ Issue 348

workflow `Production private photo evaluation` รับเฉพาะ main ที่ตรงกับ SHA ที่ตรวจและผ่าน reviewer ของ production environment. ก่อนอนุมัติให้ตรวจ Worker version และค่า ATTENDANCE_CLOCK_MIN_CONFIDENCE 0.70. ตรวจว่า bucket ทดสอบเป็น private และสิทธิ์อ่านยังไม่หมดอายุ. Environment เก็บ ISSUE348_R2_READER และ ISSUE348_PHOTO_CONTROL แยกจาก Admin. ตัวรับสร้างลิงก์ GET สำหรับแพ็กเกจเดียว มีอายุห้านาที.

หลังตรวจแพ็กเกจเข้ารหัส SHA-256 ของทั้งสิบไฟล์ และ manifest ทั้งสองชุด จึงส่งรูปลงเวลาเจ็ดรูปและสลิปสามใบไปยังตัวประเมินภาพของร้าน. Worker อาจเรียก OpenAI ถึงยี่สิบครั้งและเขียนสถิติใน Production D1. ตรวจขอบเขตตาม #296 ก่อน dispatch. หากผลคำขอคลุมเครือให้กระทบยอดก่อนเปิดรอบใหม่. หากต้องหยุดให้ยกเลิกรันและเพิกถอนสิทธิ์ของชุดทดสอบ. ไฟล์ชั่วคราวถูกนำออกเมื่อจบงาน.

สำหรับ fixture รูปลงเวลาของ #348 รูป 07 ต้องถูกปฏิเสธเพราะไม่มีวันและเวลาถ่ายที่ใช้ลงเวลาได้ ตรวจค่าที่อ่านและเหตุผลการปฏิเสธตามลำดับ validation ของ Worker ผลที่คาดหวังนี้ไม่ได้อ้างผลจากรัน Production

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
