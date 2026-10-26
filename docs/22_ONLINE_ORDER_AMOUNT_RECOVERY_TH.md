# Online Order: อ่านยอดและกู้รายการรอตรวจ

## ขอบเขตและหลักฐานก่อนแก้

- Authority: `DEV_OWNED` — เจ้าของอนุญาตใช้คีย์เดิม แก้โค้ดและทดสอบ; ยังไม่อนุญาต merge, deploy หรือแก้ข้อมูล Production
- Canonical main: `7d9a4007e78e560d482d8b0be07ee7a06a9e97fd` (fetch, main fast-forward check และสร้าง task branch แล้ว)
- Affected systems: OpenAI extraction, Vision retry และเครื่องมือเตรียมแผนกู้ Expense; ไม่มี schema หรือ Sheets mapping change
- Risk: Medium สำหรับ prompt/retry; High สำหรับการนำแผนกู้ไปใช้จริงซึ่งต้องอนุมัติแยก
- Mutation ในงานนี้: L0–L1 เท่านั้น; การกู้ข้อมูลจริงเป็น L3
- Out of scope: เปลี่ยนนโยบายบัญชี, เลือกบัตรแทนผู้ใช้, auto-finalize, automatic upgrade ของ order ที่ถูก hold, payroll, attendance, ลบหลักฐาน และ production release

## Root-cause gate

- OBSERVED: Production D1 พบ Online Order สองเอกสาร `WAITING_REVIEW`, `final_paid_satang=NULL`, ไม่มี Expense, document link หรือ Sheets sync ของเอกสารเหล่านั้น
- EXPECTED: รูปที่พิสูจน์การชำระแล้วและอ่านยอดรวมที่มี label รองรับได้ต้องสร้างเพียง `WAITING_CONFIRM`; ต้องยืนยัน source wallet ก่อนบันทึก
- REPRODUCTION: (1) ส่ง accepted order total กับ final paid คนละยอดเข้า normalizer; (2) ส่ง order total/label ว่าง แม้มี payment date; ทั้งคู่ไม่มี draft และจอง order ID แบบ `REVIEW_ONLY`
- ROOT_CAUSE: กรณีแรกมีหลักฐานยอดขัดกันและกรณีที่สองไม่มี accepted total ในผลสกัด จึงถูก validation ปฏิเสธตามกติกา; ไม่มี amount retry ก่อนเก็บ hold และ hold เดิมตั้งใจไม่ถูก upgrade ด้วยการส่งรูปซ้ำ ส่วน prompt เดิมยังไม่ระบุชัดว่าตัวเลขส่วนลดใต้ยอดรวมถูกหักในยอดรวมแล้ว
- AFFECTED_PATH: `vision/openai.ts` → `vision/service.ts` → `expense/document.ts` → `expense/service.ts` และ order identity claims
- DATA_IMPACT: หลักฐานและ item เดิมยังอยู่; ไม่มี finalized Expense ของสองรายการนี้ ไม่ต้อง reconcile Sheets เพื่อสร้างธุรกรรมใหม่

Production เก็บ normalized JSON ซึ่งล้าง final paid ที่ขัดกันแล้ว จึงพิสูจน์ค่าดิบที่โมเดลอ่านผิดไม่ได้ การหักส่วนลดซ้ำเป็น regression scenario ไม่ใช่ข้อสรุปว่าค่าดิบ Production เป็นตัวเลขใด

## Acceptance criteria

1. Prompt อ่านยอดรวมใน footer ที่ยุบอยู่และคัดลอกยอดหลังส่วนลดโดยไม่หัก discount/VIP ซ้ำ
2. Paid Online Order ที่มี order ID/วันที่จ่ายครบแต่ยอดหายหรือขัดกันอ่านซ้ำได้ไม่เกินหนึ่งครั้ง โดยนับ daily budget เช่นเดียวกับ attendance retry
3. รับ retry เฉพาะข้อมูลที่ผ่าน normalizer เดิมและตรงกับ order ID, วันที่, สกุลเงินและยอดรวมเดิมที่ทราบแล้ว; ห้ามใช้ retry ที่เปลี่ยนหลักฐานที่ทราบหรือยังขัดกัน
4. Order ที่ unpaid/pending/unknown, ข้อมูลชำระไม่ครบ หรือเกิน budget ยังคง fail closed
5. Hold เดิมไม่ถูก upgrade อัตโนมัติ; เตรียมแผนกู้เฉพาะเอกสารที่เจ้าของตรวจยอดแล้ว ใช้ snapshot guard และตรวจ active OWNER ใน D1 ภายใน batch
6. แผนกู้สร้างเพียง `WAITING_CONFIRM`, บังคับตรวจ payment/description/category, เก็บ audit, ใช้เอกสาร/item/order claim เดิม ไม่แก้ `ai_json` หรือ R2 และไม่สร้าง Sheets sync/notification
7. Retry/แผนซ้ำ, snapshot เปลี่ยน, owner ถูกถอนสิทธิ์ และ batch ล้มกลางทางต้องไม่สร้างธุรกรรมซ้ำหรือ side effect บางส่วน

