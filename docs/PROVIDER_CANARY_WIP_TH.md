# Candidate ตรวจสิทธิ์เขียนด้วยบัญชีระบบ

ยังไม่ได้ deploy, activate หรือเขียน workbook จริง และไม่ใช่หลักฐานความพร้อมใช้งาน Production

`POST /admin/stable-sync/provider-canary` ต้องผ่าน admin authentication, pin Worker version, flag `CONTINUOUS_PROVIDER_CANARY_ENABLED=true` และ activation ใน D1. `prepare` ลงทะเบียน tab ชื่อสุ่มพร้อม fingerprint ของบัญชีระบบและ Worker version; ทุก phase ต้องตรงกัน หาก deploy หรือเปลี่ยน credential ระหว่างทางจะพักไว้. `step` สร้าง tab พร้อม marker และสูตร แล้วอ่านกลับ ก่อน insertRange และอ่านสูตร ค่า และตำแหน่งกลับ เมื่อสำเร็จหยุดที่ VERIFIED และเก็บ tab ชื่อสุ่มไว้ ไม่มีคำสั่งลบอัตโนมัติ

ก่อนแต่ละ POST มี D1 intent และต้องบันทึกคำตอบสำเร็จจาก Google ก่อนตรวจผลกลับ หากคำตอบสูญหายแม้เห็นผลตรงกันก็พักไว้ ไม่ถือว่าเป็นหลักฐานสิทธิ์และไม่ส่งซ้ำ การ deploy หรือเปลี่ยน credential ระหว่างทางอาจทำให้งานค้าง ต้องตรวจและจัดการแยกภายหลัง

ขอบเขตหลักฐาน: การผ่านด้วย credential ของ Worker พิสูจน์เฉพาะการทำงานบน scratch tab ใน workbook ขณะนั้น ไม่พิสูจน์สิทธิ์บน protected ranges หรือการแทรกใน tab รายวันจริง และไม่กั้น owner, Apps Script หรือ writer อื่น ต้องทบทวนสิทธิ์แต่ละ target, fence และวิธีกู้ผลไม่ชัดก่อนเปิด gate; ห้ามใช้ผลนี้แทนเงื่อนไขเหล่านั้น

การทดสอบเฉพาะส่วนใช้ SQLite และ provider mock เท่านั้น: flag ปิด, create/insert/formula, timeout, readback ไม่พบ, data drift, concurrent create และ admin authentication/version pin. [เอกสาร batch request](https://developers.google.com/workspace/sheets/api/guides/batch) และ [insertRange](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request) อธิบาย semantics ของคำสั่ง แต่ไม่ยืนยัน permission ใน workbook นี้
