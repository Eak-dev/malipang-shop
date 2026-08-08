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

Summary แสดงเฉพาะปุ่มที่ระบบยังต้องการให้ยืนยันจริง ไม่แสดงปุ่มแก้ทุกช่องโดยอัตโนมัติ:

- `วิธีชำระเงิน` เมื่อ payment/source ยังไม่ยืนยัน
- `รายการ` เมื่อ Vision ระบุชื่อสินค้า/คู่ค้าไม่แน่นอน: เลือกใช้ข้อความเดิม หรือกดพิมพ์ข้อความถัดไปภายใน 15 นาทีเพื่อแก้เฉพาะ draft นั้น
- `หมวดหมู่` เมื่อหมวดเป็น fallback/ความเชื่อมั่นต่ำ
- `วันที่` เมื่อวันที่ยังไม่ถูกต้องหรือยังไม่ยืนยัน
- `บันทึก` เฉพาะเมื่อไม่มี field จำเป็นค้างอยู่

ยอดเงินไม่มีทางแก้จาก Flex; ถ้ายอดไม่ครบหรือไม่ถูกต้อง ระบบเก็บเป็น review-only หรือให้ยกเลิก ไม่เดายอดใหม่

เมื่อกด `Save` ระบบทำลำดับ `D1 (CONFIRMED) → Sheets Sync Job → Saved Flex` แล้วจึงเขียน Google Sheets ด้านหลัง เมื่อกด `Cancel` ก่อน Save จะไม่สร้างรายการใน Sheets ทุก Postback ตรวจว่า Expense ID เป็นของ LINE User ผู้กดและรายการยังอยู่ในสถานะ `WAITING_CONFIRM` ก่อนอนุญาตให้แก้ไข

ชื่อย่อบัตรที่รองรับตรงกับ Apps Script เดิม: `kbank/kb/kasikorn`, `firstchoice/fc/first`, `aeon`, `citibank/citi`, `ttb/thanachart`, `homepro/hp` และ `t1/theone/the_one` โดยชื่อย่อทั้งหมดถูกแปลงเป็น Payment Key มาตรฐานก่อนบันทึก

## หน้าตา

- ใช้สีน้ำตาล `#6D4C41` และพื้นครีม `#FFF3E0` ตาม Apps Script เดิม
- การ์ดสำเร็จใช้สีเขียว
- Expense Review ที่ต้องให้พนักงานตัดสินใจใช้ Thai-first เพื่อระบุ field ที่ค้างอย่างชัดเจน; ชื่อรายการและค่าที่สกัดได้ยังแสดงตามหลักฐานเดิม
- ปุ่มและ Postback data ผ่านข้อจำกัด LINE Flex Message
- Mapping `CARD_FIRST_CHOICE` และ `CARD_THE1` ตรงกับ Wallet Master เดิม

## รูปภาพ

Worker จำแนกรูปอัตโนมัติเพื่อให้ Attendance ทำงานเร็ว รูป KBank/K+, SCB และเป๋าตัง/G-Wallet ที่อ่านข้อมูลสำคัญครบจะสร้าง Bank slip draft เป็น `WAITING_CONFIRM` พร้อม Flex Thai-first โดยแสดงรายการ ยอดจ่ายจริง สถาบัน เลขอ้างอิงบางส่วน หมวด และวันที่ สลิปทุกธนาคาร **ไม่ใช้ Quick Save** และยังไม่ลง Google Sheets จนกว่าข้อมูลจำเป็นจะครบและบันทึกสำเร็จ

ก่อนบันทึก `Payment` ถูกล็อกเป็น `Bank transfer` และ `Paid from` ถูกล็อกเป็น `Shop bank account` สำหรับทุกธนาคาร เมื่อบันทึกลงชีท `รายวัน` จึงแสดงแหล่งเงินเป็น `บัญชีร้าน` เสมอ หากระบบต้องตรวจชื่อรายการ จะมีปุ่ม `รายการ` ให้ยอมรับข้อความเดิมหรือพิมพ์แก้เฉพาะ draft นั้น; หมวดและวันที่จะแสดงปุ่มเฉพาะเมื่อยังค้างการยืนยัน ยอดเงิน สถาบัน และเลขอ้างอิงยังแก้จาก Flex ไม่ได้

