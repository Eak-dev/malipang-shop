# LINE Flex และ Flow ค่าใช้จ่าย

เอกสารนี้เทียบ UI ของ Apps Script เดิมกับ Worker V5.2 โดยย้ายเฉพาะ Flow ที่ Backend ปัจจุบันรองรับจริง ไม่แสดงปุ่มที่กดแล้วทำงานไม่ครบ

## ข้อความค่าใช้จ่าย

### Quick Save

Quick Save ใช้เฉพาะ token ที่ตั้งใจให้บันทึกทันทีเท่านั้น:

| Token | วิธีจ่าย | แหล่งเงิน | ผลลัพธ์ |
|---|---|---|---|
| `ทอน` | Cash | Cash drawer | บันทึกทันที |
| `change` | Cash | Cash drawer | บันทึกทันที |
| `โอน` | Bank transfer | Shop bank account | บันทึกทันที |

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

ระบบแยกวันที่ รายการ ยอด วิธีจ่าย แหล่งเงิน และหมวดอัตโนมัติ แล้วใช้ลำดับ `D1 (CONFIRMED) → Sheets Sync Job → Saved Flex` โดยไม่แสดง Review Flex ก่อนบันทึก เพื่อให้รายการประจำที่รูปแบบชัดเจนทำงานได้เร็ว

Saved Flex มีปุ่ม `Undo save` หากข้อมูลผิด การ Undo จะเปลี่ยนสถานะเป็น `CANCELLED` และส่ง Sheets Sync Job รุ่นใหม่ไปล้างเฉพาะช่องข้อมูลของแถวเดิม โดยยังเก็บประวัติใน D1 เพื่อ audit

คำอย่าง `cash`, `เงินสด`, `drawer`, `transfer`, `bank`, `qr`, `promptpay` และชื่อบัตร **ไม่ใช่ Quick Save** แม้ระบบจะรู้จักวิธีจ่าย เพราะต้องให้ผู้ใช้ตรวจสอบก่อน

ลำดับงานคือ D1 → Sheets Sync Job → Saved Flex พร้อมปุ่ม Undo การ Undo จะเปลี่ยนสถานะเป็

### ตรวจและแก้ก่อนบันทึก

รายการที่ไม่มี Quick token, ใช้ alias อื่นของเงินสด/เงินโอน หรือใช้บัตร จะถูกสร้างเป็น `WAITING_CONFIRM` และแสดง `Review expense` Flex โดยยังไม่สร้าง Sheets Sync Job:

```text
Egg cash 375
Gas transfer 371
กล่อง kbank 350
```

จาก Summary ผู้ใช้ทำได้ดังนี้:

- บันทึกหรือยกเลิก
- เปลี่ยนวิธีจ่าย: เงินสด โอน หรือบัตร
- เปลี่ยนแหล่งเงินให้ตรง Wallet Master
- เปลี่ยนหมวดค่าใช้จ่าย
- เลือกวันนี้ เมื่อวาน หรือวันที่จาก Date Picker

ชื่อรายการและยอดเงินยังแก้ใน Flex ไม่ได้ หากสองช่องนี้ผิดให้กด Cancel แล้วส่งข้อความใหม่

เมื่อกด `Save` ระบบทำลำดับ `D1 (CONFIRMED) → Sheets Sync Job → Saved Flex` แล้วจึงเขียน Google Sheets ด้านหลัง เมื่อกด `Cancel` ก่อน Save จะไม่สร้างรายการใน Sheets ทุก Postback ตรวจว่า Expense ID เป็นของ LINE User ผู้กดและรายการยังอยู่ในสถานะ `WAITING_CONFIRM` ก่อนอนุญาตให้แก้ไข

ชื่อย่อบัตรที่รองรับตรงกับ Apps Script เดิม: `kbank/kb/kasikorn`, `firstchoice/fc/first`, `aeon`, `citibank/citi`, `ttb/thanachart`, `homepro/hp` และ `t1/theone/the_one` โดยชื่อย่อทั้งหมดถูกแปลงเป็น Payment Key มาตรฐานก่อนบันทึก

