# ซ้อมอ่าน Google grid แยกสำหรับ #296

Workflow `issue296-isolated-grid-probe.yml` ใช้ Worker version ชั่วคราวที่ยังไม่ deploy รับ traffic เพื่อทดสอบ raw GET และ parser เดียวกับ monthly report บนสำเนาที่กำหนดเท่านั้น ไม่ซิงก์รายการ ไม่เขียนชีต ไม่ใช้ D1, Queue, R2 หรือ Durable Object binding และไม่เปลี่ยน Production Worker traffic

ต้องเตรียม GitHub production environment secret ชั่วคราว `ISSUE296_TEST_TARGET_JSON` จากข้อมูลสำเนาทดสอบแบบ private ประกอบด้วย `test_spreadsheet_id`, `test_sheet_id`, `test_spreadsheet_sha256`, `production_spreadsheet_sha256`. ค่า hash ทั้งสองต้องมาจากการอ่านไฟล์ที่ยืนยันตัวตนแล้วและแตกต่างกัน; โปรดอย่าใส่ JSON, URL, bearer token หรือรหัสรายการใน workflow inputs/logs. ให้สิทธิ์ reader เฉพาะ principal ที่จำเป็นแก่สำเนาและตรวจสิทธิ์อีกครั้ง ข้อมูล Production และ backup ไม่ต้องถูกแชร์เพิ่ม

รันจาก main SHA และ SHA-256 ของ Worker version ที่รับ traffic 100% ปัจจุบัน โดยมี shared concurrency `malipang-release-control`. ตรวจ latest uploaded ตรง live, ชนิด/ชื่อ secret binding ตรงกัน และไม่มีชื่อ vars ชน secrets. Workflow สร้าง token สุ่มใน process, กำหนดหมดอายุไม่เกิน 20 นาที, ใช้ Wrangler dry-run สร้างและตรวจ multipart จากนั้น POST upload เพียงครั้งเดียว โดยไม่มีการ retry หากผลไม่ชัดเจนให้ตรวจรายการ version และ traffic แบบ read-only ก่อนทำสิ่งใดต่อ

ก่อน GET ต้องตรวจว่า version ใหม่นี้มี preview URL, bindings เป็น vars ทดสอบและ secrets เดิมเท่านั้น, ไม่มี resource binding และ live เดิมยังรับ traffic 100%. ตัว probe ตรวจ hash ของ test workbook และ production ID ที่สืบทอดจริง แล้วใช้ Google OAuth ภายใน Worker; GET สำเร็จรายงานเฉพาะสถานะ ขนาดกริดและจำนวน request. Cloudflare อาจไม่สร้าง preview สำหรับ Worker ที่ใช้ Durable Object: หากไม่มี preview หรือ Google ไม่อนุญาต ให้นำผลไปตรวจต่อ ห้ามเปิด feature หรือส่ง upload ซ้ำโดยอัตโนมัติ

การอ่านสำเนาผ่าน probe ไม่ยืนยันว่า operator ที่เขียนแถวทำงานครบขั้นตอน และไม่อนุญาตเปิดคิวหรือถือว่าระบบ Production พร้อมใช้. หลังจบทดลองให้จัดการ secret ชั่วคราวและสิทธิ์ reader ของสำเนาตามขอบเขตงานเมื่อไม่ต้องใช้แล้ว; version ใหม่กลายเป็น latest uploaded แม้ traffic เดิมไม่เปลี่ยน จึงต้องตรวจ inheritance ก่อน release ถัดไป

เมื่อ shared grid reader เปลี่ยน ต้อง build bundle ด้วย dependency/flags ที่ pin ไว้ เปรียบเทียบและทบทวนความต่างของ executable แยกจาก source ก่อนอัปเดต SHA ที่ workflow ตรวจ; การเปลี่ยน SHA ไม่อนุญาตให้ส่ง upload ที่ผลก่อนหน้ายังไม่ชัดซ้ำ และไม่ใช่หลักฐานว่า probe หรือ Production ผ่าน.
