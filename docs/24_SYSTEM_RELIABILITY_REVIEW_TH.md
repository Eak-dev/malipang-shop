# System reliability review — Issue #211

ขอบเขต `DEV_OWNED` จาก canonical main `51b502bbbd510d6ca0cd83382a0623cfad0b7a5b` วิเคราะห์ระบบจริงแบบ aggregate/read-only และแก้โค้ดพร้อม PR ยังไม่รวม merge/deploy ของงานนี้ สิทธิ์ AUTO_RELEASE งาน PR209/Change210 จบไปแล้ว

## สิ่งที่ตรวจพบ 27/10/2026

Production ยังใช้ Worker85 จาก PR209 ที่ 100% คิวหลัก/DLQ ค้าง 0, sync jobs 3,014 รายการ COMPLETED, failed jobs 629 รายการ RESOLVED, inbound FAILED เก่า 35 รายการ และ Online Orders ค้าง 7 รายการ ข้อมูลนี้เป็น snapshot ไม่ใช่การรับรองว่าปลอดปัญหาในอนาคต และ FAILED เก่าไม่เท่ากับจำนวนธุรกรรมสูญหาย

ตัวอย่าง metrics ของภาพค่าใช้จ่าย 14 รายการในหน้าต่างที่ตรวจ: processing เฉลี่ยประมาณ 14.7 วินาที และ classification/extraction ประมาณ 9.0 วินาที การอ่านสองชื่อ metric หลังเป็นงานเดียวกัน จึงไม่บวกซ้ำ ค่า queue wait เดิมเฉลี่ยประมาณ 15.6 วินาทียังนำไปสรุปว่า Queue ช้าไม่ได้ เพราะมีข้อผิดพลาดในการวัดตามด้านล่าง ชุดตัวอย่างนี้เล็กและไม่ครอบคลุมภาพทุกแบบ

| ลำดับ | หลักฐานและสาเหตุ | ผลกระทบ | การแก้รอบนี้ |
|---|---|---|---|
| P0 | `process-event.ts` ใช้ `Date.now()` หลังดาวน์โหลด/อ่านภาพมาคำนวณ queue wait | แยกเวลารอจริงกับเวลาประมวลผลผิด | จับเวลาเริ่มก่อน claim; แยก queue / processing / end-to-end |
| P0 | expense router `await recordMetric` อยู่ใน business try/catch | metric insert ล้มอาจหยุดรับหลักฐาน หรือทำให้ event หลัง commit ถูกมองว่าล้ม | ใช้ non-throwing telemetry ทุกจุดใน router; ยังคง throw เมื่อหลักฐาน/ข้อมูลหลักล้มจริง |
| P0 | scheduled handler `await` งานต่อกันโดยไม่มีการแยก catch | wage refresh/finalize ล้มจะข้ามการกู้ชีท/ข้อความที่เป็นอิสระ | แยก failure boundary แต่รักษา wage refresh → payroll finalize เป็นกลุ่มที่พึ่งกัน |
| P1 | readiness ตรวจ dependency ส่วน status รวมประวัติทุกช่วง | readiness ผ่านแต่ recovery บางขั้นไม่ได้ทำงานอาจไม่ชัด; FAILED เก่าปนกับปัญหาใหม่ | เพิ่ม operations summary แบบ read-only และ metrics รายขั้น |

ข้อแรกยืนยันจากโค้ดและทดสอบ clock-controlled router ส่วนกรณี telemetry/cron failure จำลองเพื่อพิสูจน์ failure boundary ไม่ได้อ้างว่าพบ wage refresh ล้มใน Production ขณะตรวจ

## พฤติกรรมใหม่