## หน้าตา

- ใช้สีน้ำตาล `#6D4C41` และพื้นครีม `#FFF3E0` ตาม Apps Script เดิม
- การ์ดสำเร็จใช้สีเขียว
- ข้อความและปุ่มใน Expense Flow ใช้ English เท่านั้น ส่วนชื่อรายการที่ผู้ใช้พิมพ์ภาษาไทยยังคงแสดงตามเดิม
- ปุ่มและ Postback data ผ่านข้อจำกัด LINE Flex Message
- Mapping `CARD_FIRST_CHOICE` และ `CARD_THE1` ตรงกับ Wallet Master เดิม

## รูปภาพ

Worker จำแนกรูปอัตโนมัติเพื่อให้ Attendance ทำงานเร็ว รูป KBank/K+, SCB และเป๋าตัง/G-Wallet ที่อ่านข้อมูลสำคัญครบจะสร้าง Bank slip draft เป็น `WAITING_CONFIRM` พร้อม Flex ภาษาอังกฤษ โดยแสดงรายการ ยอดจ่ายจริง สถาบัน เลขอ้างอิงบางส่วน หมวด และวันที่ สลิปทุกธนาคาร **ไม่ใช้ Quick Save** และยังไม่ลง Google Sheets จนกว่าผู้ใช้กด `Save`

ก่อน Save ผู้ใช้แก้ได้เฉพาะ `Category` และ `Date` ส่วน `Payment` ถูกล็อกเป็น `Bank transfer` และ `Paid from` ถูกล็อกเป็น `Shop bank account` สำหรับทุกธนาคาร เมื่อบันทึกลงชีท `รายวัน` จึงแสดงแหล่งเงินเป็น `บัญชีร้าน` เสมอ รายการ ยอดเงิน สถาบัน และเลขอ้างอิงยังแก้จาก Flex ไม่ได้ หาก AI อ่านช่องสำคัญผิดให้กด Cancel และส่งให้ผู้ดูแลตรวจแทนการยืนยันข้อมูลผิด

เมื่อ Save แล้วจึงสร้าง Sheets Sync Job และลงยอดจ่ายจริงในชีท `รายวัน` หากสถานะไม่สำเร็จ ข้อมูลไม่ครบ สกุลเงินไม่ใช่ THB ยอดก่อนส่วนลด/ส่วนลด/ยอดจ่ายจริงไม่ตรง หรือเป็นสลิปซ้ำ ระบบจะไม่สร้างยอดและตอบเหตุผลพร้อม error code

### Expense Document V1.2

Receipt, Tax Invoice และ Online Order ที่อ่านยอดจ่ายจริงและวันที่จ่ายได้ จะสร้าง `WAITING_CONFIRM` พร้อม Review Flex ภาษาอังกฤษเหมือน flow เดิม โดยแสดง vendor, date, final paid amount, payment/source, category และ document type. ผู้ใช้ยืนยัน/ยกเลิก หรือแก้ payment, source, category และ date ก่อนบันทึกได้

- ไม่มี final paid amount, วันที่จ่าย หรือแหล่งบัตรที่ยืนยันได้: เก็บเป็น reviewable document เท่านั้น ไม่เดาและไม่ลงชีท
- Delivery Order เดี่ยว: ตอบว่ารับ supporting evidence แล้ว และรอ payment evidence จึงไม่สร้าง finalized Expense
- Receipt/Tax Invoice เก็บ line item ที่เห็นทั้งหมดใน D1 เพื่อใช้ V2 ต่อได้ แต่ไม่เปิด Supplier/Inventory UI ใน V1.2
- Online order หลาย seller จะสร้าง seller case แยก ไม่รวมยอดเป็น case เดียว; การแบ่งส่วนลดที่ไม่มีหลักฐานชัดเจนจะอยู่ review
- ทุก image document ไม่ใช้ Quick Save และไม่ลง Sheets จนกด `Save`; LINE Reply-first และ retry notification ยังแยกจากธุรกรรม D1
