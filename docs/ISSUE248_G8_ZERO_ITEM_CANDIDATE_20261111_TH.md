# Issue #248 — G8 zero-item owner-risk candidate

สถานะ **LOCAL CANDIDATE / ห้าม merge หรือ deploy ก่อน G7 partial proof และ exact-head review**. Owner เลือกค่าใช้จ่ายจริง 5 บาทที่ไม่มีสินค้าและยอมรับความเสี่ยงว่า DETAIL writer ไม่ถูกทดสอบ. ห้ามสร้างรายการสินค้าปลอมหรือใช้ผลนี้แทนการกระทบยอด G9.

ตัวเลือกนี้เพิ่ม receipt V3 แยกจาก V1/V2 itemized โดยต้องรักษาการยอมรับความเสี่ยงด้าน 429 ที่บันทึกเป็น UNKNOWN ตาม control ก่อนหน้า. Source SHA256/revision, target version และยอด 500 satang เชื่อมกับ DAILY/RAW journal ที่ VERIFIED; SQL ตรวจไม่มี item/document/link และไม่มี DETAIL journal, และยังต้องอาศัย provider absence readback จาก G7 แยก. รายละเอียดการทดสอบ/จำนวนผลจริงให้ใช้ local test logs ของรอบนี้ ไม่ใช่ข้อมูล Production.

ผู้ตรวจต้องตรวจ receipt provenance, ว่ารหัส/วัน/รายละเอียด/การจ่ายของ expense ที่ owner เลือกถูกตรวจโดย G7 selector ก่อน ARM และ digest เดียวกันถูกส่งถึง G8; ห้ามแสดงข้อมูลส่วนบุคคลหรือสร้างธุรกรรมแทนข้อมูลจริง. ต้องตรวจ trigger definitions/deployed source และสถานะ Production จริงแยก: การนับชื่อ trigger ไม่ใช่หลักฐานว่าพฤติกรรมทุก trigger ถูกต้อง. หาก source revision เปลี่ยนหรือ provider proof ขาด ให้หยุด ไม่ลด guard.

ลำดับ: G7 intent → one-shot ARM → DAILY/RAW/FINAL และ provider readback → authenticated outcome → Owner-reviewed V3 receipt → update/review PRs → G8. ห้าม merge PR258/260 ก่อน G7 intent/outcome/receipt เสร็จ เพราะ source pins ของ workflow ก่อนหน้าอาจไม่ตรง. หลัง G8 ยังต้องทดสอบ expense จริงที่มีรายละเอียดสินค้า, reconcile backlog, Payroll parity และ soak ก่อนเรียกว่าทำงานปกติ.

V3 receipt ต้องระบุ `arm_audit_nonce`, `arm_intent_sha256`, `arm_outcome_sha256`, `arm_intent_run_id`, `arm_outcome_run_id` และ `arm_workflow_source_sha`. `scripts/pr247-g7-zero-proof.mjs` ตรวจ private R2 intent/outcome, ACK ที่แน่นอน, GH run/job/step marker และ reviewed script/workflow hashes; เชื่อม epoch target/version/trace ผ่าน SHA256 กับ D1 ปัจจุบัน. ค่า target key และ trace อยู่เฉพาะ private temporary file และถูกลบจาก snapshot ก่อนส่ง guard. `scripts/pr247-readonly-snapshot.sh` ตรวจ RAW sheet ID เดิม 247227172 และ Daily sheet ID 1815870717. Receipt ยังต้องผ่าน approval และตรวจ provider no DETAIL rows จริง; ไม่ยอมรับ ARM ACK ที่กำกวมเป็น PASS.