- `inbound_queue_wait_ms` และ `expense_image_queue_wait_ms`: เวลาจาก webhook รับงานถึงเริ่มประมวลผล รวม ingress/queue dispatch แต่ไม่รวม download/Vision/DB processing ติด label `INGRESS_TO_START_V2`
- `expense_image_total_ms`: processing เดิม; `expense_image_end_to_end_ms`: queue wait + processing ติด label `INGRESS_TO_COMPLETION_V2` ไม่เปลี่ยนเวลาทางธุรกิจ/วันชำระ/เวลา payroll
- เวลา ingress อ่านไม่ได้จะไม่มี queue/end-to-end sample; เวลาอนาคต clamp เป็น 0 พร้อม `clockSkew=true` และไม่ใช้ตัวอย่างนั้นใน latency summary
- Telemetry ไม่เปลี่ยนผลการรับรายการ ความผิดพลาดหลักของ R2/D1 ยังคงเข้า retry เดิม และ redelivery ไม่สร้าง Expense/Sheets job ซ้ำ
- Cron ยังทำตามลำดับเดิม แต่พยายามงานอิสระให้ครบก่อน reject invocation หากมี critical failure ไม่ retry งานภายใน runner เพิ่มเอง ใช้ retry/lease/cooldown ของฟังก์ชันเดิม
- Wage refresh ล้มจะไม่ finalize payroll ในรอบนั้น ส่วน Sheets, staff config และ LINE recovery ยังมีโอกาสทำงาน Retention คง best effort; ผล audit ที่มี `errors>0` แสดง FAILED ใน telemetry โดยไม่ทำให้ cron ทั้งรอบล้ม
- `scheduled_maintenance_step_ms` เก็บเฉพาะชื่อขั้นที่กำหนด, `SUCCESS`/`FAILED` และ duration ไม่มี raw error, employee/LINE ID หรือ payload ใน metric ใหม่นี้

