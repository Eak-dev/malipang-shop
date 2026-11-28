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

## Live test แบบเลือกเปิด

CI สาธารณะและ `npm test` รันเฉพาะ regression และ fixture contract ในเครื่อง ไม่ใช้ไฟล์ส่วนตัวหรือคีย์ Production ส่วน live test ที่เรียก Worker จริงหรือใช้ภาพส่วนตัวจะรันเฉพาะเมื่อตั้ง `MALIPANG_LIVE_TESTS` เป็นชื่อชุดที่ต้องการ (คั่นด้วย comma): `clock-photos`, `bank-slips`, `expense-text`, `online-order-images` หรือ `all` ชุดที่ไม่ได้เลือกจะแสดง SKIP พร้อมเหตุผล ชุดที่เลือกแล้วแต่ขาด URL, token หรือ manifest ต้อง fail ไม่ skip ส่วนชื่อชุดที่พิมพ์ผิดจะทำให้ไฟล์ทดสอบล้ม

`all` ไม่รวม `online-order-images` เพราะเจ้าของเลื่อนการทดสอบภาพคำสั่งซื้อทั้ง 3 กรณีไว้ ต้องระบุชื่อชุดนี้ตรงๆ เท่านั้น ผล SKIP ของ live test นำไปอ้างว่าผ่านไม่ได้

## Regression test รูปนาฬิกาจริง

รูปมาตรฐานและคำตอบที่คาดหวังอยู่ใน `tests/fixtures/clock-photos` โดยใช้ Timestamp และพิกัดจาก Overlay ตัวหนังสือสีขาวเป็นข้อมูลหลัก ส่วนนาฬิกาประจำร้านใช้เป็นหลักฐานสถานที่เท่านั้น ไฟล์ `.jpg` ถูก Git ignore เพราะมีข้อมูลสถานที่จริง แต่ `cases.json` สามารถเก็บใน Git ได้

```bash
MALIPANG_LIVE_TESTS=clock-photos \
MALIPANG_VISION_BASE_URL=<ปลายทางทดสอบที่ได้รับอนุญาต> \
MALIPANG_ADMIN_TOKEN_FILE=<path ไฟล์ token ของปลายทางนั้น> \
MALIPANG_VISION_PROVIDER=openai \
npm run test:clock-photos
```

ค่าในวงเล็บเป็น placeholder: ห้ามใส่ URL ของ Production หรือ Worker จริงตามตัวอย่างเก่า และห้ามเก็บ URL/token จริงใน Git. ก่อนรันต้องยืนยันว่าปลายทางเป็นสภาพแวดล้อมทดสอบที่ได้รับอนุญาต ตรวจอำนาจ (authority) ของงานและผลข้างเคียง เช่น การเรียก provider ที่มีค่าใช้จ่ายและ metrics ที่ endpoint อาจบันทึก; ถ้ายังไม่ทราบปลายทางที่อนุญาต ให้คง live เป็น blocked และอย่าเดา

Endpoint ทดสอบรับเฉพาะ JPEG ไม่เกิน 5 MiB ต้องใช้ Admin Token และไม่บันทึกรูปลง R2

สำหรับชุดมาตรฐานใน `tests/fixtures/clock-photos` คาดว่า Photo 1–5 ผ่านเพราะมี Timestamp และ GPS ครบ ส่วน Photo 6–7 ต้องไม่ผ่านด้วย `GPS_MISSING` เพราะมี Timestamp แต่ไม่มีพิกัดบนภาพ ต้องรัน Live baseline ใหม่หลัง Deploy

### ชุดรูปส่วนตัวใหม่ (manifest นอก Git)

