# Issue #296: กู้ Canary ที่ติดก่อนเขียนรายวัน

ใช้เฉพาะ incident ที่ claim เป็น `REVIEW / OPERATION / INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA` กับรายการ `[SYSTEM TEST]` 1 บาท v1 ที่ Canary สร้างขึ้นเท่านั้น ไม่ใช่เครื่องมือ replay ทั่วไป และไม่ใช้กับธุรกรรมร้าน

## เงื่อนไขก่อนเริ่ม

- ตรวจ Worker version และ source code ที่ทำให้เกิด incident: ต้องพิสูจน์ได้ว่า error นี้เกิดก่อนการจอง intent หรือส่งคำสั่งเขียนรายการ และคำสั่งแจ้งพักไฟล์ก่อนหน้านั้นได้รับผลตอบกลับสำเร็จแล้ว การไม่พบแถวในชีตเพียงอย่างเดียวไม่พิสูจน์ว่าคำสั่งเก่าจบแล้ว
- ตรวจและกั้นผู้เขียนเก่า ผู้ใช้ Apps Script และระบบภายนอกแยกต่างหาก ตัวล็อกใน D1 และระยะเวลาที่ผ่านไปไม่ใช่หลักฐานว่าผู้เขียนเหล่านี้หยุดแล้ว
- ตรวจสดว่าคง recovery gate, Canary operator และ pacing ไว้ มีเพียงรายการทดสอบเป้าหมายที่ตรงเงื่อนไข และไม่มีงานกำลังประมวลผลหรือ journal ที่ผลยังไม่แน่ชัด ตัวตรวจในระบบจะตรวจซ้ำ ไม่รับ SQL หรือรหัสรายการจากผู้เรียก
- ใช้ backup ส่วนตัวที่เพิ่งตรวจ checksum, restore, integrity และ foreign keys ผ่าน และซ้อม migration กับสำเนาก่อน เปรียบเทียบเวอร์ชัน Worker และค่าตั้งค่าจริงกับ commit ที่ตรวจแล้ว
- เจ้าของต้องอนุมัติวิธีกู้ incident ที่ตรวจเสร็จแล้วโดยเฉพาะ ก่อน migrate, deploy หรือเรียก operator ของ incident นี้ ใช้ GitHub protected `production` environment และความเห็นชอบที่เกี่ยวข้องตาม runbook หลัก
- Candidate release เปิด `CANARY_UNWRITTEN_RECOVERY_ENABLED` ชั่วคราว; โค้ด default off เมื่อไม่ตั้งค่านี้ หลัง Canary ผ่าน ต้องปิด flag นี้และ `CONTINUOUS_CANARY_OPERATOR_ENABLED` ก่อนปล่อย gate

## วิธีดำเนินงานเมื่อได้รับอนุมัติ

1. ผ่าน preflight และ backup; apply migration `0063` และ deploy commit ที่ตรวจแล้วตาม workflow release ทีละขั้น อ่าน ledger, configuration และ Worker version กลับทุกขั้น อย่า rollback ไป Worker ก่อน ACTIVATE
2. ใช้ workflow `prod-canary-unwritten-recovery.yml` แบบ manual และ protected เท่านั้น ระบุ SHA ของ main, hash ของ Worker version ที่รับ 100%, คำยืนยันและการยืนยันว่าผู้เขียนภายนอกถูกกั้น ตามเงื่อนไขของ workflow
3. เรียก `PROBE` เพื่ออ่านและตรวจ provider จริงโดยไม่เขียน หากผ่านจึงเรียก `TIME` หนึ่งครั้ง และตรวจว่า audit เป็น `TIME_ACKED` แล้วจึงเรียก `STATUS` หนึ่งครั้ง ตรวจว่าเป็น `STATUS_ACKED` ตัวดำเนินการตรวจสูตรรายงานและ snapshot ของชีตซ้ำ ตรวจรูปแบบและ named ranges ของข้อความพักไฟล์ และบันทึก intent ก่อนส่งคำสั่งแต่ละครั้ง
4. เรียก `COMMIT` หนึ่งครั้งเมื่อสองขั้นก่อนหน้าได้รับผลตอบกลับบวกและตรวจข้อมูลตรงกันเท่านั้น การปรับ admission, งาน Canary และ claim เกิดใน D1 transaction เดียวกัน เก็บ epoch เดิมและประวัติ failure ไว้
5. หากคำตอบไม่ครบ ไม่ตรง หรือ connection หาย ให้หยุดและคง fence ห้าม re-run workflow หรือส่งคำสั่งเดิมซ้ำ การพบ `TIME_IN_FLIGHT` หรือ `STATUS_IN_FLIGHT` หมายถึงต้องวิเคราะห์ incident ใหม่ ไม่ใช่สิทธิ์ให้ retry
6. เมื่อ commit ผ่าน ตรวจ D1 และชีตแล้วดำเนิน Canary confirm, duplicate และ Undo ต่อจน `VERIFIED` ก่อนปิด flag ชั่วคราว ปล่อย recovery gate และตรวจ backlog ตาม runbook หลัก

ตัวตรวจใช้ hash เปรียบเทียบ snapshot และไม่ส่งข้อมูลรายการหรือเนื้อหาชีตไปยัง log หรือผล HTTP การซ้อมที่จำลอง provider เป็นหลักฐานทดสอบโค้ด ไม่ใช่หลักฐานยืนยันสถานะ provider จริง

หาก `PROBE` ไม่ผ่าน ผลตรวจแสดงเฉพาะชื่อขั้นและรหัสข้อผิดพลาดที่กำหนดไว้ ไม่แสดงข้อมูลร้านหรือข้อความจาก provider ใช้ข้อมูลนี้ตรวจสาเหตุก่อนดำเนินขั้นที่เขียนข้อมูล

คำขอ Google ที่ใช้ขีดจำกัดร่วมกำหนด redirect เป็น `manual` ซึ่ง Cloudflare Workers รองรับ และปฏิเสธผล HTTP 3xx โดยไม่ส่ง credential ต่อไปยังปลายทาง redirect