Retry อาจเพิ่มหนึ่ง API call และเวลาไม่เกิน `VISION_TIMEOUT_MS` อีกหนึ่งรอบต่อรูปที่เข้าเงื่อนไข ใช้ `vision_openai_retry_ms` พร้อม label `kind` แยก Online Order จาก attendance; เมื่อ retry ไม่สำเร็จเก็บผลเดิมและใช้ notification recovery เดิม

## สร้างแผนกู้แบบ offline

หลัง `npm run build:test` ใช้ `node scripts/online-order-recovery-plan.mjs <private-manifest.json> <private-plan.json>`. คำสั่งนี้อ่าน/เขียนไฟล์ local เท่านั้น ไม่มี network หรือ apply mode และสร้างไฟล์ใหม่ด้วย permission `0600` โดยไม่เขียนทับไฟล์เดิม

Manifest ประกอบด้วย `document` snapshot จาก D1 (`document_id`, `document_type`, `status`, `expense_id`, `order_id`, `payment_date`, `currency`, `normalized_json`, `updated_at`, `final_paid_satang`, `paid_amount_satang`) และ `approval` (`ownerEmployeeId`, `finalPaidSatang`, `orderTotalLabel`, `reason`, `evidenceReviewed: true`). ผู้ตรวจต้องตรวจต้นฉบับจริงก่อนระบุ approval. สคริปต์ไม่พิมพ์ payload หรือ identity ใน stdout

Plan มี `batch` สำหรับ D1 และ `summary` สำหรับตรวจขอบเขต. ก่อน apply ต้องตรวจ schema ผ่าน migrations ปัจจุบันและ backup/rollback ตาม Production gate. การ apply ต้องใช้ `batch` ทั้งชุดใน transaction เดียว; ทุก write ผูกกับ approval audit และ snapshot guard. ห้ามแยก execute ราย statement หรือถือ HTTP 200 เป็นความสำเร็จ: SELECT สุดท้ายต้องได้หนึ่งแถว `WAITING_CONFIRM`, ยอดที่อนุมัติ, payment=`unconfirmed`, wallet=`UNCONFIRMED`, `sync_count=0`; หากไม่มีแถวให้หยุดและตรวจ snapshot/สิทธิ์ใหม่

กรณีหลาย seller, มากกว่าหนึ่งเอกสารของ order, claim ไม่ตรง หรือมีธุรกรรมยอด/วันเดียวกันของผู้ส่งอยู่แล้วจะไม่กู้ด้วยเครื่องมือนี้ ต้องตรวจธุรกรรมและหลักฐานแยกโดยเจ้าของ ห้ามลบข้อมูลเพื่อให้ guard ผ่าน

## UAT และ rollback

ผล local validation วันที่ 26 ตุลาคม 2026: `npm run check` ผ่าน (448 passed, 3 skipped), `npx wrangler deploy --dry-run` ผ่าน และ `git diff --check` ผ่าน. ใช้ mock API และ SQLite fixtures เท่านั้น ยังไม่มี live-image UAT, merge, deploy หรือ apply recovery ใน Production

ก่อน release ให้ทดสอบรูป paid order ที่ footer แสดงยอดหลังส่วนลด, รูปอ่านยอดไม่ครบ, รูป unpaid และการตอบ LINE ล้มเหลว ตรวจยอดกับต้นฉบับและตรวจว่าไม่มี Expense/Sheets จนยืนยันครบ

เครื่องมือแผนกู้เป็น offline planner เท่านั้น ต้องเก็บ manifest/plan นอก Git ในที่ private และอนุมัติ document, ยอด, actor และ snapshot แต่ละรายการก่อนใช้ batch กับ D1 หลังใช้ตรวจเอกสาร/item/case/claim/link/audit, Expense หนึ่งรายการและ Sheets sync ศูนย์ แล้วส่งรูปเดิมเพื่อกลับสู่การยืนยันปกติ

Rollback โค้ด: revert commit นี้หรือกลับ Worker version ที่ยืนยันก่อน release. แผนกู้ที่ยังไม่ใช้ไม่มีผลกับ Production; หากใช้แล้วต้องยกเลิก draft ผ่าน flow ที่มี audit ตามปกติ ห้ามลบเอกสาร, claims, items หรือ audit เพื่อย้อนกลับ
