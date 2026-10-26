# Online Order: ยอดรวมที่จ่ายแล้วและการพักตรวจ

งาน #202 — DEV_OWNED (โค้ด/ทดสอบ/PR เท่านั้น ไม่ใช่การอนุมัติ deploy)
Base: `7d9a4007e78e560d482d8b0be07ee7a06a9e97fd`.

## หลักฐานและสาเหตุ

พบเอกสารชำระแล้วสองกรณี: กรณีแรกมี accepted order total แต่ final-paid evidence
ขัดแย้งกัน; อีกกรณีไม่มี accepted total เหลือหลัง normalization ทั้งคู่ไม่มี Expense
และถูกพัก `WAITING_REVIEW`. ก่อนแก้ feedback ใช้ข้อความยอดหายแม้รู้ว่าเป็น conflict.
เส้นทางเดิมไม่มี bounded reread สำหรับ Online Order และไม่ได้เก็บ failure class
ที่แยก missing/invalid/payment-unconfirmed. ข้อมูลเดิมเก็บ document หลัง normalize
จึงพิสูจน์ไม่ได้ว่าค่าดิบของกรณีหลังหายตั้งแต่ model หรือถูก label guard ตัดทิ้ง.
การหัก VIP ซ้ำเป็นความเสี่ยงที่ prompt ต้องป้องกัน ไม่ใช่ข้อสรุปว่าข้อมูลดิบเก่าคำนวณเช่นนั้นแน่นอน.

## พฤติกรรมใหม่

- คัดลอกยอดตามป้ายรวมคำสั่งซื้อที่อนุญาตและมีหลักฐานว่าจ่ายแล้ว ไม่หัก VIP/voucher
  ซ้ำ ไม่คูณราคาสินค้าแทนยอดจริง ไม่เดาค่าที่ไม่เห็น.
- รับรูปแบบ Unicode ที่มีความหมายเหมือนกันและ colon/spacing ของป้ายเดิมเท่านั้น;
  ไม่ใช้ fuzzy matching และไม่เพิ่มป้าย subtotal/expected delivery เข้า allowlist.
- เพิ่ม metadata `onlineOrderAmountIssue` ที่ derive ใน TypeScript ไม่เชื่อค่าจาก AI:
  `MISSING_TOTAL`, `INVALID_TOTAL`, `CONFLICT`, `PAYMENT_UNCONFIRMED`.
  เหตุผลถูกเก็บใน private document และ reply ระบุสาเหตุภาษาไทย ไม่เหมารวมว่ายอดหาย.
- อ่านเพิ่มได้หนึ่งครั้งเฉพาะ **ไม่มี amount evidence ทั้งสองช่อง** และมี order ID,
  seller, วันที่จ่าย, PAID, THB และ confidence ผ่าน. Invalid/conflict/unpaid/legacy
  ไม่ใช้ทางนี้. เกิดก่อน persistence ครั้งแรก ไม่ใช่ replay เอกสารที่เคยบันทึกแล้ว.
- Retry ใช้ original image และคำสั่งอ่านยอดโดยเฉพาะ มี daily guard และ timeout เดิม.
  ใช้ usage metric เดิม (รวม admin override เดิม). อาจเพิ่มได้ไม่เกินหนึ่ง API call
  และหนึ่ง `VISION_TIMEOUT_MS` ต่อภาพที่เข้าเกณฑ์; ไม่มีการเปลี่ยน model หรือ key.
- ยอมรับผลใหม่เฉพาะ order ID แบบ exact trimmed, seller, seller grouping, วันที่/เวลา
  จ่าย และ currency ตรงกัน และ total/final-paid/label ผ่าน guard โดยไม่มี uncertainty.
  เติมเฉพาะ amount/label; คง items, discount, date, source wallet และข้อมูลเดิมอื่น.
- ผล recovered ยังต้องตรวจรายการ/หมวดและเลือกแหล่งเงิน ไม่ auto-confirm.
  ถ้าล้มเหลว, หมดงบ หรือผลไม่ตรง เก็บผลแรกและพักตรวจต่อ. Metric ใหม่
  `vision_online_order_amount_retry_ms` มีเฉพาะ provider/outcome ไม่มี payload/error body.

## ขอบเขตและความเสี่ยง

High: เกี่ยวกับยอดเงิน แต่ไม่มี migration/config/dependency/secret change.
ไม่แตะ payroll, attendance semantics, Sheets formulas หรือ confirmation/idempotency.
การเพิ่ม prompt และ mocked tests ไม่พิสูจน์ว่า model จะอ่านภาพจริงถูกทุกครั้ง.
ต้องทดสอบ private images แบบอนุมัติแยกก่อน release; ไม่มี live model call ในงานนี้.

`REVIEW_ONLY` order claim เดิมยังไม่ถูก auto-upgrade แม้ส่งภาพใหม่หรืออ่านได้ดีขึ้น.
อย่าให้เจ้าของส่งรูปเดิมวนซ้ำเพื่อ recovery. การแก้เอกสารค้างต้องเป็นงานแยกที่ระบุ
document/order, ตรวจ original evidence/ยอด/บัตร, สำรองข้อมูล, มี audit/CAS/idempotency
และ approval; ห้ามลบ claim, สร้างรายจ่ายคู่ขนาน หรือแก้ immutable evidence ทับ.

## ทดสอบและ UAT

Local: `npm run check`, `npx wrangler deploy --dry-run`, `git diff --check`.
เฉพาะ regression: `npm run build:test` แล้ว
`node --test tests/online-order-amount.test.mjs tests/openai-vision.test.mjs tests/vision-retry.test.mjs`.
ใช้ synthetic fixtures และ real SQLite ใน memory ไม่มี secrets/รูป/เลขออเดอร์จริงใน repo.

ก่อน release ที่ได้รับอนุมัติ:

1. ตรวจภาพ paid order ที่มี VIP savings: ยอดใน draft เท่าป้าย total ไม่ลดซ้ำ.
2. ตรวจภาพ missing-total กับ reread ที่อ่านครบ: ต้องเป็น order/seller/date/time เดิม;
   ความต่างหรือไม่ชัดเจนต้อง hold. ตรวจ cost/latency และ LINE notification fallback.
3. Contradictory total, subtotal, unpaid, missing payment date และ foreign currency
   ต้องไม่ถูก recovery; ไม่ใช้ retry ข้าม guard.
4. เลือกแหล่งเงินจริงก่อนยืนยัน ตรวจ D1/Sheets รายการเดียว, ไม่ซ้ำเมื่อ redelivery,
   LINE failure ไม่ย้อนกลับไปสร้างธุรกรรมหรือ OCR ซ้ำ.
5. เอกสาร REVIEW_ONLY เดิมและ multi-seller ยังพักตรวจ ไม่ถูกยกระดับด้วย release นี้.

Rollback: revert commit/Worker version หลังได้รับอนุมัติ release ตาม runbook เดิม;
ไม่ drop schema, ลบ R2, ยกเลิก claims หรือ rewrite historical records.
เก็บเอกสารและ audit ไว้ แล้วตรวจ lost/duplicate และผลข้างเคียงอีกครั้ง.
