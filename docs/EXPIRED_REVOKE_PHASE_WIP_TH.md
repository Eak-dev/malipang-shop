# ต้นแบบกู้ phase ของ REVOKE ที่ lease หมด

งานนี้อยู่ในเครื่อง ไม่ได้ deploy และปิด `CONTINUOUS_EXPIRED_REVOKE_PHASE_ENABLED` โดยปริยาย ฟังก์ชันแก้เฉพาะ phase ของ claim จาก `REVIEW/NULL` เป็น `REVIEW/OPERATION` ไม่ rearm epoch, ไม่ปลด claim, ไม่เปลี่ยน job และไม่ส่ง Sheets POST

ก่อนแก้ phase ตรวจเป้าหมายที่ผูกกับ admission/epoch/lease และ intent เดิม, source digest กับ revision, marker postimage แบบครบคอลัมน์ และ notice `พักแก้ไฟล์` จากนั้นบันทึก evidence กับเปลี่ยน phase ใน D1 transaction เดียว โดยตรวจ source/cutover integrity และ revision ซ้ำ หาก D1 ตอบกลับไม่ชัดให้อ่าน evidence และ phase ที่ตรงกลับ ไม่ส่ง Sheets ซ้ำ หลังจากนั้น positive recovery เดิมยังต้องตรวจ postimage ซ้ำด้วยตนเอง

ทดสอบ synthetic SQLite ผ่าน watchdog `holdContinuousExpiredLease` จริง รวม legacy/financial digest แล้วตามด้วย reviewed REVOKE recovery, third state, notice ผิด, source drift ทั้งก่อนและระหว่าง transaction, lease active, flag ปิด, wrong transition และ D1 ACK หาย ผลทดสอบใช้ provider/notice จำลอง และ seed prior marker/intent โดย fixture จึงไม่ใช่ผลระบบจริง

ข้อจำกัด: รองรับ intent `REVOKE/IN_FLIGHT` และ `epoch=REVIEW` ที่ watchdog ตั้งเหตุ lease หมดเท่านั้น ไม่รองรับ intent VERIFIED ที่ไม่มี review evidence หรือ phase/reason อื่น; ไม่พิสูจน์ว่า writer ภายนอกหรือ provider request รุ่นเก่าหยุดแล้ว; ยังต้องมี dispatcher, rearm และ notice close ที่ผ่านการตรวจ ไม่ได้พิสูจน์ D1 binding/quota, HTTP provider, report หรือ production activation. Migration 0060 ต้องจัดลำดับ/เลขร่วมกับ branches อื่น และต้องผสานอย่างระวังกับ dual-protocol bridge `deff852` ซึ่งแก้ source reader ไฟล์เดียวกัน ห้ามเปิด gate หรือถือว่าพร้อมใช้งานจากการทดสอบนี้