เมื่อ Save แล้วจึงสร้าง Sheets Sync Job และลงยอดจ่ายจริงในชีท `รายวัน` หากสถานะไม่สำเร็จ ข้อมูลไม่ครบ สกุลเงินไม่ใช่ THB ยอดก่อนส่วนลด/ส่วนลด/ยอดจ่ายจริงไม่ตรง หรือเป็นสลิปซ้ำ ระบบจะไม่สร้างยอดและตอบเหตุผลพร้อม error code

### Expense Document V1.2

Receipt, Tax Invoice และ Online Order ที่อ่านยอดจ่ายจริงและวันที่จ่ายได้ จะสร้าง `WAITING_CONFIRM` พร้อม Review Flex Thai-first โดยแสดง vendor, date, final paid amount, payment/source, category และ document type. ระบบแสดง `ยังต้องตรวจสอบ` เป็นชื่อ field ที่ยังค้างจริง เช่น `รายการ • หมวดหมู่` และให้ action ตรง field นั้นเท่านั้น

เมื่อข้อมูลจำเป็นอื่นครบ แต่ Vision ยังยืนยันช่องทางชำระเงิน/แหล่งเงินไม่ได้ ระบบจะไม่แสดง `Save` ก่อนเวลา แต่แสดงการ์ดหัวข้อ **เลือกวิธีชำระเงิน** ทันที พร้อม merchant/item, ยอด และวันที่ ผู้ใช้เลือก Cash, Transfer / QR หรือบัตรจาก Wallet Master ได้ในหนึ่งครั้ง ระบบจะแปลงเป็น `payment_key` และ `source_wallet` คนละ field ตามคู่ที่กำหนด แล้วบันทึกทันทีเฉพาะเมื่อไม่มี field จำเป็นอื่นค้างอยู่ หากมี field อื่นค้าง จะกลับไป Review โดย `Save` ยังไม่ถูกแสดงเป็น action หลัก และ D1 ยังคงบังคับ validation นี้แม้ postback ถูกสร้างเอง

เมื่อผู้ใช้แก้หรือยืนยัน **field สุดท้าย** ระบบตรวจ validation ฝั่ง Worker อีกครั้งแล้ว `CONFIRMED` เพียงครั้งเดียว → สร้าง Sheets Sync Job → ตอบผลสำเร็จ โดยไม่วนกลับไปให้กด Save ซ้ำ. Postback เก่า/ซ้ำ และ draft ที่ `CONFIRMED` หรือ `CANCELLED` แล้วจะไม่แก้ไขธุรกรรมอีก

- ไม่มี final paid amount, วันที่จ่าย หรือแหล่งบัตรที่ยืนยันได้: เก็บเป็น reviewable document เท่านั้น ไม่เดาและไม่ลงชีท
- Delivery Order เดี่ยว: ตอบว่ารับ supporting evidence แล้ว และรอ payment evidence จึงไม่สร้าง finalized Expense
- Receipt/Tax Invoice เก็บ line item ที่เห็นทั้งหมดใน D1 เพื่อใช้ V2 ต่อได้ แต่ไม่เปิด Supplier/Inventory UI ใน V1.2
- Online order หลาย seller จะสร้าง seller case แยก ไม่รวมยอดเป็น case เดียว; การแบ่งส่วนลดที่ไม่มีหลักฐานชัดเจนจะอยู่ review
- ทุก image document ไม่ใช้ Quick Save และไม่ลง Sheets จนกด `Save`; LINE Reply-first และ retry notification ยังแยกจากธุรกรรม D1