ตั้ง `MALIPANG_CLOCK_PRIVATE_MANIFEST` เป็น path ของ manifest ส่วนตัวนอก repository เพื่อให้ `tests/clock-photo-fixtures.test.mjs` ใช้ชุดนั้นแทน `cases.json` ทั้งชุด; ไม่ตั้งค่า = ใช้ `cases.json` เดิมตามเดิม และเมื่อตั้งค่าแล้วจะไม่ถอยกลับไป `cases.json` เงียบ ๆ. manifest ต้องมีเจ็ดเคส (`photo-01` ถึง `photo-07`) ต่อเคสมี `file` (path สัมพัทธ์ภายในโฟลเดอร์ manifest), `sha256`, `receivedAt` ย้อนหลังที่มี time zone และ `ownerExpected`. expected ของเจ้าของถูกกำหนดในโค้ดทดสอบ: 01–05 `pass`, 06–07 `reject`; manifest ที่ไม่ตรงถูกปฏิเสธ จึงไม่ปรับตามผลของระบบ. ค่าวัน เวลา และพิกัดของเคส `pass` ใส่ใน `expectedReading` ได้ แต่ใช้เทียบก็ต่อเมื่อ `readingVerified` เป็น `true` หลังผู้ตรวจอิสระเทียบกับภาพแล้ว; เคส `reject` ห้ามมีค่าเหล่านี้. `sha256` ของเจ็ดรูปต้องไม่ซ้ำกัน แม้ตั้งชื่อไฟล์ต่างกัน และภาพที่ resolve symlink (ทั้งไฟล์และโฟลเดอร์) แล้วต้องอยู่ภายในโฟลเดอร์ของ manifest. ขาด manifest, ภาพ, sha256 ไม่ตรง/ซ้ำ, path ออกนอกโฟลเดอร์หรือรูปแบบผิด จะล้มด้วยรหัสเหตุคงที่ที่ไม่มี path ไม่ข้าม.

เคส 06–07 ต้อง `validation.ok=false`, ไม่มีวันเวลาและพิกัดที่ถูกสร้างขึ้น และรหัสต้องสอดคล้องกับลำดับตรวจใน `src/domain/attendance.ts` (ก่อน `GPS_MISSING`: `NOT_CLOCK`, `CLOCK_NOT_CONFIRMED`, `TIMESTAMP_MISSING`, `TIMESTAMP_NOT_WHITE`, `TIMESTAMP_FIELDS_MISSING`) โดยไม่กำหนด `GPS_MISSING` ล่วงหน้า; รหัสต้องตรงกับเงื่อนไขแรกที่ล้มของ reading นั้น (เช่น `kind` ไม่ใช่ `CLOCK` ต้องได้ `NOT_CLOCK` ไม่ใช่ `TIMESTAMP_FIELDS_MISSING`) และผล HTTP 200 ที่มี provider เป็น `none` หรือ `openai-error` ถือเป็นการอ่านล้มเหลว ไม่นับเป็นการปฏิเสธที่ถูกต้อง; แต่ละแกนของพิกัด (latitude, longitude) ต้องว่างแยกกัน. ข้อความ assertion และ diagnostics ไม่พิมพ์เวลา พิกัด ที่อยู่ path หรือข้อผิดพลาดจากการอ่านไฟล์; diagnostics มีเฉพาะรหัสเคส ผลรับ/ปฏิเสธ รหัส validation และค่า present/absent. เคส `pass` ทุกเคสต้องมีวันที่เป็นวันที่จริง เวลาเป็นเวลาที่ถูกต้อง และ latitude/longitude เป็นตัวเลขจำกัดในช่วงจริง (ละติจูด ±90, ลองจิจูด ±180) แม้ `readingVerified` เป็น `false`; ค่า exact เทียบเฉพาะที่ verified. test แบบ `synthetic` ในไฟล์เดียวกันใช้ข้อมูลสังเคราะห์ในเครื่อง ไม่ใช้รูปจริงหรือ network และไม่ใช่ผลทดสอบ live; test ที่ใช้ validator จริงคอมไพล์ `src/domain/attendance.ts` ปัจจุบันลงโฟลเดอร์ชั่วคราวทุกครั้ง (ไม่อ่าน `dist/` จึงไม่ติดปัญหา dist ค้างหรือคนละ SHA และ `npm run test:clock-photos` ใช้ได้โดยไม่ต้อง build ก่อน). Live ยังต้องมี `MALIPANG_VISION_BASE_URL` ที่ได้รับอนุญาตและ `MALIPANG_ADMIN_TOKEN_FILE`; ไม่มีค่าเริ่มต้น และขาดแล้วล้ม. ในโหมด manifest ต้องมี `MALIPANG_ENDPOINT_CLOCK_MIN_CONFIDENCE` ด้วย (เลขทศนิยมช่วงปิด 0 ถึง 1 รวม `0` และ `1` ตามที่ `src/shared/env.ts` อนุญาต เช่น `0`, `0.70`, `0.80`, `1`; ต้องระบุค่าอย่างชัดเจน ค่าว่างไม่ถือว่าเป็น 0) เพราะ `/admin/vision/evaluate` ไม่ส่งค่า `ATTENDANCE_CLOCK_MIN_CONFIDENCE` ที่ใช้จริงกลับมา และรหัสปฏิเสธของเคส 06–07 ขึ้นกับค่านี้ (ความมั่นใจนาฬิกาต่ำกว่าเกณฑ์ให้ `CLOCK_NOT_CONFIRMED` ก่อนตรวจ timestamp). ค่านี้เป็นข้อยืนยันของผู้รันว่าตรงกับ config ของปลายทางทดสอบที่ใช้จริง ไม่ใช่สิ่งที่ test พิสูจน์เอง; ต้องมีหลักฐาน config ของปลายทางนั้นก่อนตั้ง ไม่เดาและไม่ใช้ค่า default ของโค้ด; ไม่ระบุหรือรูปแบบผิดแล้ว live ล้มก่อนส่งคำขอใด ๆ. ข้อจำกัดสำคัญ: ความถูกต้องของผล live ในเคส 06–07 ขึ้นกับหลักฐาน config ของปลายทางที่ผู้รันนำมาอ้าง; ถ้าตั้งค่านี้ผิดแล้วผลที่ได้บังเอิญสอดคล้องกับค่าที่ตั้ง (เช่น ความมั่นใจไม่อยู่ระหว่างค่าจริงกับค่าที่ตั้ง) test จะ **ไม่ตรวจพบ** ความผิดพลาดนั้น และผ่านได้ จึงห้ามเดาค่าและต้องบันทึกที่มาของหลักฐาน config ในรายงานผล; การตั้งผิดบางกรณีเท่านั้นที่จะเห็นเป็น mismatch. ไม่ปรับ expected ตามผล. flow ของระบบไม่เปลี่ยน เปลี่ยนเฉพาะชุดทดสอบและเอกสารนี้.

