# สถานะต้นแบบกู้ REVOKE ใน REVIEW

เป็นงานทดลองในเครื่องเท่านั้น ไม่ได้เปิดใช้หรือเปลี่ยน Production

โค้ด candidate รองรับเฉพาะ REVOKE ที่อ่านผล marker กลับและมี review evidence ตรงกัน ตรวจ projection และรายงานก่อนปิด notice แล้วเปลี่ยน job เป็น PENDING พร้อมปล่อย claim ใน D1 batch เดียว ใช้ opt-in และ activation ที่ปิดไว้เป็นค่าเริ่มต้น การทดสอบใช้ provider จำลองและ SQLite ไม่ใช่ผลระบบจริง

ยังไม่พร้อมเปิดใช้:

- มี candidate dedicated dispatch บน notice worker/queue เดิม (ปิดค่าเริ่มต้น); ยังต้องตรวจ provider จริง งบ D1 และสถานะค้างทุก phase ก่อนเปิดใช้
- เพิ่ม candidate ที่ rearm epoch REVIEW → ARMED เฉพาะ REVOKE เดิมเมื่อ positive proof, inactive lease และ source revision ตรงกันใน D1; ยังไม่ต่อ scheduler หรือทดสอบ provider จริง
- มีต้นแบบ guarded cleanup คง claim และใช้ nonce จน status ถูกอ่านกลับแล้วเท่านั้นก่อนปล่อย claim; หากจำนวน REVIEW เปลี่ยนระหว่าง cleanup จะคง claim และสร้าง incident แจ้งเหตุหนึ่งครั้ง ไม่ replay ผลไม่ชัด ยังต้องตรวจอิสระและทดสอบ provider จริง
- ค่า source revision ระดับระบบยังอาจเปลี่ยนเมื่อเอกสารไม่เกี่ยวข้องเข้ามาระหว่าง REVOKE ทำให้ต้องพักตรวจหลังส่ง POST และ fingerprint candidate ยังต้องผ่านการทบทวนและผสานแบบครบเส้นทาง
- ยังต้องพิสูจน์สิทธิ์เขียน พฤติกรรม provider การป้องกัน writer อื่น และผลรายงานของไฟล์จริง รวมถึง migration และทดสอบระบบจริงก่อนเปิด gate

Checkpoint เพิ่มเติม: dispatcher รันเฉพาะ queue ของ notice worker โดย RUNNING ไม่ถูก steal หรือเปลี่ยนเป็น HELD โดย watchdog; watchdog แจ้งว่ารอนานและเจ้าของเดิมอาจยังทำงานต่อ. expired-phase ตรวจเฉพาะ GET จึงลองใหม่ไม่เกินสองครั้งเมื่อพบ network/timeout/429/5xx โดยคงเหตุ lease หมดเวลา; ผลข้อมูลขัดแย้งไม่ลองใหม่. ยังต้องทบทวน race, งบ D1 ของ worker จริง, migration และการเชื่อม quota/outbox/report ก่อนใช้จริง
