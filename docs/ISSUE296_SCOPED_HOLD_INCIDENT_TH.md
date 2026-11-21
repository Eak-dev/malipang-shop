# Issue #296: scoped hold incident

หลังเปิด gate งานค่าใช้จ่ายเก่าที่ถูกยกเลิกถูกพัก REVIEW สำเร็จ แต่ D1 นับ trigger แจ้งเตือนรวมใน `meta.changes` ทำให้ claim ถูกคง REVIEW/OPERATION ด้วย `STABLE_EXPENSE_SOURCE_UNVERIFIED`. การแก้ตัวนับผ่าน PR #328 ไม่ลบ claim เดิม ไม่ส่งงานซ้ำ และไม่ยืนยันว่าข้อมูลเก่าไม่เคยถูกเขียน.

การกู้จำกัดเฉพาะ claim และ job ที่ตรึงด้วย SHA-256 ตรวจข้อมูลต้นทาง, job, ช่วงเวลา, journal, row index, failed job, epoch และไม่มีงาน PROCESSING พร้อม recovery gate เปิดอยู่ ต้องตรวจ Owner Master ว่า notice และรายงานตรงก่อนทุกขั้น. ขั้น `PROBE`, `TIME`, `PROBE_STATUS`, `STATUS`, `COMMIT` ทำแยกกันผ่าน production workflow; หลัง provider POST ผลไม่ชัดเจนห้าม retry. การกู้เปลี่ยนเฉพาะ notice และปล่อย claim ที่ตรวจแล้ว งานเดิมและ Undo คง REVIEW/PENDING ตามลำดับ.

ต้อง backup และทดลอง migration บนสำเนาฐานข้อมูลจริง ตรวจ CI, dry run, Worker version และเจ้าของยืนยันงดผู้เขียนภายนอกกับเฝ้าระวัง ก่อนทุกการเปลี่ยน Production. หลัง COMMIT ตรวจผล แล้วจึงนำ operator ชั่วคราวออกและปิด gate ผ่าน PR แยก; ต้องตรวจคิวจริงและรายงานหลังปล่อยอีกครั้ง. ไม่มีขั้นลบข้อมูลธุรกิจหรือ replay รายการที่ผลไม่ชัดเจน.
