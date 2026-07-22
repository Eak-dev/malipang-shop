# LINE Flex และ Flow ค่าใช้จ่าย

เอกสารนี้เทียบ UI ของ Apps Script เดิมกับ Worker V5.2 โดยย้ายเฉพาะ Flow ที่ Backend ปัจจุบันรองรับจริง ไม่แสดงปุ่มที่กดแล้วทำงานไม่ครบ

## ข้อความค่าใช้จ่าย

### Quick Save

คำสั่ง `ทอน`, `change` และ `โอน` ภาษาไทยบันทึกทันที:

```text
ไข่ ทอน 375
Egg change 500
ค่าไฟ โอน 1200
```

ลำดับงานคือ D1 → Sheets Sync Job → Saved Flex พร้อมปุ่ม Undo การ Undo จะเปลี่ยนสถานะเป็น `CANCELLED` และอัปเดตแถวเดิมใน Google Sheets ไม่ลบข้อมูลประวัติ

### ตรวจและแก้ก่อนบันทึก

รายการที่ไม่มี Quick token, ใช้ `transfer` ภาษาอังกฤษ หรือใช้บัตร จะถูกสร้างเป็น `WAITING_CONFIRM` และแสดง Summary Flex:

```text
Egg 375
Gas transfer 371
กล่อง kbank 350
```

จาก Summary ผู้ใช้ทำได้ดังนี้:

- บันทึกหรือยกเลิก
- เปลี่ยนวิธีจ่าย: เงินสด โอน หรือบัตร
- เปลี่ยนแหล่งเงินให้ตรง Wallet Master
- เปลี่ยนหมวดค่าใช้จ่าย
- เลือกวันนี้ เมื่อวาน หรือวันที่จาก Date Picker

ทุก Postback ตรวจว่า Expense ID เป็นของ LINE User ผู้กดและรายการยังอยู่ในสถานะที่แก้ไขได้

## หน้าตา

- ใช้สีน้ำตาล `#6D4C41` และพื้นครีม `#FFF3E0` ตาม Apps Script เดิม
- การ์ดสำเร็จใช้สีเขียว
- ข้อความหลักเป็นไทยและมีอังกฤษกำกับ
- ปุ่มและ Postback data ผ่านข้อจำกัด LINE Flex Message
- Mapping `CARD_FIRST_CHOICE` และ `CARD_THE1` ตรงกับ Wallet Master เดิม

## รูปภาพ

Worker ปัจจุบันยังคงจำแนกรูปอัตโนมัติเพื่อให้ Attendance ทำงานเร็ว และรูปใบเสร็จ/สลิปถูกเก็บเป็น `WAITING_REVIEW` เท่านั้น ยังไม่ย้ายเมนู Apps Script ที่มี Receipt line items, bank-slip purpose และ linking เพราะ Backend V5.2 ยังไม่มี accounting engine เหล่านั้น การแสดงปุ่มดังกล่าวก่อน Backend พร้อมจะทำให้ผู้ใช้เข้าใจผิดว่าใช้งานได้ครบ

เมื่อพัฒนา Receipt Accounting ต่อ ให้ย้ายตามลำดับ: pending image → route Flex → OCR/AI → review Flex → wallet/date → confirm → D1/Sheets โดยไม่กลับไปใช้ Apps Script ใน Runtime
