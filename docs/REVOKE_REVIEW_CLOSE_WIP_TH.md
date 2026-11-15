# สถานะต้นแบบกู้ REVOKE ใน REVIEW

เป็นงานทดลองในเครื่องเท่านั้น ไม่ได้เปิดใช้หรือเปลี่ยน Production

โค้ด candidate รองรับเฉพาะ REVOKE ที่อ่านผล marker กลับและมี review evidence ตรงกัน ตรวจ projection และรายงานก่อนปิด notice แล้วเปลี่ยน job เป็น PENDING พร้อมปล่อย claim ใน D1 batch เดียว ใช้ opt-in และ activation ที่ปิดไว้เป็นค่าเริ่มต้น การทดสอบใช้ provider จำลองและ SQLite ไม่ใช่ผลระบบจริง

ยังไม่พร้อมเปิดใช้:

- ยังไม่มี scheduler หรือ route ที่เรียก positive recovery และ REVIEW close ให้ครบลำดับ
- รองรับเฉพาะ epoch ที่ยัง ARMED; หาก epoch เป็น REVIEW หลัง expired-lease recovery ต้องมีกระบวนการกู้ที่พิสูจน์ผลเดิมก่อน เพราะ schema เดิมไม่อนุญาต REVIEW กลับเป็น ARMED
- เมื่อ job นี้เป็น REVIEW รายการสุดท้าย notice อาจยังแสดงว่ามีรายการรอตรวจหลัง job กลับเป็น PENDING เพราะเลือกข้อความก่อน D1 commit ต้องเพิ่ม guarded cleanup โดยคง claim จนแก้ข้อความสำเร็จและใช้ nonce เฉพาะครั้ง เพื่อไม่ให้ POST ที่ตอบช้าทับ notice ของงานถัดไป ห้ามแก้ด้วยการเขียน status ซ้ำหลังปล่อย claim
- ค่า source revision ระดับระบบยังอาจเปลี่ยนเมื่อเอกสารไม่เกี่ยวข้องเข้ามาระหว่าง REVOKE ทำให้ต้องพักตรวจหลังส่ง POST และ fingerprint candidate ยังต้องผ่านการทบทวนและผสานแบบครบเส้นทาง
- ยังต้องพิสูจน์สิทธิ์เขียน พฤติกรรม provider การป้องกัน writer อื่น และผลรายงานของไฟล์จริง รวมถึง migration และทดสอบระบบจริงก่อนเปิด gate
