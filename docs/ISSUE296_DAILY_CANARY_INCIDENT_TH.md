# การกู้ Canary รายวันที่เขียนแล้วและมีแถวว่างเกินหนึ่งแถว

เครื่องมือนี้จำกัดเฉพาะ Canary ยอดหนึ่งบาทที่มีหลักฐาน `canary_unwritten_recovery` เดิมเป็น `COMPLETE`, claim `REVIEW / OPERATION` เหตุ `INSERT_DAILY_SNAPSHOT_UNVERIFIED`, journal รายวันและ marker ที่ตรงกัน และ epoch เป้าหมายเดียว ห้ามใช้เป็นเครื่องมือกู้รายการทั่วไป ระบบไม่เปิด notice dispatcher หรือ review close ทั่วไป

ก่อนใช้ต้องมี backup ส่วนตัวที่ตรวจ restore/integrity/foreign keys ผ่าน ตรวจ Worker, D1, ชีตและรายงานปัจจุบัน ยืนยันว่าไม่มีผู้เขียนภายนอกและเจ้าของเฝ้าดูจริง ใช้ workflow `prod-canary-daily-incident.yml` บน main ผ่าน production environment และปัก SHA กับ Worker version เท่านั้น หนึ่ง run ต่อหนึ่ง phase:

1. `VERIFY`: ตรวจ snapshot และ digest ก่อน/หลัง, source, notice, รายงาน, งบและ format แล้วบันทึกเฉพาะ journal/preimage ที่พิสูจน์ว่าลงชีตแล้ว ไม่ส่งรายการซ้ำ
2. `TIME`: บันทึก intent และเปลี่ยนเวลา notice แบบมี preimage guard; `TIME_READBACK` อ่านยืนยันและบันทึกผลโดยไม่ส่งซ้ำ
3. `STATUS`: บันทึก intent ก่อนเปลี่ยนสถานะ notice และต้องได้คำตอบบวกจาก provider จึงบันทึก `STATUS_ACKED`
4. `COMMIT`: ตรวจหลักฐานซ้ำ แล้วบันทึกสถานะงานและปล่อยเฉพาะ claim ที่ตรงกันใน transaction จากนั้นอ่านสถานะ D1 และ provider กลับ

หาก `STATUS` หยุดก่อนส่งและ durable state ยังเป็น `TIME_VERIFIED` ใช้ `PROBE_STATUS` แบบอ่านอย่างเดียวเพื่อตรวจขั้น preflight พร้อมขีดจำกัดคำขอเดียวกัน ผลแสดงเฉพาะชื่อขั้นและจำนวนคำขอที่เหลือ การผ่านไม่ใช่สิทธิ์ให้ส่งคำสั่งที่ผลยังไม่แน่ชัดซ้ำ

ถ้าคำตอบหาย ขัดแย้ง หรือขั้นใดไม่ผ่าน ให้หยุดและอ่าน durable state กับ provider ก่อน ห้าม dispatch phase ที่อาจส่งคำสั่งซ้ำ ความไม่มีข้อมูลอย่างเดียวไม่พิสูจน์ว่า provider ไม่ได้รับคำสั่ง การกู้ projection ไม่ใช่หลักฐานว่า Canary ผ่าน ต้องทดสอบรายงาน รายการซ้ำ และ Undo ตาม runbook เดิมก่อนปลด gate

### D1 ปฏิเสธการบันทึก STATUS ก่อนส่งไป Google

- OBSERVED: หลัง TIME ผ่าน การเริ่ม STATUS ไม่ผ่านและไม่มี attempt หรือคำขอ STATUS ถูกบันทึกไว้; claim และงานยังอยู่ใน REVIEW.
- EXPECTED: ตรวจสถานะปัจจุบันตามเงื่อนไขเดิม บันทึก attempt แล้วจึงส่ง STATUS ได้ครั้งเดียว และ COMMIT ต่อได้เมื่อมีหลักฐานตอบรับ.
- REPRODUCTION / ROOT_CAUSE: บน Cloudflare D1 เงื่อนไข `GLOB` ที่มีข้อความไทยยาวใน trigger และคำสั่ง COMMIT เกินขีดจำกัด pattern; runtime จำลองให้ `LIKE or GLOB pattern too complex` เช่นเดียวกับ D1. SQLite ในชุดทดสอบปกติไม่เปิดเผยข้อจำกัดนี้.
- AFFECTED_PATH / DATA_IMPACT: trigger `continuous_notice_status_attempt_insert` และการตรวจ prefix ใน notice-close COMMIT; ความล้มเหลวเกิดก่อน dispatch STATUS และไม่มีการเขียนรายการธุรกิจเพิ่มเติมจากขั้นนี้.
- FIX: migration 0064 เปลี่ยนเฉพาะการตรวจ literal prefix ให้เป็น `substr` โดยคงเงื่อนไขอื่นทั้งหมด และแก้ COMMIT ใน Worker เช่นเดียวกัน. เทสต์รัน STATUS และ COMMIT ผ่าน Miniflare D1 และตรวจความเทียบเท่าของ prefix รวมทั้งค่า null. Migration สร้าง trigger เดิมใหม่จึงรันซ้ำได้; ก่อน Production ต้องสำรองส่วนตัวและซ้อม migration บนสำเนาที่ restore แล้ว. หากพบปัญหาให้คง gate และ claim ไว้ ตรวจหลักฐานก่อนแก้ไปข้างหน้า; ห้ามส่ง STATUS ซ้ำหากผลการส่งครั้งก่อนยังไม่แน่ชัด.