กลไกนี้แยก **rejection** ของขั้นหนึ่ง งานที่ค้างโดยไม่ settle ยังอาจหน่วงขั้นถัดไป การใช้ timeout กับ D1 write ไม่ยืนยันว่าคำสั่งถูกยกเลิก จึงไม่เพิ่ม Promise.race/retry ที่เสี่ยง commit ซ้ำในงานนี้ ดู [Cloudflare D1 timeout/retry semantics](https://developers.cloudflare.com/d1/observability/debug-d1/)

## การใช้งาน operations summary

`GET /admin/operations/summary` ใช้ admin authorization เดิม ไม่มี outbound API calls และไม่กู้/replay/ส่งแจ้งเตือน ค่าที่สำคัญ:

- `window`: 24 ชั่วโมง UTC พร้อม from/to ชัดเจน
- `inbound`: failure ในช่วงล่าสุด แยก older failures กับ lease ที่ค้าง; ใช้เป็นสัญญาณตรวจ ไม่ใช้แทน lost-transaction audit
- `sideEffects`: sync ที่รอ, lease หมด, notification ที่ยังเปิด และ Push quota blocked; แสดง Reply/fallback failures ด้วย แม้ fallback ไม่สามารถสร้าง outbox row ได้ terminal DLQ อยู่ในสรุป failed jobs ไม่ถูกกู้อัตโนมัติ
- `scheduled.steps`: ผลล่าสุด/จำนวนครั้ง/จำนวนครั้งที่ล้มในช่วง 24 ชั่วโมง; tie ใช้ metric ID ใหม่สุด, อายุเกิน 15 นาทีเป็น STALE ตาม cron ทุก 5 นาทีปัจจุบัน ไม่มี sample เป็น UNKNOWN
- `latency`: samples/average/max ที่แยกตามขั้น; queue/end-to-end ใช้เฉพาะ V2 และไม่มี clock skew ไม่ตีความ sample ว่างเป็น 0ms
- `onlineOrders`: สรุปเหตุผล/อายุจาก owner review เดิม; `actions` เป็นรหัสคำแนะนำให้ตรวจต่อ ไม่ใช่คำสั่ง recovery
- `status`: ATTENTION เมื่อพบ failure/overdue ที่ต้องตรวจ, UNKNOWN เมื่อ telemetry รายขั้นยังไม่ครบ, OK เมื่อเงื่อนไขเหล่านี้ผ่าน คำว่า `ok=true` หมายถึง query สำเร็จ ไม่ใช่การรับรองสุขภาพทุก subsystem

เมื่อ query บางส่วนล้ม endpoint คืน 503 `OPERATIONS_SUMMARY_UNAVAILABLE` ไม่คืน raw error/partial green response และไม่แทนที่ `/health`, `/admin/readiness`, queue metrics หรือการกระทบยอด Sheets

## สิ่งที่ควรทำต่อจากหลักฐาน

1. เก็บ V2 latency หลัง release ให้มีจำนวนตัวอย่างพอ จึงตัดสินใจปรับ Queue หรือ image pipeline จากเวลารอจริง/อ่านภาพ/DB/Reply โดยแยกแต่ละส่วน
2. Online Order ค้างเก่า 7 รายการยังต้องใช้ owner review; 5 รายการไม่มีเลขคำสั่งซื้อ และ 1 รายการมี Expense เดิมผูกอยู่ ต้องเทียบหลักฐานเป็นรายกรณี การ release นี้ไม่เติมเลข/ชำระเงินหรือสร้างยอดย้อนหลังเอง
3. สร้างชุดภาพที่มีเฉลยเพิ่มจากกรณีจริงที่ได้รับอนุญาต โดยแยกภาพถูกตัด ยอด footer ส่วนลด วันสั่งซื้อกับวันชำระ และภาพที่ระบบจัด UNKNOWN ก่อนพิจารณาเปลี่ยน prompt/model/budget
4. ตรวจ inbound FAILED เก่ากับ audit/failed-job resolution แบบเจาะจงก่อนปิด incident หรือ replay ไม่สรุปว่าสูญหายจาก status count เพียงตัวเดียว

## Validation / release / rollback

Tests ใหม่เรียก actual router และ actual scheduled entry point กับ SQLite/mock outbound: timing ที่ควบคุม clock, metric outage + Reply503, primary evidence failure, redelivery, failure ของทุกขั้นสำคัญ, payroll dependency, pending outbox recovery/cooldown, retention partial errors และ aggregate authorization/privacy/unknown/stale/error semantics ร่วมกับ regression เดิม ไม่มี live financial posting/LINE send หรือ Production mutation ใน development stage

Risk High จาก scheduled failure ordering; ไม่มี migration/config/dependency/binding/cron/queue topology หรือกติกาเงิน/สิทธิ์เปลี่ยน ก่อน release ต้องผ่าน exact-head CI/check/dry-run และอนุมัติ Production Change ของงานนี้ พร้อม private backup/rollback/readiness/reconciliation

ต้นทุน operational telemetry เพิ่ม 6 metric rows ต่อ cron cycle (ประมาณ 1,728 rows/วันเมื่อทุก 5 นาที) ใช้ D1/metric table เดิมและไม่เพิ่ม OpenAI calls หรือเปลี่ยน data-retention policy

Manual UAT หลังอนุมัติ: ตรวจ unauthorized summary401 → authorized summary200 → UNKNOWN ก่อน cron ใหม่รอบแรก → หลัง cron ตรวจ 6 ขั้นและ newest outcome → กรณีทดสอบที่กำหนดเห็น queue/processing/end-to-end สมเหตุผล → ตรวจ optional notification/Sheets recovery ไม่ replay transaction ห้ามฉีด wage/R2/DB failure หรือสร้าง punch/Expense ทดสอบลง Production; ใช้ isolated fixtures สำหรับ failure injection

Rollback deploy previous Worker85 (`d257a121-3f40-4aa8-9f71-b999f56fca1a` ณ snapshot) คง metrics/audit และธุรกรรมที่ชอบธรรมไว้ ไม่มี schema rollback ห้ามลบ/แก้ประวัติสถิติเก่าเพื่อให้กราฟดูผ่าน เมื่อ rollback cron จะกลับไปมี failure-chain เดิมและ operations summary ใหม่จะไม่อยู่ จึงใช้ readiness/status/queue checks เดิมระหว่าง forward fix
