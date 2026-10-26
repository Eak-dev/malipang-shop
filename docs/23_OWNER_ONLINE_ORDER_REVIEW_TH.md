# Owner Online Order review — Issue #208

สถานะ: งาน `DEV_OWNED` บน base `b958ae04e40ba44c3574af9128775d53686555a6` รอ PR review และอนุมัติ release พร้อม migration `0020_owner_online_order_review.sql` ก่อนใช้ใน Production

## ปัญหาและสาเหตุ

- **OBSERVED:** ภาพคำสั่งซื้อที่มียอดสุดท้ายถูกเก็บ `WAITING_REVIEW` ซ้ำ และผู้ใช้ตอบเพียงยอดเงินเมื่อระบบต้องการวันชำระ
- **EXPECTED:** แสดงยอดที่อ่านได้ ถามเฉพาะข้อมูลที่ขาด และให้เจ้าของทำรายการเดิมต่อจนยืนยันรายละเอียดครบ
- **REPRODUCTION:** ภาพจริง 519 บาทมี `รวมคำสั่งซื้อ` และเวลาสั่งซื้อ แต่ไม่เห็นวันชำระจริง การอ่านต่างรอบเคยให้ทั้ง `PAID` และ `UNKNOWN`; ทั้งสองกรณีต้องไม่ใช้เวลาสั่งซื้อเป็นวันชำระ
- **ROOT_CAUSE:** เดิมไม่มีทางให้เจ้าของเติมข้อมูลของ held document ผ่าน LINE การแก้ allowlist ยอด/ข้อความอธิบายเพียงอย่างเดียวจึงยังทำให้ภาพที่ขาดหลักฐานการชำระค้างอยู่ ข้อจำกัดของภาพและความแปรผันของ AI เป็นคนละชั้นกับช่องว่างของ workflow
- **AFFECTED_PATH:** OpenAI normalization → retained Online Order/identity claim → owner LINE review → existing Expense confirmation → Sheets outbox
- **DATA_IMPACT:** ภาพและรายการสินค้าเดิมยังอยู่; เอกสารค้างไม่ใช่ค่าใช้จ่ายที่บันทึกแล้ว การเปลี่ยนนี้ไม่ backfill หรือกู้รายการเก่าเป็นชุด และไม่แก้สามรายการที่เคยกู้และยืนยันแล้ว

## การใช้งาน

1. เจ้าของที่มี verified LINE binding, active organization OWNER role และสิทธิ์ส่งค่าใช้จ่าย พิมพ์ `รายการค้าง` ในแชตส่วนตัว (`ตรวจรายการค้าง`, `ค่าใช้จ่ายค้าง`, `/expense-review` ใช้ได้เช่นกัน)
2. เปิดกรณีเดิม ระบบแสดงยอด สถานะ และวันที่ พร้อมที่มา `อ่านจากภาพ`, `เจ้าของยืนยัน` หรือ `ยังไม่มีข้อมูลยืนยัน` ถ้ายอดรวมหลังส่วนลดชัดเจนจะไม่ถามยอดซ้ำ
3. ยืนยันว่าชำระจริงแล้ว เลือกวันที่จาก datepicker หรือเลือกพิมพ์วันชำระ; กรอกยอดเฉพาะเมื่อขาด/ขัดกัน หรือเจ้าของเลือกแก้ยอดโดยตรง การพิมพ์ `519 บาท` ในช่องวันที่จะได้รับคำอธิบายและไม่สร้างรายการใหม่
4. วันที่พิมพ์รองรับ `25/10/2569`, `25/10/2026`, `2026-10-25` และ `25/10/69` โดยแสดงปีเต็มให้ตรวจอีกครั้ง ปีสองหลัก 50–99 เป็น พ.ศ. 25xx ส่วน 00–49 เป็น ค.ศ. 20xx ไม่ยอมรับวันในอนาคตหรือวันไม่มีจริง
5. ตรวจข้อมูลแล้วกด `ตรวจแล้ว ทำต่อ` ได้เพียง pending Expense จากนั้นยังต้องยืนยันรายการ หมวดหมู่ และบัตร/แหล่งเงินผ่าน flow เดิม เมื่อ field สุดท้ายครบจึง `CONFIRMED` และสร้าง Sheets job หนึ่งครั้ง

ช่องพิมพ์เจาะจงกรณี/field/revision อายุ 15 นาที เจ้าของมีเป้าหมายกรอกได้หนึ่งรายการ สลับกรณีหรือไปแก้ Expense draft จะยกเลิกเป้าหมายเดิม คำว่า `ยกเลิก` ยกเลิกการกรอก ไม่ลบหลักฐาน คำสั่ง HR/payroll/personal เดิมยังใช้ router เดิม

