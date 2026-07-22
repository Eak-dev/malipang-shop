# LINE Flex และ Flow ค่าใช้จ่าย

เอกสารนี้เทียบ UI ของ Apps Script เดิมกับ Worker V5.2 โดยย้ายเฉพาะ Flow ที่ Backend ปัจจุบันรองรับจริง ไม่แสดงปุ่มที่กดแล้วทำงานไม่ครบ

## ข้อความค่าใช้จ่าย

### Quick Save

คำสั่ง `ทอน`, `change`, `โอน`, `transfer`, `ชื่อธนาคาร` บันทึกทันที:

```text
ไข่ ทอน 375
Egg change 500
ค่าไฟ โอน 1200
Gas transfer 371
กล่อง kbank 350
กล่อง kbank 350
กล่อง fc 350
กล่อง citi 350
```
ลำดับงานคือ D1 → Sheets Sync Job → Saved Flex พร้อมปุ่ม Undo การ Undo จะเปลี่ยนสถานะเป็น `CANCELLED` และอัปเดตแถวเดิมใน Google Sheets ไม่ลบข้อมูลประวัติ

### ตรวจและแก้ก่อนบันทึก

รายการที่ไม่มี Quick token, ใช้ `transfer` ภาษาอังกฤษ หรือใช้บัตร จะถูกสร้างเป็น `WAITING_CONFIRM` และแสดง Summary Flex:

```text
Egg 375
```

จาก Summary ผู้ใช้ทำได้ดังนี้:

- บันทึกหรือยกเลิก
- เปลี่ยนวิธีจ่าย: เงินสด โอน หรือบัตร
- เปลี่ยนแหล่งเงินให้ตรง Wallet Master
- เปลี่ยนหมวดค่าใช้จ่าย
- เลือกวันนี้ เมื่อวาน หรือวันที่จาก Date Picker

ทุก Postback ตรวจว่า Expense ID เป็นของ LINE User ผู้กดและรายการยังอยู่ในสถานะที่แก้ไขได้

ชื่อย่อบัตรที่รองรับตรงกับ Apps Script เดิม: `kbank/kb/kasikorn`, `firstchoice/fc/first`, `aeon`, `citibank/citi`, `ttb/thanachart`, `homepro/hp` และ `t1/theone/the_one` โดยชื่อย่อทั้งหมดถูกแปลงเป็น Payment Key มาตรฐานก่อนบันทึก

## หน้าตา

- ใช้สีน้ำตาล `#6D4C41` และพื้นครีม `#FFF3E0` ตาม Apps Script เดิม
- การ์ดสำเร็จใช้สีเขียว
- ข้อความและปุ่มใน Expense Flow ใช้ English เท่านั้น ส่วนชื่อรายการที่ผู้ใช้พิมพ์ภาษาไทยยังคงแสดงตามเดิม
- ปุ่มและ Postback data ผ่านข้อจำกัด LINE Flex Message
- Mapping `CARD_FIRST_CHOICE` และ `CARD_THE1` ตรงกับ Wallet Master เดิม

## รูปภาพ

Worker จำแนกรูปอัตโนมัติเพื่อให้ Attendance ทำงานเร็ว รูป KBank/K+, SCB และเป๋าตัง/G-Wallet ที่อ่านข้อมูลสำคัญครบจะสร้าง Bank slip draft เป็น `WAITING_CONFIRM` พร้อม Flex ภาษาอังกฤษ โดยแสดงรายการ ยอดจ่ายจริง สถาบัน เลขอ้างอิงบางส่วน หมวด และวันที่ ผู้ใช้แก้หมวด/วันที่แล้วกด Save หรือ Cancel ได้

Bank slip ล็อก Payment เป็น Transfer และ Paid from เป็น Shop bank จึงไม่แสดงปุ่มแก้สองช่องนี้ เมื่อ Save แล้วจึงสร้าง Sheets Sync Job และลงยอดในชีท `รายวัน` หากสถานะไม่สำเร็จ ข้อมูลไม่ครบ สกุลเงินไม่ใช่ THB ยอดก่อนส่วนลด/ส่วนลด/ยอดจ่ายจริงไม่ตรง หรือเป็นสลิปซ้ำ ระบบจะไม่สร้างยอดและตอบเหตุผลพร้อม error code

รูปใบเสร็จทั่วไปและ Online order ยังเป็น `WAITING_REVIEW` เพราะ Backend V5.2 ยังไม่มี Receipt line-item accounting, การแตกสินค้า หรือ linking หลายเอกสาร การแสดงปุ่มดังกล่าวก่อน Backend พร้อมจะทำให้ผู้ใช้เข้าใจผิดว่าใช้งานได้ครบ

เมื่อพัฒนา Receipt Accounting ต่อ ให้ย้ายตามลำดับ: pending image → route Flex → OCR/AI → review Flex → wallet/date → confirm → D1/Sheets โดยไม่กลับไปใช้ Apps Script ใน Runtime
