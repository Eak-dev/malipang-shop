# การกู้ Canary รายวันที่เขียนแล้วและมีแถวว่างเกินหนึ่งแถว

เครื่องมือนี้จำกัดเฉพาะ Canary ยอดหนึ่งบาทที่มีหลักฐาน `canary_unwritten_recovery` เดิมเป็น `COMPLETE`, claim `REVIEW / OPERATION` เหตุ `INSERT_DAILY_SNAPSHOT_UNVERIFIED`, journal รายวันและ marker ที่ตรงกัน และ epoch เป้าหมายเดียว ห้ามใช้เป็นเครื่องมือกู้รายการทั่วไป ระบบไม่เปิด notice dispatcher หรือ review close ทั่วไป

ก่อนใช้ต้องมี backup ส่วนตัวที่ตรวจ restore/integrity/foreign keys ผ่าน ตรวจ Worker, D1, ชีตและรายงานปัจจุบัน ยืนยันว่าไม่มีผู้เขียนภายนอกและเจ้าของเฝ้าดูจริง ใช้ workflow `prod-canary-daily-incident.yml` บน main ผ่าน production environment และปัก SHA กับ Worker version เท่านั้น หนึ่ง run ต่อหนึ่ง phase:

1. `VERIFY`: ตรวจ snapshot และ digest ก่อน/หลัง, source, notice, รายงาน, งบและ format แล้วบันทึกเฉพาะ journal/preimage ที่พิสูจน์ว่าลงชีตแล้ว ไม่ส่งรายการซ้ำ
2. `TIME`: บันทึก intent และเปลี่ยนเวลา notice แบบมี preimage guard; `TIME_READBACK` อ่านยืนยันและบันทึกผลโดยไม่ส่งซ้ำ
3. `STATUS`: บันทึก intent ก่อนเปลี่ยนสถานะ notice และต้องได้คำตอบบวกจาก provider จึงบันทึก `STATUS_ACKED`
4. `COMMIT`: ตรวจหลักฐานซ้ำ แล้วบันทึกสถานะงานและปล่อยเฉพาะ claim ที่ตรงกันใน transaction จากนั้นอ่านสถานะ D1 และ provider กลับ

หาก `STATUS` หยุดก่อนส่งและ durable state ยังเป็น `TIME_VERIFIED` ใช้ `PROBE_STATUS` แบบอ่านอย่างเดียวเพื่อตรวจขั้น preflight พร้อมขีดจำกัดคำขอเดียวกัน ผลแสดงเฉพาะชื่อขั้นและจำนวนคำขอที่เหลือ การผ่านไม่ใช่สิทธิ์ให้ส่งคำสั่งที่ผลยังไม่แน่ชัดซ้ำ

ถ้าคำตอบหาย ขัดแย้ง หรือขั้นใดไม่ผ่าน ให้หยุดและอ่าน durable state กับ provider ก่อน ห้าม dispatch phase ที่อาจส่งคำสั่งซ้ำ ความไม่มีข้อมูลอย่างเดียวไม่พิสูจน์ว่า provider ไม่ได้รับคำสั่ง การกู้ projection ไม่ใช่หลักฐานว่า Canary ผ่าน ต้องทดสอบรายงาน รายการซ้ำ และ Undo ตาม runbook เดิมก่อนปลด gate

### D1 ปฏิเสธการบันทึก STATUS ก่อนส่งไป Google

