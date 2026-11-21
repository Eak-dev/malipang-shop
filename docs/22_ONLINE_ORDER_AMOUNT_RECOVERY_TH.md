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

## กรณีต่อเนื่อง: อ่านยอดได้ แต่หลักฐานการชำระยังไม่ครบ (#204)

หัวข้อก่อนหน้านี้เป็นบันทึกก่อน release ของ PR #200; ผล release/recovery ที่เสร็จแล้วอยู่ใน Production Change #201. กรณีต่อเนื่องนี้เริ่มจาก canonical main `5b65b1c21ae7e824ef3d4c9fd9ed11d699a533bc` หลัง fetch/fast-forward และสร้าง branch แยกแล้ว ใช้ `DEV_OWNED` ตามสิทธิ์แก้โค้ด/ทดสอบเดิม; AUTO_RELEASE ครั้งก่อนระบุเฉพาะ PR #200 และสองรายการเดิม จึงยังไม่ครอบคลุมการ release หรือกู้รายการใหม่ครั้งนี้

- OBSERVED: Production ที่ยังเป็น Worker `666e079e-3c3d-4ade-921f-17e6664a0250` อ่าน order total 519 บาทและ label ได้ แต่ `paymentStatus=UNKNOWN` จึงได้ final paid ว่าง ไม่มี Expense และถือ claim `REVIEW_ONLY`. ภาพที่เจ้าของส่งมามีเฉพาะบรรทัดเวลาสั่งซื้อ; normalized extraction กลับใช้เวลานั้นเป็น PAYMENT. ข้อความตอบแจ้งว่าหายอดไม่พบ และ `needs_review=0`, `review_note` ว่างทั้งที่เอกสาร `WAITING_REVIEW`
- EXPECTED: คงยอดรวมที่อ่านได้ แยกสถานะจ่าย/วันจ่ายออกจากยอดที่อ่านไม่ออก บอกหลักฐานที่ยังขาด และไม่ใช้วันสั่งซื้อเป็นวันจ่าย
- REPRODUCTION: synthetic order มี accepted total 519, status UNKNOWN, final paid ว่างและ extractor review ว่าง → ไม่มี draft/retry แต่ได้เหตุผล Missing final paid amount. การ update metadata เขียนทับเหตุผล/flag ของ workflow ด้วยค่า false/ว่างจาก extraction
- ROOT_CAUSE: paid gate ทำงานถูกต้อง แต่ helper เหตุผลดูเฉพาะ final paid/date; prompt เดิมสั่งคัด purchase date ไป paymentDate และไม่มี printed date label ให้ตรวจความหมายซ้ำ. Metadata update ไม่รักษา review context ที่คำนวณแล้ว
- AFFECTED_PATH: purchase schema/prompt/normalizer → draft/hold diagnostics → document metadata และ LINE reply. ไม่เปลี่ยน Sheets, schema, credentials, payroll หรือ attendance
- DATA_IMPACT: ยังมีเพียงเอกสาร/สินค้า/claim ที่รอตรวจ ไม่พบ finalized Expense ของกรณีใหม่. เจ้าของยืนยันยอด 519 แล้ว แต่การยืนยันยอดอย่างเดียวไม่ให้วันที่ชำระและไม่อนุญาตให้เดาวันจากเวลาสั่งซื้อ

Acceptance และพฤติกรรมหลังแก้:

1. New extraction ต้องมี `paymentDateLabel` และแยก `ORDER_PLACED` ออกจาก `PAYMENT`. Online Order รับ date/time เฉพาะ label วันชำระที่รองรับ เช่น เวลาที่ชำระเงิน, วันที่ชำระเงิน, Payment date/time, Paid on/at; label วันสั่งซื้อ/ส่งของ ว่าง หรือไม่รู้จักทำให้ paymentDate/time ว่างแม้โมเดลระบุ purpose เป็น PAYMENT
2. Snapshots เดิมที่ไม่มี property `paymentDateLabel` ยังใช้กติกาเดิมได้ และการ normalize ซ้ำไม่เพิ่ม label ว่างที่ทำให้ข้อมูลเก่าใช้ไม่ได้. การเปลี่ยนนี้เป็น optional normalized JSON metadata ไม่ใช่ D1 migration
3. UNKNOWN/PENDING/UNPAID ไม่สร้าง draft หรือ amount retry แม้มี total. ข้อความภาษาไทยแสดงยอดรวมที่อ่านได้และหลักฐานจ่าย/วันที่ที่ยังขาด โดยไม่อ้างว่าอ่านยอดไม่ออกเมื่อ total มีอยู่
4. REVIEW_ONLY ที่ส่งซ้ำบอกว่ายังรอตรวจและยังไม่มี Expense จากรายการนั้น ไม่สร้างเอกสาร/ธุรกรรมใหม่หรือ auto-upgrade แม้รูปถัดไปจ่ายครบ. ข้อความไม่เปิดเผย order ID, ข้อมูลผู้ส่ง หรือยอดจากเอกสารของผู้อื่น
5. Document workflow เป็นผู้คง `needs_review`/`review_note` สำหรับ hold, linked evidence และ draft review; `ai_json`, item facts/IDs, claims และ audit เดิมไม่ถูกเปลี่ยนเพื่อแก้ข้อความ
6. Generic card ต้องเลือกแหล่งเงินตามเดิม; complete paid evidence ยังเปิด normal confirmation เท่านั้น. LINE failure คิวได้เฉพาะ notification และไม่ replay ธุรกรรม

Risk: Medium สำหรับ extraction/diagnostics, L0–L1 ในงานพัฒนา. Label ที่ไม่รู้จักจะถูก hold แทนการเดา. ไม่ทำ automated recovery, ไม่ infer paid/date จากชื่อบัตร ปุ่มขอคืนเงิน/ติดตาม หรือคำยืนยันราคา และไม่บันทึก finalized Expense

Validation: `tests/online-order-payment-evidence.test.mjs` ใช้ synthetic data และ SQLite จริงสำหรับ date provenance, backward compatibility, known total/unknown status, workflow metadata, failed reply และ repeated paid image. ต้องผ่าน `npm run check` และ `npx wrangler deploy --dry-run` ก่อน release; live UAT/Production recovery ของกรณีใหม่นี้ต้องอยู่ใน approval แยกตาม exact commit

ผล local validation ของ #204: focused suites ผ่าน 66 tests; `npm run check` ผ่าน 457, skipped 3 live suites, failed 0; `npx wrangler deploy --dry-run` และ `git diff --check` ผ่าน. ยังไม่มี live OpenAI UAT, Production deployment หรือแก้เอกสารใหม่ในขั้น DEV_OWNED

Manual UAT หลังได้รับอนุญาต: ทดสอบภาพที่เห็นเพียงเวลาสั่งซื้อ → total คงเดิม แต่ payment date/time ไม่ถูกแต่งและยัง hold; ทดสอบภาพที่เห็น paid status กับ payment-date label จริง → WAITING_CONFIRM และต้องเลือกบัตร. ตรวจข้อความ hold/repeat, metadata review, no duplicate และ no Sheets job ก่อนยืนยัน. การกู้ hold เดิมต้องตรวจหลักฐานวันจ่ายและได้รับอนุมัติแบบระบุรายการ/ยอด/วันจริงก่อน ไม่ใช้เวลาสั่งซื้อที่โมเดลเคยใส่ผิด

Rollback: revert focused change; หลัง release ที่ได้รับอนุญาตให้กลับเวอร์ชันที่บันทึกไว้ก่อน release. ไม่มี schema/data migration หรือการแก้เอกสารเก่าใน PR นี้
