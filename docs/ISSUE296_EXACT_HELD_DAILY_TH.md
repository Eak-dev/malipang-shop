# ตรวจผล DAILY ของรายการค้าง #296

**ขอบเขต** งานซิงก์เดิมอยู่ใน REVIEW หลังการส่ง insert ที่มี marker และ journal สถานะ IN_FLIGHT ส่วน failed job เดิมยัง OPEN การอ่าน grid ของ writer รุ่นเดิมรองรับการเพิ่มหนึ่งแถว หลักฐานจำลองสร้างกรณีเพิ่มสองแถวเมื่อมี padding ได้ สาเหตุของผลอ่านแต่แรกใน Production และสถานะปัจจุบันต้องตรวจสด เป้าหมายขั้นนี้คือยืนยันผลที่เขียนไปแล้ว ตรวจสูตร ค่า รายการและยอดที่ D1 คาดไว้ กริดก่อน insert ที่สร้างย้อนจาก postimage แถวว่างท้ายสุด รูปแบบตัวเลขของรายการ notice และรายงาน

**ขั้นตรวจปกติ** เรียก POST /admin/stable-sync/exact-daily-settlement ด้วย admin authorization และ x-malipang-expected-worker-version ที่ได้จากการตรวจ version ที่รับ traffic ทั้งหมด ณ เวลานั้น เปิด EXACT_DAILY_SETTLEMENT_ENABLED เฉพาะขั้นตอนนี้ ส่ง JSON ตามลำดับต่อไปนี้

1. ส่ง `{"action":"INSPECT"}` เพื่ออ่าน fingerprint ของ incident ที่ตรงเงื่อนไขเพียงหนึ่งรายการ ค่า projectionState คือ IN_FLIGHT หรือ VERIFIED หากได้รับ VERIFIED ให้ตรวจ preimageDigest เทียบผล PROBE ที่เก็บไว้
2. ส่ง `{"action":"PROBE","fingerprint":"<hash จาก INSPECT>"}` ต้องได้ MATCHED พร้อม preimageDigest รักษารั้วผู้เขียนตลอดการตรวจ การอ่านซ้ำช่วยตรวจการเปลี่ยนระหว่างรอบ ขอบเขตหลักฐาน DAILY ครอบคลุมสูตร ค่าและรูปแบบตัวเลขที่ระบุ การตรวจนี้ไม่ได้เก็บ notes, validation, protection หรือ comment anchor ของทั้ง grid
3. ก่อน SETTLE ยืนยันสิทธิ์และ gate การเปลี่ยน Production ตาม AGENTS.md ใช้ version ที่รับ traffic ทั้งหมด เปิด STABLE_RECOVERY_GATE_ENABLED ปิด monthly operator และ normal auto-arm และตรวจการสิ้นสุด invocation เดิม ตรวจการพักผู้เขียนภายนอกและผู้ดูแลที่เฝ้าดูในขณะนั้นอีกครั้ง หลังเปลี่ยน Worker ให้ทำ INSPECT และ PROBE สด
4. ส่ง `{"action":"SETTLE","fingerprint":"<hash>","preimageDigest":"<hash จาก PROBE>","externalWritersFenced":true,"ownerSupervising":true}` ตัวดำเนินการตรวจ Google ใหม่ทั้งหมดก่อนบันทึก journal VERIFIED และ preimage ใน D1 transaction เดียว โดยตรวจ exact failed job/claim/source revision และสถานะเดิมภายใน UPDATE
5. ตรวจ INSPECT อีกครั้ง ต้องได้ fingerprint และ preimageDigest ตรงกับ PROBE ตรวจว่า synced job กับ claim เดิมยัง REVIEW, failed job ยัง OPEN, ไม่มี epoch ที่ active, ไม่มีการเพิ่มธุรกรรมหรือเปลี่ยน notice จากขั้นตอนนี้ หากได้รับ UNCERTAIN หรือไม่ได้คำตอบ ให้ตรวจด้วย INSPECT อย่างเดียวและคง gate ต่อไป อย่าส่ง SETTLE ซ้ำจากผลที่ไม่ชัดเจน