## Regression test สลิปธนาคารและวอลเล็ต

`MALIPANG_LIVE_TESTS=bank-slips npm run test:bank-slips` ตรวจ KBank/K+, SCB และเป๋าตัง/G-Wallet สำหรับภาพเดิม ใช้ `tests/fixtures/bank-slip-cases.json` กับ `MALIPANG_BANK_SLIP_IMAGE_MAP` ส่วนภาพชุดใหม่ให้ตั้ง `MALIPANG_BANK_SLIP_PRIVATE_MANIFEST` ชี้ manifest ที่เก็บส่วนตัวนอก Git และใช้ปลายทาง UAT ที่ยืนยันแล้วตามเงื่อนไขในส่วนรูปลงเวลา เลือกเพียงวิธีเดียว

Manifest ใช้ `cases` สามรายการตาม `id` เดิม แต่ละรายการระบุชื่อ JPEG ที่อยู่ข้าง manifest, `sha256`, `readingVerified: true` หลังตรวจจากภาพโดยอิสระ และ `expected` ที่ตรงภาพ ได้แก่ `channel`, `paymentDate`, `paymentTime`, `paidAmountBaht` และ `allowedCategories` สำหรับเป๋าตังให้ระบุ `grossAmountBaht` กับ `discountAmountBaht` ด้วย ชุดทดสอบปฏิเสธ JPEG ที่ hash ไม่ตรงหรือซ้ำกัน และรายงานความคลาดเคลื่อนเป็นชื่อฟิลด์โดยไม่เผยค่าจากสลิป

ผล baseline วันที่ 22 กรกฎาคม 2026 ผ่าน `3/3`: ทั้งหมดเป็น `BANK_SLIP` และ validation ผ่าน KBank แปลงปีสองหลัก `26` เป็น `2026`, SCB ใช้ยอด 50 บาท และเป๋าตังแยกยอด 40 บาท/ส่วนลด 24 บาท/ยอดจ่ายจริง 16 บาทถูกต้อง

## ทดสอบตัวประเมินข้อความค่าใช้จ่ายบน Production

