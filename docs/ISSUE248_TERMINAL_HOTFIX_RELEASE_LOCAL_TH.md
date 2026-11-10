# Issue 248 — แผน local สำหรับ terminal hold hotfix

Workflow นี้ deploy ได้เฉพาะ manual dispatch บน main หลัง PR #268 merge และ source ตรง commit ที่ตรวจทาน; push ที่แก้ workflow ใช้สำหรับ register เท่านั้น ไม่เรียก provider หรือ deploy. ไม่ทำ migration, export, queue pause/resume, cron change หรือ DLQ replay.

ก่อน deploy ตรวจ Worker เดิม, Queue, Cron, G7 receipt, B_POST, D1 claims/IN_FLIGHT และ active/unbounded leases สองครั้ง ผลเป็นการอ่าน ณ เวลาใดเวลาหนึ่ง ไม่ใช่ writer freeze: queue, cron หรือ external actor อาจเริ่มงานก่อน deploy ได้. เงื่อนไข drift/nonzero ที่ไม่ได้ยกเว้นให้ STOP; deploy ACK หรือผลหลัง deploy ที่ไม่แน่ชัดให้หยุด ตรวจสถานะจริง ห้าม blind retry/rollback.

อนุญาต exception **เฉพาะ** expired PROCESSING ของ Expense version 1 ที่ hash `45d45ed474123f515ee629f409296fe9cc044dee3de4643c35e07687aac7ee5a` ตรงกับ `EXPENSE:<entity_key>:1`, ยังมี terminal OPEN, source CONFIRMED, DAILY/RAW VERIFIED ใน workbook เดิมและ sheet IDs เดิมอย่างละหนึ่งด้วย digest เดียวกัน, มี journal รวมสองและไม่มี documents/links/items. Workflow ต้องได้รับข้อความ `OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE` เพื่อยอมรับความเสี่ยงนี้; expired processing รายอื่น, lease invalid/unbounded, active claim, IN_FLIGHT และ staff PROCESSING ไม่ผ่าน. ผู้ตรวจแยกเคย readback target จาก provider ใน session; workflow นี้ **ไม่ได้** ทำ provider readback ของ target รายนี้ใหม่ จึงไม่ถือเป็น durable provider attestation.

Expired lease ไม่ยืนยันว่า Worker เก่าหรือ provider request หยุดแล้ว แม้ exception ผ่าน ผลของ writer เดิมยัง UNKNOWN; ไม่แก้สถานะงาน, ไม่ปลด terminal และไม่สร้างหลักฐานว่า FINAL ผ่าน. หลัง deploy ต้องตรวจ Worker version ใหม่, Queue active และ B_POST รวมรอ 360 วินาที, ต่อด้วย reconciliation ราย ID และ 7-day soak. หาก Queue เปลี่ยนสถานะหรือข้อมูลกำกวม ให้หยุดตาม incident control ไม่ PATCH ซ้ำอัตโนมัติ.

หลัง deploy และหลังรอ 360 วินาที workflow ตรวจ failed_jobs ที่สร้างใหม่ตั้งแต่เวลาเริ่มสังเกต หรือ OPEN ที่ถูกแก้หลังเวลานั้น ต้องเป็นศูนย์; เป็นการลดความเสี่ยงที่จำนวน OPEN รวมลดลงแล้วบดบังรายการใหม่ ไม่ได้ตรวจจับ Google 429 ทั้งหมด. ไฟล์ D1 ที่มี identity อยู่ใน private RUNNER_TEMP พร้อม umask 077 และไม่ถูกพิมพ์.