กรณีเจ้าของตรวจหลักฐานที่พนักงานส่ง pending Expense จะอยู่ใน LINE ของเจ้าของผู้ตรวจเพื่อทำขั้นยืนยันต่อได้ ส่วน `submitted_by_employee_id`, branch และข้อมูลผู้ส่งในเอกสารเดิมยังคงเดิม

## ข้อมูลและความปลอดภัย

- `expense_document_reviews` แยก owner facts (ค่า/ที่มา/ผู้ยืนยัน/เวลา), extraction attempts, reason codes และ revision ออกจากภาพ
- `expense_document_review_inputs` เก็บเป้าหมายกรอกชั่วคราว ทุกการขอกรอก/ยืนยัน/อนุมัติสร้าง audit การแก้ข้อมูลใช้ optimistic concurrency และตรวจสิทธิ์ปัจจุบันใน transaction อีกครั้ง
- ก่อน continue ค่า `normalized_json` ยังเป็น extraction เดิม เมื่ออนุมัติจึงเก็บผลที่ใช้ทำงานพร้อม `ownerPaymentReview` และ `imagePaymentEvidence`; `ai_json`, R2 key/hash และเนื้อหา line items ไม่ถูกเขียนทับ
- คำยืนยันวันที่ไม่ถูกปลอมเป็น printed payment label และไม่เดาเวลาชำระ เมื่อเจ้าของให้วันชำระเองจะไม่เก็บเวลาเก่าที่ไม่มีหลักฐานรองรับ
- Promotion ใช้ Workers `DB.batch` transaction เดียว เช็ก snapshot เอกสาร/ผู้ส่ง/รายการสินค้า/case, identity claims, Expense/link เดิม, duplicate candidate และสิทธิ์เจ้าของ ก่อนสร้าง audit/Expense/links/claims พร้อมกัน การ fail กลาง batch ต้อง rollback ทั้งหมด
- กดปุ่มเก่าใช้ revision guard กด continue ซ้ำกลับไป draft เดิม LINE Reply ล้มเหลวเข้า notification outbox เดิมและไม่ replay ธุรกรรม
- Employee/manager/unknown user/group chat ใช้เมนูนี้ไม่ได้ ไม่เพิ่มสิทธิ์ให้ role อื่น
- ไม่เปิด self-service สำหรับเลขคำสั่งซื้อหาย หลาย seller, case/items ไม่ครบ, identity conflict หรือรายการอาจซ้ำ ต้องตรวจแยกตาม [recovery runbook](22_ONLINE_ORDER_AMOUNT_RECOVERY_TH.md) ไม่มีปุ่ม bypass

## การติดตาม

`GET /admin/expenses/review-summary` อยู่หลัง admin authorization เดิม แสดงจำนวน `total`, `actionable`, `blocked`, `oldestAgeHours`, `reasons` และ `extraction` (attempts/retry/status disagreement) เฉพาะ Online Orders ที่ยัง `WAITING_REVIEW` คำสั่ง `รายการค้าง` แสดงสรุปเดียวกันสำหรับเจ้าของและแบ่งหน้าละ 8 กรณี

Reason codes แยก `AMOUNT_MISSING`, `AMOUNT_CONFLICT`, `PAYMENT_UNVERIFIED`, `PAYMENT_PENDING`, `PAYMENT_UNPAID`, `PAYMENT_DATE_MISSING`, `ORDER_ID_MISSING`, `ORDER_ALREADY_OWNED`, `ORDER_IDENTITY_CONFLICT`, `MULTIPLE_SELLERS`, `EVIDENCE_INCOMPLETE`, `POSSIBLE_DUPLICATE` จำนวนต่อเหตุผลซ้อนกันได้ รายการที่อาจซ้ำคำนวณจากสถานะปัจจุบัน ไม่ทิ้ง flag ถาวรเมื่อ Expense ที่ขัดกันถูกยกเลิก

Extraction attempts ใหม่เก็บเฉพาะ model/prompt version, ยอด/label/วัน/สถานะก่อน normalization และผลหลัง normalization ไม่เก็บ raw provider response ในตารางใหม่นี้ เอกสารเก่าไม่มี attempt history ย้อนหลัง ระบบไม่เรียก AI เพื่อเติมประวัติให้เอง Admin aggregate ไม่คืนตัวตน เลขเอกสาร ข้อมูลภาพ หรือ evidence key

Scope duplicate สำหรับ admin aggregate ใช้ผู้ส่งเดิม ส่วนหน้าของเจ้าของตรวจเพิ่มกับรายการของเจ้าของผู้ตรวจด้วย เหมือน guard ตอนสร้าง draft; ตัวเลข blocked สำหรับเจ้าของต่างรายจึงอาจต่างจาก admin aggregate ได้

