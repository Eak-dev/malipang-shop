# การกู้ Canary รายวันที่เขียนแล้วและมีแถวว่างเกินหนึ่งแถว

เครื่องมือนี้จำกัดเฉพาะ Canary ยอดหนึ่งบาทที่มีหลักฐาน `canary_unwritten_recovery` เดิมเป็น `COMPLETE`, claim `REVIEW / OPERATION` เหตุ `INSERT_DAILY_SNAPSHOT_UNVERIFIED`, journal รายวันและ marker ที่ตรงกัน และ epoch เป้าหมายเดียว ห้ามใช้เป็นเครื่องมือกู้รายการทั่วไป ระบบไม่เปิด notice dispatcher หรือ review close ทั่วไป

ก่อนใช้ต้องมี backup ส่วนตัวที่ตรวจ restore/integrity/foreign keys ผ่าน ตรวจ Worker, D1, ชีตและรายงานปัจจุบัน ยืนยันว่าไม่มีผู้เขียนภายนอกและเจ้าของเฝ้าดูจริง ใช้ workflow `prod-canary-daily-incident.yml` บน main ผ่าน production environment และปัก SHA กับ Worker version เท่านั้น หนึ่ง run ต่อหนึ่ง phase:

1. `VERIFY`: ตรวจ snapshot และ digest ก่อน/หลัง, source, notice, รายงาน, งบและ format แล้วบันทึกเฉพาะ journal/preimage ที่พิสูจน์ว่าลงชีตแล้ว ไม่ส่งรายการซ้ำ
2. `TIME`: บันทึก intent และเปลี่ยนเวลา notice แบบมี preimage guard; `TIME_READBACK` อ่านยืนยันและบันทึกผลโดยไม่ส่งซ้ำ
3. `STATUS`: บันทึก intent ก่อนเปลี่ยนสถานะ notice และต้องได้คำตอบบวกจาก provider จึงบันทึก `STATUS_ACKED`
4. `COMMIT`: ตรวจหลักฐานซ้ำ แล้วบันทึกสถานะงานและปล่อยเฉพาะ claim ที่ตรงกันใน transaction จากนั้นอ่านสถานะ D1 และ provider กลับ

ถ้าคำตอบหาย ขัดแย้ง หรือขั้นใดไม่ผ่าน ให้หยุดและอ่าน durable state กับ provider ก่อน ห้าม dispatch phase ที่อาจส่งคำสั่งซ้ำ ความไม่มีข้อมูลอย่างเดียวไม่พิสูจน์ว่า provider ไม่ได้รับคำสั่ง การกู้ projection ไม่ใช่หลักฐานว่า Canary ผ่าน ต้องทดสอบรายงาน รายการซ้ำ และ Undo ตาม runbook เดิมก่อนปลด gate
