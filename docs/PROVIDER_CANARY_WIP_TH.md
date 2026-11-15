# Candidate ตรวจสิทธิ์เขียนด้วยบัญชีระบบ

ยังไม่ได้ deploy, activate หรือเขียน workbook จริง และไม่ใช่หลักฐานความพร้อมใช้งาน Production

`POST /admin/stable-sync/provider-canary` ต้องผ่าน admin authentication, pin Worker version, flag `CONTINUOUS_PROVIDER_CANARY_ENABLED=true` และ activation ใน D1. `prepare` ลงทะเบียน tab ชื่อสุ่มพร้อม fingerprint ของบัญชีระบบและ Worker version; ทุก phase ต้องตรงกัน หาก deploy หรือเปลี่ยน credential ระหว่างทางจะพักไว้. `step` ทำหนึ่ง phase: สร้าง tab พร้อม marker/สูตร, อ่านกลับ, insertRange, อ่านสูตร/ค่าและตำแหน่งกลับ, ลบ tab ทดสอบ แล้วอ่าน metadata ว่าไม่มี tab นี้. ก่อนแต่ละ POST มี D1 intent; เมื่อผลไม่แน่ชัดให้อ่านกลับเท่านั้น ห้าม replay POST ตามการไม่พบข้อมูล. สถานะที่ตรวจไม่ผ่านคงไว้เพื่อวิเคราะห์ ไม่เปิดซิงก์

ขอบเขตหลักฐาน: การผ่านด้วย credential ของ Worker พิสูจน์เฉพาะการทำงานบน scratch tab ใน workbook ขณะนั้น ไม่พิสูจน์สิทธิ์บน protected ranges หรือการแทรกใน tab รายวันจริง และไม่กั้น owner, Apps Script หรือ writer อื่น. การอ่านก่อนลบ tab ไม่ใช่ provider CAS: หากมีผู้ใช้รายอื่นเปลี่ยนหรือสร้าง sheet ID เดียวกันระหว่างตรวจและส่งคำขอ ยังมี race. ต้องทบทวนสิทธิ์แต่ละ target, fence และวิธีกู้ผลไม่ชัดก่อนเปิด gate; ห้ามใช้ผลนี้แทนเงื่อนไขเหล่านั้น

การทดสอบเฉพาะส่วนใช้ SQLite และ provider mock เท่านั้น: flag ปิด, create/insert/formula/delete, timeout ทุก phase, readback ไม่พบ, data drift, concurrent create และ admin authentication/version pin. เอกสาร API สำหรับ [batch request](https://developers.google.com/workspace/sheets/api/guides/batch) และ [insertRange](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request) อธิบาย semantics ของคำสั่ง แต่ไม่ยืนยัน permission ใน workbook นี้