หลังรวม workflow `Production expense text evaluation` ให้รันจาก GitHub Actions บน `main` ด้วย SHA เต็มของ `main` ที่ตรวจแล้วในช่อง `expected_main_sha` จากนั้นให้ผู้อนุมัติของ environment `production` ตรวจและอนุมัติงานตามปกติ Workflow ใช้คีย์ Admin เดิมใน environment นั้นและส่งเฉพาะข้อความจำลอง 151 กรณีไปยัง `/admin/expense/evaluate` ระบบประเมินข้อความและคืนผลโดยไม่สร้างค่าใช้จ่าย รายงานผลรวมของชุดทดสอบเท่านั้น โดยตัวนับ Node รวม parent test เป็น 152 ข้อ

ผลจาก workflow อ้างอิง Worker ที่ให้บริการขณะรัน ให้บันทึก Worker version จาก Cloudflare ก่อนและหลังการทดสอบแยกจาก SHA ของ workflow งานนี้ครอบคลุมการแปลข้อความ ส่วนภาพ การส่งคิว และการเขียนรายงานให้ตรวจตามขั้นตอนของงานนั้น

## ทดสอบรูปส่วนตัวของ Issue 348

workflow `Production private photo evaluation` รับเฉพาะ main ที่ตรงกับ SHA ที่ตรวจและผ่าน reviewer ของ production environment. ก่อนอนุมัติให้ตรวจ Worker version และค่า ATTENDANCE_CLOCK_MIN_CONFIDENCE 0.70. ตรวจว่า bucket ทดสอบเป็น private และสิทธิ์อ่านยังไม่หมดอายุ. Environment เก็บ ISSUE348_R2_READER และ ISSUE348_PHOTO_CONTROL แยกจาก Admin. ตัวรับสร้างลิงก์ GET สำหรับแพ็กเกจเดียว มีอายุห้านาที.

หลังตรวจแพ็กเกจเข้ารหัส SHA-256 ของทั้งสิบไฟล์ และ manifest ทั้งสองชุด จึงส่งรูปลงเวลาเจ็ดรูปและสลิปสามใบไปยังตัวประเมินภาพของร้าน. Worker อาจเรียก OpenAI ถึงยี่สิบครั้งและเขียนสถิติใน Production D1. ตรวจขอบเขตตาม #296 ก่อน dispatch. หากผลคำขอคลุมเครือให้กระทบยอดก่อนเปิดรอบใหม่. หากต้องหยุดให้ยกเลิกรันและเพิกถอนสิทธิ์ของชุดทดสอบ. ไฟล์ชั่วคราวถูกนำออกเมื่อจบงาน.

สำหรับ fixture รูปลงเวลาของ #348 รูป 07 ต้องถูกปฏิเสธเพราะไม่มีวันและเวลาถ่ายที่ใช้ลงเวลาได้ ตรวจค่าที่อ่านและเหตุผลการปฏิเสธตามลำดับ validation ของ Worker ผลที่คาดหวังนี้ไม่ได้อ้างผลจากรัน Production

### UAT เฉพาะรูปลงเวลาที่ยังขาด

เลือก workflow `Production attendance photo UAT (approved IDs only)` เมื่อ Owner อนุมัติ **หนึ่งรอบ** และระบุรายชื่อรูปชัดเจน ผู้รันต้องตรวจ receipt เดิมและกระทบยอดรายการ UNKNOWN ก่อนเลือกรูปที่ยังขาดผลทดสอบและได้รับอนุมัติให้ส่งในรอบนี้ ใส่รายชื่อใน `approved_photo_ids` เช่น `photo-02,photo-06` และ SHA เต็มของ main ที่ตรวจแล้วใน `expected_main_sha` ชื่อที่รับคือ `photo-01` ถึง `photo-07` ไม่มีค่าเริ่มต้น รายชื่อว่าง รหัสซ้ำ หรือรหัสอื่นทำให้หยุดก่อนดึงแพ็ก