- OBSERVED: หลัง TIME ผ่าน การเริ่ม STATUS ไม่ผ่านและไม่มี attempt หรือคำขอ STATUS ถูกบันทึกไว้; claim และงานยังอยู่ใน REVIEW.
- EXPECTED: ตรวจสถานะปัจจุบันตามเงื่อนไขเดิม บันทึก attempt แล้วจึงส่ง STATUS ได้ครั้งเดียว และ COMMIT ต่อได้เมื่อมีหลักฐานตอบรับ.
- REPRODUCTION / ROOT_CAUSE: บน Cloudflare D1 เงื่อนไข `GLOB` ที่มีข้อความไทยยาวใน trigger และคำสั่ง COMMIT เกินขีดจำกัด pattern; runtime จำลองให้ `LIKE or GLOB pattern too complex` เช่นเดียวกับ D1. SQLite ในชุดทดสอบปกติไม่เปิดเผยข้อจำกัดนี้.
- AFFECTED_PATH / DATA_IMPACT: trigger `continuous_notice_status_attempt_insert` และการตรวจ prefix ใน notice-close COMMIT; ความล้มเหลวเกิดก่อน dispatch STATUS และไม่มีการเขียนรายการธุรกิจเพิ่มเติมจากขั้นนี้.
- FIX: migration 0064 เปลี่ยนเฉพาะการตรวจ literal prefix ให้เป็น `substr` โดยคงเงื่อนไขอื่นทั้งหมด และแก้ COMMIT ใน Worker เช่นเดียวกัน. เทสต์รัน STATUS และ COMMIT ผ่าน Miniflare D1 และตรวจความเทียบเท่าของ prefix รวมทั้งค่า null. Migration สร้าง trigger เดิมใหม่จึงรันซ้ำได้; ก่อน Production ต้องสำรองส่วนตัวและซ้อม migration บนสำเนาที่ restore แล้ว. หากพบปัญหาให้คง gate และ claim ไว้ ตรวจหลักฐานก่อนแก้ไปข้างหน้า; ห้ามส่ง STATUS ซ้ำหากผลการส่งครั้งก่อนยังไม่แน่ชัด.

### RAW Canary: provider read timeout หลังมีแถวที่ตรงหลักฐาน

- OBSERVED: งาน v1 ถูกพักใน REVIEW ด้วยเหตุ `TIMEOUT` ขณะ journal `EXPENSE_RAW` เป็น IN_FLIGHT. แถวใน Google มี carrier ของ Canary ตรง marker ที่จองไว้เพียงหนึ่งรายการ และ full-grid before/payload digest ตรงกับหลักฐานก่อนส่ง. ยังไม่ได้ถือว่า journal VERIFIED จากการอ่านด้วยมือเพียงอย่างเดียว.
- EXPECTED / DATA IMPACT: ยืนยัน postimage ที่ตรงกันครบทุก guard แล้วค่อยปิด incident เฉพาะงานสังเคราะห์ โดยไม่ส่งคำขอเขียน RAW ซ้ำหรือเปลี่ยนรายการธุรกิจอื่น. สาเหตุเชิงลึกของ timeout ยังไม่ทราบ; การกู้นี้ไม่อ้างว่าแก้สาเหตุ network แล้ว.
- IMPLEMENTATION: route Canary RAW เฉพาะรายการบังคับ source, claim `TIMEOUT`, epoch, journal, evidence, marker reservation, ตำแหน่งกริดและผล DAILY ก่อนหน้า; ใช้ positive ledger verification และ notice-close เดิมพร้อม request budget แยก VERIFY, TIME, TIME_READBACK, PROBE_STATUS, STATUS และ COMMIT. ผลที่ไม่ชัดต้องตรวจ D1/ผู้ให้บริการ ห้าม retry คำขอที่อาจส่งไปแล้ว. ฟังก์ชันทั่วไปและ dispatch อัตโนมัติยังคงปิด.
- VALIDATION / ROLLBACK: เทสต์ scope และ negative cases; ซ้อมกับสำเนาฐานข้อมูลส่วนตัวและ snapshot RAW จริง โดยจำลองการตอบ notice และ report-health เท่านั้น. ก่อน deploy ทำ preflight และเก็บ Worker rollback ตาม workflow; กรณีไม่ผ่านคง gate และ claim แล้วตรวจหลักฐานเพื่อแก้ไปข้างหน้า ห้าม rollback ข้อมูลย้อนหลัง.

### COMMIT สำเร็จแต่ workflow ไม่ได้รับผลยืนยัน

Cloudflare D1 รายงาน `meta.changes=2` เมื่อคำสั่งลบ claim หนึ่งแถวทำให้ trigger ปิด alert incident หนึ่งแถวด้วย จึงเกิด `REVIEW_CLOSE_COMMIT_UNCERTAIN` หลังธุรกรรม commit แล้ว. จำลองบน Miniflare D1 ได้จำนวน `[1,1,2,1,0]` และตรวจ Production พบ notice COMPLETE, admission VERIFIED, ไม่มี claim และงาน PENDING; ห้ามส่ง COMMIT ซ้ำ. ตัวตรวจใหม่ยอมรับจำนวนรวม 1 หรือ 2 เฉพาะคำสั่งลบ claim โดย guard `changes()=1` ใน transaction ยังคงบังคับว่าลบ claim โดยตรงหนึ่งแถว และยังปฏิเสธจำนวนอื่น. ไม่เปลี่ยน policy หรือรายการธุรกิจ.