## Validation และ UAT

Automated suites: `owner-online-order-review.test.mjs`, `owner-online-order-router.test.mjs`, `vision-online-order-retry.test.mjs` และ regression เดิม ครอบคลุม owner authorization/revocation, field targeting, stale cards, expiry, amount/date parsing, raw evidence preservation, duplicate/concurrency/replay, failure ทุก statement, failed Reply recovery และ normal final confirmation/Sheets boundary

ภาพจริงเก็บนอก Git ใช้ manifest deidentified จาก read-only live OpenAI extraction ผ่านคีย์เดิม โดย Production DB ถูกแทนด้วย in-memory usage/metrics adapter ใน test endpoint จากนั้น replay ขั้นตอน LINE กับ SQLite และ mock LINE/Sheets จนจบ ไม่ส่งข้อความหรือสร้างธุรกรรมจริงในการทดสอบนี้:

```bash
ONLINE_ORDER_PRIVATE_FIXTURES=/absolute/private/real-image-fixtures.private.json npm run test:online-order-images
```

ถ้าไม่มี manifest ชุดภาพจริงจะ skip โดยชัดเจน; ห้ามอ้างว่าผ่านจากการ skip

ผลทดสอบ 27/10/2026: ภาพ 622/462 บาทอ่านยอดจาก footer รวมส่วนลดได้ ไม่หัก VIP ซ้ำ วันชำระจากภาพยังตรง; ภาพ 519 บาทอ่านยอดได้แต่ไม่เห็นวันชำระ จึงค้างจนเจ้าของยืนยันวัน 25/10/2569 แล้วทำต่อได้ ภาพจริงทั้งสามผ่าน end-to-end 3/3 รวม resend และ simulated Reply 503 เฉพาะกรณี held; การอ่านใช้ 3 API calls, Production business/LINE/Sheets writes = 0, scoped records ก่อน/หลังตรงกัน, temporary override ถูกถอดแล้ว (health 200/admin unauthorized 401/removed endpoint 404)

Manual UAT หลังอนุมัติ release: ใช้เจ้าของที่อนุมัติและกรณีทดสอบที่กำหนด เปิด `รายการค้าง` → ตรวจ source labels → กรอกผิดประเภท → เลือกวันจริง → continue → ตรวจรายละเอียด/หมวด/บัตร → ตรวจ D1/Sheets หนึ่งรายการ → กดปุ่มเดิม/ส่งภาพเดิมซ้ำ → ตรวจหนึ่งธุรกรรมและ notification recovery แยก ห้ามใช้รายการจริงที่เคยยืนยันแล้วเป็นธุรกรรมทดสอบซ้ำ

## Release และ rollback

Risk **High**: expense lifecycle/owner authorization/new schema. `L0` local tests, `L1` branch/PR; limited read-only external UAT ตามขอบเขตที่เจ้าของอนุญาต ส่วน merge/permanent release และ migration เป็นการอนุมัติขั้นถัดไป ไม่รวม historical business-data recovery, accounting policy, attendance/payroll, secrets, webhook, queue/DO topology หรือ dependency changes

Migration `0020` สร้าง 2 ตารางและ indexes แบบ additive `IF NOT EXISTS` ไม่มี backfill ทดสอบ clean DB และ restore จาก private Production-shaped backup (95 schema objects/12 scoped data tables), apply สองครั้ง, integrity/FK และ existing rows unchanged แล้ว ก่อน remote migration ยังต้องสร้าง fresh private backup/checksum/restore และบันทึก counts อีกครั้งตาม AGENTS.md

Release: exact approved PR head/merged SHA → CI/check/dry-run → fresh backup/restore gate → migration ก่อนโค้ด → preserved bindings/settings → health/readiness → reason summary/auth → reconciliation (new unexplained LOST/DUPLICATE/failed jobs = 0) ไม่เปิด migration ระหว่าง ordinary requests ที่ใช้โค้ดใหม่ก่อนตารางพร้อม

Rollback: deploy baseline Worker version ที่บันทึกก่อน release กลับ โดยคงตารางใหม่และ audit ไว้ ไม่ DROP ตาราง ไม่ undo Expense ที่เจ้าของยืนยันแล้ว baseline สามารถอ่าน Expense/documents ที่ถูก promote แล้วผ่าน normal flow ได้ การแก้ข้อมูลหลังมีผู้ใช้งานต้องทำ forward-fix แบบเจาะจงพร้อมอนุมัติ ไม่ restore ทับธุรกรรมใหม่ หากจำเป็นต้องหยุด expense ทั้งระบบให้ขออนุมัติ operational change แยก