1. ระบุผู้รันเพียงคนเดียว บันทึก SHA ของ workflow, Worker version/SHA, เกณฑ์ confidence 0.70, รายชื่อที่อนุมัติ และจำนวนส่งสูงสุด ตรวจสิทธิ์ reader และการอนุมัติผลข้างเคียงจากการประเมินจริง (Worker, OpenAI และสถิติ D1) ถ้าหลักฐานไม่ครบให้พักงาน ผู้รันตรวจ main กับรันที่กำลังทำงานซ้ำก่อน dispatch และก่อนอนุมัติ environment `production` หาก SHA เปลี่ยนให้หยุด ทุก workflow รูปใช้ concurrency group เดียวกัน
2. Runner ดึงแพ็กเข้ารหัสหนึ่งครั้งและตรวจความถูกต้องทั้งสิบไฟล์ เขียนเฉพาะรูปลงเวลาเจ็ดรูปกับ clock manifest ในไดเรกทอรีชั่วคราวส่วนตัว จากนั้นส่งเฉพาะ ID ที่อนุมัติเรียงตาม manifest ไปยัง `/admin/vision/evaluate` ของร้าน ตัวคุม fetch ผูก hash/URL/วิธี POST กับรูปนั้นและใช้สิทธิ์เพียงครั้งเดียว รูป 01–05 ต้องผ่านและวันเวลาต้องตรง overlay ที่ตรวจไว้ รูป 06 ต้องปฏิเสธด้วยเหตุผลตรงกับสิ่งที่อ่าน รูป 07 ต้องได้ `TIMESTAMP_FIELDS_MISSING` และไม่มีวันเวลา ใช้ fixture จาก SHA เดียวกับ workflow
3. บันทึก run ID, attempt, รายชื่อที่อนุมัติ, สถานะรายรูป `ok photo-NN` หรือ `not ok photo-NN` และผลของ cleanup เมื่อรูปใดไม่ผ่านให้หยุดรายการที่เหลือ หากการส่งหรือผลตอบกลับยืนยันไม่ได้จะมี `ISSUE348_TRANSPORT_OUTCOME_UNKNOWN` ถ้า runner ถูกยกเลิก/ขาดการติดต่อก่อนพิมพ์ผลให้ถือว่ารูปที่กำลังประเมินเป็น UNKNOWN กระทบยอดกับประวัติ run และหลักฐานการใช้บริการก่อนบันทึกจำนวนที่ส่งจริง ห้ามนับ UNKNOWN เป็นการปฏิเสธหรือเป็นรูปที่ยังไม่เคยส่ง
4. การ Re-run attempt 2 ถูกบล็อก การ dispatch ใหม่เป็นคนละ run จึงต้องตรวจประวัติเดิมและมีสิทธิ์ใหม่จาก Owner สำหรับรายชื่อที่ยืนยันแล้ว ห้ามส่งซ้ำอัตโนมัติ หากต้องถอน tooling ให้หยุดเปิดรอบใหม่ ยกเลิกรันที่ค้างและกระทบยอดคำขอที่อาจส่งไปแล้ว จากนั้น revert PR ตามสิทธิ์ของ repository

### วินิจฉัยรูป 07 แบบรูปเดียว (manual)

workflow `Production photo-07 diagnostic (one image)` ใช้ R2 ส่วนตัว, secret และ environment reviewer ชุดเดียวกับข้างบน และใช้ concurrency group เดียวกัน runner ดึงและตรวจแพ็กเกจทั้งสิบไฟล์เหมือนรอบเต็ม แต่ guard (`ISSUE348_ONLY_CASE=photo-07`) และโหมดวินิจฉัย (`MALIPANG_CLOCK_DIAGNOSTIC_CASE=photo-07`) ส่ง**เฉพาะรูป 07**ไปยังตัวประเมิน Worker จึงเรียก OpenAI ได้ไม่เกินจำนวนที่การประเมินรูปเดียวใช้ log แสดงเพียงสถานะของรูปและบรรทัดสรุปหนึ่งบรรทัด (`provider`, `validationCode`, `accepted`, `clockPresent`, `overlayPresent`, `timestampPresent`, `gpsPresent`) ไม่มีค่าที่อ่านจากภาพ

job ผ่านเฉพาะเมื่อ live test จบด้วย exit 0 **และ** ได้ `accepted=false`, `validationCode=TIMESTAMP_FIELDS_MISSING`, `timestampPresent=false` กรณีอื่นจะพิมพ์ `verdict: FAIL <เหตุ>` แล้วล้ม:

| ผลที่เห็น | ความหมายตามลำดับใน `src/domain/attendance.ts` | ผ่านเกณฑ์? |
|---|---|---|
| `TIMESTAMP_FIELDS_MISSING` | ตัวอ่านเห็น overlay สีขาว (ที่อยู่) แต่ไม่พบวันที่หรือเวลาใน overlay ตรงกับต้นฉบับรูป 07 | ผ่าน |
| `TIMESTAMP_MISSING` | ตัวอ่านตอบว่าไม่พบ overlay เลย validator จึงหยุดก่อนตรวจช่องวันเวลา ยังเป็นการปฏิเสธเพราะไม่มีเวลาถ่าย แต่อ่านภาพผิดไปจากต้นฉบับที่มี overlay ที่อยู่ | ไม่ผ่าน (`FAIL OTHER_REJECTION_CODE`) รายงานให้ตัดสินแยก |
| `GPS_MISSING` หรือรหัสหลังจากนั้น และ `timestampPresent=true` | ตัวอ่านใส่วันเวลาที่ไม่มีใน overlay (สมมติฐาน: คัดจากหน้าปัดนาฬิกา) | ไม่ผ่าน (`FAIL TIMESTAMP_PRESENT`) |
| `accepted=true` | ระบบรับรูปที่ต้องปฏิเสธ | ไม่ผ่าน (`FAIL ACCEPTED`) |
| ไม่มีบรรทัดสรุป หรือ `ISSUE348_TRANSPORT_OUTCOME_UNKNOWN` | endpoint ไม่ตอบสำเร็จ หรือผลการส่งไม่แน่ชัด **ไม่ใช่การปฏิเสธภาพ** ต้องกระทบยอดก่อนสั่งใหม่ | ไม่ผ่าน |

workflow นี้ไม่เปลี่ยนกติกาลงเวลาหรือ runtime ของ Worker

### วินิจฉัย staging แพ็กรูปส่วนตัว (manual)