### ผลปิดงานรวม trigger แจ้งเตือน

เมื่อ Canary ที่เคยอยู่ REVIEW ผ่านการตรวจทุก projection แล้วเปลี่ยนงานเป็น COMPLETED, D1 นับการปิด alert ของงานรวมกับ update งานเป็นสองการเปลี่ยนแปลง ทำให้ `STABLE_EXPENSE_COMPLETION_UNCERTAIN` หลังงาน commit แล้ว. หลักฐาน Production คือ job COMPLETED, DAILY/RAW/DETAIL VERIFIED และ alert ปิดใน timestamp เดียวกับงาน; claim ยังคง REVIEW และ epoch ARMED. ห้ามรัน confirmation ซ้ำหรือปลด claim ด้วย SQL ทั่วไป. ตัวตรวจ completion ของยืนยันและ Undo รองรับจำนวนรวม 1 หรือ 2 ภายใต้ unique job key และ guard เดิม; จำนวนอื่นยังหยุด. การกู้ claim ต้องมีหลักฐาน provider และขั้น notice ที่ออกแบบเฉพาะเหตุนี้แยกต่างหาก.

### กู้ล็อกหลังงานสังเคราะห์ COMPLETED

เพิ่ม migration `0065` และ operator เฉพาะเหตุ `STABLE_EXPENSE_COMPLETION_UNCERTAIN` ของ Canary v1: ตรวจ job COMPLETED, alert ปิดพร้อมเวลา job, projection ทั้งสาม VERIFIED พร้อม preimage/marker, epoch/admission, source revision, ล็อกเดิมและรายงานจริง ก่อนเปลี่ยน notice. Workflow ใช้ PROBE → TIME → PROBE_STATUS → STATUS → COMMIT แยกครั้ง พร้อม intent ก่อนแต่ละ provider POST และบันทึก ACK เฉพาะผลตอบรับแน่ชัด; คำตอบไม่แน่ชัดต้องคง REVIEW และห้ามส่ง POST ซ้ำ. COMMIT ตรวจซ้ำแล้วปิด admission/epoch และปล่อย claim เฉพาะรายการใน transaction เดียว โดยไม่เปลี่ยนธุรกรรมหรือ journal. ซ้อมบนสำเนา Production และ Miniflare D1 รวม integrity/FK; ผล provider ในการซ้อมจำลอง จึงต้องตรวจ PROBE จริงก่อนใช้งาน. สำรองส่วนตัวและซ้อม migration ใหม่ก่อน Production; หากไม่ผ่านคง gate และใช้ forward-fix ห้ามแก้ฐานข้อมูลย้อนหลังหรือ replay งาน.

### RAW Undo ตอบ timeout หลังเขียนแล้ว

Canary v2 ผ่านการยกเลิก DAILY แล้วค้างที่ `EXPENSE_RAW` ด้วย `TIMEOUT`; carrier ใน Google เป็น CANCELLED พร้อม marker เฉพาะหนึ่งรายการ และ before/payload digest ของทั้งกริดตรง evidence. อาการนี้เกิดซ้ำกับทั้งยืนยันและ Undo; ข้อความ timeout ใน log ถูกลดรายละเอียด จึงยังระบุไม่ได้แน่ชัดว่า Google Sheets GET หรือ OAuth ขั้นใดหมดเวลา. ห้ามอ้างว่าแก้สาเหตุ timeout แล้ว. Operator ใหม่รับเฉพาะ Canary v2, claim TIMEOUT, v1 COMPLETED, DAILY Undo VERIFIED และ RAW Undo evidence ตามตำแหน่งที่สังเกต; ใช้ positive ledger verifier และ notice-close เดิมโดยไม่ส่งคำขอยกเลิกซ้ำ. ซ้อมบนสำเนา Production ที่ restore และ snapshot จริง; provider notice/report health ในการซ้อมจำลอง. ผลไม่แน่ชัดคง REVIEW และตรวจ D1/Google ห้าม retry POST. ก่อนเปิดใช้งานจริงต้องประเมิน timeout ที่เกิดซ้ำและหลักฐานความเชื่อถือได้เพิ่มเติม.