**ทดสอบและกู้ต่อ** กรณีจำลองใช้ Miniflare D1 ตรวจผลรับ ACK, ACK หายหลัง commit, rollback ภายใน batch, failed job เปลี่ยนก่อน CAS และการส่งคำขอเก่าหลัง VERIFIED หลังบันทึกให้คง journal และ preimage ซึ่งย้อนค่าไม่ได้ตาม trigger หากขั้นตอนถัดไปยังไม่พร้อม ให้คง claim และงานเดิมใน REVIEW และปิด operator เพื่อระงับการเรียกเพิ่มเติม การย้าย claim, ปล่อย notice และอนุญาตงานทดสอบตัวถัดไปต้องมีหลักฐานและการตรวจผลแยกต่างหาก

## PROBE แบบอ่านอย่างเดียวด้วยสำเนาหลังเหตุ

ผู้จัดเตรียมหลักฐานตรวจเหตุการณ์คัดลอกใน Drive Activity และ `files.version` จาก Drive ก่อนและหลังอ่านกริด ใช้ `prepareHistoricalDailyReceipt` ตรวจกริดเต็มและส่วนต่างที่ตกลงกัน แล้วเตรียม JSON ที่มี `receipt` และ SHA-256 ของแถวที่ตรวจใน `preimageDigest`. เก็บ JSON ใน GitHub Environment `production` ชื่อ `MALIPANG_HISTORICAL_DAILY_PROBE`. ใบรับมีเฉพาะ SHA-256 ห้าค่า.

1. ให้ #296 ระบุ SHA บน `main`, ขอบเขตเหตุเดียว และสิทธิ์สำหรับแต่ละรัน. ใช้ workflow Production release เลือก `historical_daily_probe=true` ตอน `preflight` และ `deploy`. ตัวรันสร้างค่า `EXACT_DAILY_HISTORICAL_RECEIPT_SHA256` จากใบรับและส่งเฉพาะค่านี้ให้ Worker. เมื่อมี migration ค้างหรือค่า config อื่นต่างจาก Production จะหยุด. Rollback ใช้ `rollback_worker` กับ run ID ที่บันทึกรุ่นก่อนหน้า.
2. เมื่อ Worker รุ่นที่อนุมัติรับทราฟฟิก 100% ให้รัน `prod-historical-daily-probe.yml` ผ่าน Environment `production` บน SHA เดิม โดยระบุ hash ของ Worker และยืนยันว่าหยุดผู้เขียนภายนอกกับมีเจ้าของเฝ้าดู. ตัวรันส่ง `PROBE` พร้อมใบรับหนึ่งครั้ง แล้วเทียบ fingerprint, receipt digest, preimage digest และรุ่น Worker. ตรวจ deployment ซ้ำก่อนรายงาน `MATCHED`.
3. Worker ค้นเหตุเดิมใน D1 แล้วตรวจกริดหลัก, source, carrier, บัญชี, รายงาน, รูปแบบตัวเลขและ notice ซ้ำ. เมื่อกำหนด pin แล้ว endpoint รับเฉพาะ `PROBE` ที่มีใบรับตรงกัน. หากหลักฐานไม่ตรงหรือผลไม่ชัด ให้คง claim เดิมและหยุดเพื่อทบทวน. การบันทึกผลใช้คำอนุมัติแยก.

เมื่อผลยืนยันไม่ได้ log แสดง `PROBE_RESULT_UNVERIFIED` พร้อม HTTP status ถ้าได้รับคำตอบ. สำหรับ HTTP 409 ที่ Worker ตอบ `HELD` จะรายงานชื่อขั้นตรวจที่อยู่ในรายการอนุญาต เช่น `HTTP_409 STAGE_NOTICE`. ข้อมูลใน response ใช้ตรวจในหน่วยความจำ และคำขอคงส่งครั้งเดียว.