workflow `Production photo pack staging diagnostic (no evaluation)` (`.github/workflows/issue348-photo07-staging-diagnostic.yml`) ใช้เมื่อขั้น "Fetch and validate the approved files" ของสอง workflow ข้างบนล้ม เพราะ script เดิมรวมทุกความผิดพลาดไว้ในข้อความเดียว ([#360](https://github.com/Eak-dev/malipang-shop/pull/360))

- รับ input `expected_main_sha` เท่านั้น · job guard รันเฉพาะเมื่อ run มาจาก `refs/heads/main`, `github.sha` ของ run ตรงกับ `expected_main_sha` และ `run_attempt == 1` · Owner ในฐานะ reviewer ของ environment `production` เป็นผู้อนุมัติ · guard ผูกกับ SHA ของ run เท่านั้น ไม่ได้ตาม main ที่ขยับระหว่างรออนุมัติ
- ใช้ secret เดิม 3 ตัว: `ISSUE348_R2_READER`, `ISSUE348_PHOTO_CONTROL`, `CLOUDFLARE_ACCOUNT_ID` · ไม่มี Admin Token, `MALIPANG_WORKER_URL` หรือค่าโมเดล จึง**ไม่ส่งภาพให้ Worker, OpenAI หรือ LINE** และไม่เขียน D1
- GET แพ็กสิบไฟล์เดิมจาก R2 ส่วนตัว**หนึ่งครั้ง** ไม่ retry แล้วทำตามทุกขั้นของ `scripts/issue348-stage-private-photos.mjs` ด้วย `decryptPackage`/`validateFiles` จาก `scripts/issue348-transfer-rehearsal.mjs` ซึ่งเป็นสำเนาเดียวกับ transport ที่ pin ไว้ `440e22061cf27ed76b0188bfc3f15bde63e20f88` (git blob `fc44009eef4e368082051644d648ac005a5e992c`) · test และ workflow ตรวจ blob นี้ก่อนใช้ secret
- เมื่อ R2 ตอบไม่สำเร็จ จะอ่าน body เพียง 4096 byte แรกเพื่อหา S3 error code แล้วยกเลิก stream · ขีดนี้คุมสิ่งที่แอปเก็บไว้ ไม่ใช่จำนวน byte ที่ network รับ
- log มีบรรทัดผลเดียว `ISSUE348_STAGING_DIAGNOSTIC stage=<STAGE> code=<CODE>` และอาจมี `http=`/`s3=` (S3 code ใน allowlist หรือ `OTHER`/`NONE`/`UNREADABLE`), `bytes=` (เฉพาะ `DIGEST MISMATCH`: จำนวน byte ของ response ที่รับจากช่องทางแพ็ก**ก่อน decrypt** 0–83886080 · digest ไม่ตรงจึงยังไม่ได้พิสูจน์ว่าเป็น ciphertext ที่ถูกต้อง · ใช้เทียบกับ metadata ได้ แต่ไม่ได้พิสูจน์เองว่าไฟล์ถูกตัดหรือเป็นคนละไฟล์), `group=`/`index=` · stage คือ CONFIG, ALLOWLIST, NETWORK, HTTP, STREAM, DIGEST, EXPECTED, DECRYPT, VALIDATE, FILE, FS, RUNTIME (ไม่ได้คาดไว้) หรือ PASS · ไม่พิมพ์ URL, ชื่อ object, header, body, ภาพ หรือค่า secret
- step สุดท้ายพิมพ์ `ISSUE348_CLEANUP=REMOVED` เมื่อลบไฟล์ชั่วคราวแล้วตรวจว่าหายจริง · `NOT_CREATED` เมื่อยังไม่ได้สร้าง · `FAILED` หรือ `UNEXPECTED_PATH` ทำให้ job ล้ม · receipt ต้องบันทึกค่านี้ตามจริง

การใช้หนึ่งครั้งไม่ได้บังคับด้วย workflow: `run_attempt == 1` กันเฉพาะการ Re-run ของ run เดิม ไม่กัน dispatch ใหม่ ผู้รันที่ระบุชื่อต้อง claim แบบ exclusive ก่อนส่ง ตรวจประวัติว่ายังไม่ได้ส่งภายใต้คำอนุมัติรอบนั้น (รอบแรกคาดว่ามี 0 run · ถ้า Owner อนุมัติรอบใหม่ภายหลัง ให้นับเฉพาะรอบใหม่) บันทึก send count และ receipt · ผล UNKNOWN หรือ error ถือว่าใช้สิทธิ์ของรอบนั้นไปแล้ว ห้ามส่งซ้ำโดยไม่มีอนุมัติใหม่ · ผู้รัน (ไม่ใช่ job guard) ต้องตรวจ main สดและ run ที่ค้างทั้งก่อน dispatch และใกล้เวลาอนุมัติ ถ้า main ขยับให้ HOLD · concurrency group ร่วมกับ photo eval เท่านั้น ไม่ใช่ lock ของ release

SHA ของ workflow ที่รันกับ SHA ของ source ใน Worker ที่ deploy อยู่ต้องบันทึกและตรวจแยกกัน · การ merge workflow นี้ไม่ deploy Worker · ห้ามสรุปสถานะ Worker จาก main ต้องอ่านจาก provider ขณะนั้น · template rollback คือ `expected_sha=<SHA ของ main ปัจจุบัน>` และ `confirmation=ROLLBACK <SHA7> BEFORE RUN <run id ของ deploy>` ตาม `scripts/prod-release.mjs` ต้องผ่าน review และมีอำนาจจาก Owner ก่อนใช้ทุกครั้ง · `stage=PASS` บอกเพียงว่า staging ครั้งนั้นผ่าน ไม่ได้บอกสาเหตุของรอบที่ล้มก่อนหน้า และ**ไม่ใช่การผ่านเกณฑ์ photo-07**

### ตรวจรูปแบบ JSON ของ reader (manual)

workflow `.github/workflows/issue348-reader-json-check.yml` เสนอให้ตรวจเฉพาะ secret `ISSUE348_R2_READER` ผ่าน environment `production` และ owner approval; ต้องได้รับอนุมัติ run แยก ผูก SHA เต็มของ main ปัจจุบัน และตรวจ claim/run ก่อนส่งครั้งเดียว ไม่ retry เมื่อผลไม่แน่ชัด. ผลที่รายงานมีเพียง `EMPTY`, `INVALID_JSON`, `VALID_JSON` โดยไม่แสดงค่าหรือส่วนของ secret; ไม่รับส่งภาพ ไม่เรียก evaluator หรือ R2. `VALID_JSON` รวม JSON ที่ไม่ใช่ object และไม่พิสูจน์ความถูกต้องของ key หรือสิทธิ์ R2; `EMPTY` อาจหมายถึงไม่ได้รับ secret. เก็บ log แบบส่วนตัวและตรวจเฉพาะผลที่อนุญาต; การ merge ไม่ใช่การรันหรือ deploy Worker.

### หลักฐานวันเวลาจาก overlay

Worker ใช้วันเวลาลงเวลาเฉพาะที่อ่านได้จากข้อความ overlay สีขาวที่ตัวอ่านถอดมา (`evidencedOverlayTimestamp` ใน `src/domain/attendance-overlay.ts` ใช้ทั้ง OpenAI และ Workers AI) ข้อความต้องเข้ารูปแบบที่ parser รองรับ (วัน เดือน ปี และเวลาต้องเป็นคำหรือตัวเลขทั้งชุด ไม่ใช่ส่วนท้ายของตัวเลขหรือคำที่ยาวกว่า เช่น `123 Nov` หรือ `09:123` ไม่นับ) มีเวลาเพียงชุดเดียวเมื่อแปลง AM/PM เป็น 24 ชั่วโมงแล้ว (นาทีเดียวกันเขียนแบบมีและไม่มีวินาทีได้ แต่วินาทีที่แสดงต้องตรงกันทุกจุด, AM/PM ต้องเป็นคำเดี่ยวต่อท้ายเวลา ชื่อสถานที่ที่ขึ้นต้นด้วย Am/Pm เช่น Amphoe ไม่นับ ส่วนตัวระบุแบบที่ยังไม่รองรับ เช่น `A.M.`, `p.m`, `P M` หรือ `12:30a` จะถูกปฏิเสธ ไม่อ่านเป็นเวลา 24 ชั่วโมง เพราะ `12:30 A.M.` จะกลายเป็นเที่ยงวัน, `9:12 PM` กับ `21:12` คือเวลาเดียวกัน แต่ `09:12` กับ `9:12 PM` ขัดกัน, เขียนซ้ำได้ แต่วันที่หน้าเวลาทุกจุดต้องเป็นวันเดียวกัน) และถ้าตัวอ่านรายงาน `photoDate`/`photoTime` ด้วย ต้องตรงทั้งวันที่และ HH:mm (และตรงวินาทีเมื่อ overlay แสดงวินาที) ไม่เช่นนั้นถือว่าไม่มีวันเวลา (`TIMESTAMP_FIELDS_MISSING`) ระบบไม่เดาวันเวลาจากนาฬิการ้านหรือจากรูปแบบที่ parser ไม่รองรับ เวลาลงเวลายังเป็น HH:mm ของ overlay เหมือนเดิม ส่วนวินาทีใน `photo_datetime` มาจาก overlay (ถ้า overlay ไม่แสดงวินาทีจะเป็น `:00` และการตรวจอายุรูปนับจาก `:00` จึงต่างจากเดิมที่ใช้วินาทีที่โมเดลเติมได้ไม่เกิน 59 วินาที ทั้งด้านเข้มขึ้นเมื่อส่งช้าและด้านผ่อนลงเมื่อเวลา LINE มาก่อนนาทีบน overlay วันลงเวลาและเวลาทางการไม่เปลี่ยน รวมกรณีข้ามวัน)

ความเสี่ยงที่ยังเหลือ: ถ้าตัวอ่านแต่งทั้งข้อความ overlay และช่องวันเวลาให้ตรงกันและใกล้เวลาจริง การตรวจนี้แยกไม่ออก เพราะไม่มีมุมมองอิสระต่อภาพ (ดู #348)

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

`npm run check` ล้มเมื่อกรณี live ทั้งหกขาดการตั้งค่า เตรียม `MALIPANG_VISION_BASE_URL`, `MALIPANG_EXPENSE_BASE_URL`, `MALIPANG_ADMIN_TOKEN_FILE` และ `ONLINE_ORDER_PRIVATE_FIXTURES` เลือกชุดสลิปและภาพลงเวลาตามคู่มือด้านบน และตรวจให้ภาพตรงกับ expected ของชุดที่เลือก ใช้สภาพแวดล้อมทดสอบที่ได้รับอนุญาตและเก็บภาพกับข้อมูลส่วนตัวนอก Git การเปลี่ยนนี้อยู่ในชุดทดสอบโดยไม่มีผลต่อเส้นทาง runtime
