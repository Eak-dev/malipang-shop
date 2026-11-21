# Issue 248 — terminal Sheets delivery guard: local review

Candidate สำหรับตรวจเท่านั้น: คง `OPEN DEAD_LETTER_MAX_RETRIES` ของ SHEETS_SYNC ทุก entity โดยไม่ dispatch หรือแก้ Production จากเอกสารนี้

- duplicate delivery ที่พบ terminal ก่อนเริ่มงานต้อง ACK โดยไม่ส่งซ้ำหรือเรียก provider; job lease และ workbook admission มี D1 predicate ตรวจ terminal ซ้ำแบบ atomic
- terminal ที่เกิดหลัง notice authorization อาจชน provider call ที่เริ่มไปแล้ว การตรวจภายหลังจะคง workbook REVIEW เพื่อสอบสวน แต่ไม่สามารถยกเลิก request ที่ส่งไปแล้ว หรือรับประกันว่าไม่มี provider call ในหน้าต่างระหว่างการตรวจ จึงต้องจัดสถานะที่เกี่ยวข้องเป็น UNKNOWN และกระทบยอดก่อนดำเนินการ
- ป้องกัน transient failure เขียนทับ terminal sentinel/payload และป้องกัน duplicate success/IGNORED ปิด terminal โดยอัตโนมัติ; LINE และ STAFF_CONFIG_SYNC ไม่ถูกเปลี่ยนนโยบาย terminal ด้วย candidate นี้
- `includeTerminalDlq=true` ใน recovery API เดิมยัง enqueue ได้ แต่ worker จะไม่ claim งานขณะ terminal ยัง OPEN; การปลดต้องมีการกระทบยอดและขั้นตอน per-item แยกที่ตรวจสอบได้ ไม่ใช่การ replay ทั้งชุด
- ตรวจสอบ D1 subrequest budget และผลต่อ nonterminal payroll/attendance ทั้งชุดก่อน release; การทดสอบ synthetic ไม่พิสูจน์ provider state จริง
