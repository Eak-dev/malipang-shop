# Owner correction: แผนเตรียม UAT แยกจาก production

สถานะ: **ยังไม่พร้อมทดสอบบริการจริง และยังไม่ถือว่า UAT ผ่าน**
หลักฐานสำรวจแบบอ่านอย่างเดียว วันที่ 2 พ.ย. 2569 เวลา 14:02 น. ประเทศไทย; PR #222 ยังเป็น draft และมีงานใน worktree ที่ยังไม่ได้รวม SHA สุดท้าย

## สิ่งที่ตรวจพบ

| ส่วน | หลักฐาน | สิ่งที่ยังต้องทำ |
|---|---|---|
| D1 | มีฐาน `malipang-v5-2-uat` แยกชื่อจาก production; ตรวจ schema แล้วไม่พบตาราง owner correction | พิสูจน์ว่า Worker UAT ผูก UUID ของฐาน UAT จริง ตรวจข้อมูลว่าเป็น synthetic และลง migration เฉพาะ UAT หลังเตรียม recovery และปัก SHA |
| Queues | มี `malipang-jobs-uat` และ `malipang-jobs-uat-dlq`; ตรวจพบว่าแต่ละคิวยังไม่มี consumer | ผูก consumer กับ Worker UAT ที่ตรวจสอบแล้ว กำหนด `JOB_QUEUE_NAME` และ `JOB_DLQ_NAME` ให้ตรง และทดสอบเส้นทาง JOB/DLQ/retry ด้วยข้อมูลจำลอง |
| Worker | Worker ชื่อ `malispang-lineoa-test` มีอยู่ แต่ binding แสดงว่าเป็นแอป LINE อีกชุด ไม่มี `DB` หรือ `JOB_QUEUE` ของ backend นี้ | ยังไม่มีหลักฐานว่า Worker UAT สำหรับ owner correction ถูกติดตั้ง ต้องจัด Worker แยก ตรวจ bindings, version และห้ามผูก production resources |
| LINE | มี Worker ทดสอบสำหรับ LINE อีกแอป แต่ยังพิสูจน์ไม่ได้ว่า channel นี้ใช้กับ backend UAT ได้โดยไม่รบกวนระบบเดิม | ต้องมี channel ทดสอบและ tester ที่แยกชัดเจน ตรวจ channel identity, secret binding และเส้นทาง webhook ของ UAT โดยไม่เปลี่ยน webhook production |
| Sheets | พบไฟล์ `QA_ONLY_MaliPang_Daily_and_Small_Synthetic` มี 8 แท็บและมีป้าย synthetic ในช่วงหัวตารางที่ตรวจ | ใช้เป็นข้อมูลอ้างอิงบางส่วนเท่านั้น ยังไม่ครบโครงสร้าง owner correction หรือพิสูจน์สิทธิ์/สูตร/การเชื่อมต่อได้ครบ |
| Preflight | `scripts/owner-correction-uat-preflight.mjs` ตรวจ Cloudflare ผ่าน GET และเปรียบเทียบ Worker, D1, queue, DLQ, R2 กับ production config | เครื่องมือจงใจคืน `ready: false` เสมอ: Cloudflare ไม่เปิดค่า secret จึงยังพิสูจน์ LINE/Sheets binding และผู้ใช้/ข้อมูล synthetic ไม่ได้ ต้องเพิ่มหลักฐานอิสระก่อนนำไปใช้เป็น release gate |

## ผลตรวจชีต QA_ONLY

ตรวจ metadata ของทุกแท็บและค่าหรือสูตรในช่วง A1:Z1000 ตามขนาด grid ที่อ่านได้แบบ read-only: `30_SMALL_SALES_DETAIL`, `27_SMALL_BREAD_DAILY`, `28_SMALL_COST_ESTIMATE`, `V2_SMALL_FILLING_LIST`, `รายวัน`, `V52_EXPENSE_RAW`, `97_EXPENSE_CLEAN`, `BRIDGE_QA`. มีป้าย `QA ONLY — SYNTHETIC DATA` ในช่วงต้นของแท็บ `รายวัน`, `V52_EXPENSE_RAW` และ `97_EXPENSE_CLEAN` ที่ตรวจ

ไฟล์นี้ **ยังไม่ใช่ template ที่พร้อมทดสอบ owner correction**: ไม่มีแท็บ `รายละเอียดการซื้อ`, `04_OWNER_MONTH_CLOSE` และ `35_EXPENSE_FLOW_CHECK`; หัวตารางและบล็อกเดือนใน `รายวัน` ไม่ใช่โครงสร้างที่ runtime ต้องตรวจ และ `97_EXPENSE_CLEAN!A2` ที่ตรวจเป็นค่า ไม่ใช่สูตรที่ verifier กำหนด. ตัวตรวจรายงานยังอ้างสูตรและช่วงตรวจเฉพาะ ตลอดจน digest ของสูตรที่กำหนดในโค้ด จึงต้องสร้าง fixture รายงานที่ตรงกติกาของ SHA ที่จะทดสอบและพิสูจน์ด้วยการอ่านกลับจริง

ในช่วงที่ตรวจไม่พบสูตรที่มี `IMPORTRANGE`, `IMPORTDATA`, `IMPORTXML`, `IMPORTHTML`, `GOOGLEFINANCE` หรือ URL; **ผลนี้ไม่ได้พิสูจน์** ว่าไม่มี Apps Script, custom function, การแชร์, ตัวเชื่อมต่อ หรือข้อมูลจริงทั้งไฟล์. ไม่ควรคัดลอกไฟล์ที่มีข้อมูลจริงมาใช้เป็น UAT โดยยังไม่ได้ตรวจข้อมูลและการเชื่อมต่อ

## ขั้นตอนก่อนเริ่ม UAT จริง

1. ตรึง commit SHA หลังรวมโค้ดและ migration ที่จะทดสอบทั้งหมด ตรวจ CI และ local regression; ห้ามใช้ worktree ที่ยังมีการแก้ไขค้างเป็นหลักฐานเปิดใช้
2. จัดทำ spreadsheet ใหม่ที่มีเฉพาะข้อมูลสมมติและแท็บ/สูตร/หัวตาราง/metadata ที่ verifier ของ SHA นั้นต้องการ: `รายวัน`, `V52_EXPENSE_RAW`, `รายละเอียดการซื้อ`, `97_EXPENSE_CLEAN`, `04_OWNER_MONTH_CLOSE`, `35_EXPENSE_FLOW_CHECK` และส่วนอื่นที่จำเป็น ทดสอบยอด รายการย่อย วันและรอบบัตรในเดือนที่ verifier รองรับ ตรวจสูตรภายนอก สิทธิ์แชร์ protected ranges และ Apps Script/trigger แยกต่างหาก
3. ติดตั้ง Worker UAT ภายใต้ชื่อแยก กำหนด `APP_ENV=uat`, `RUNTIME_MODE=shadow`, `SHADOW_LINE_OUTPUT=true` เพื่อให้ตอบ LINE ทดสอบจริง โดยผูกเฉพาะ D1, queue, DLQ, R2, Sheets และ channel ทดสอบ; ไม่ใช้ credentials หรือข้อมูล production ใน fixtures และไม่ส่ง webhook จาก production มาที่ UAT
4. สำรองฐาน UAT ตามความเหมาะสม ทดสอบ migration บนฐาน local ที่สร้างจาก schema ตัวอย่างก่อน แล้วลง migration เฉพาะ D1 UAT; ตรวจชื่อฐานจริงก่อนสั่ง ตรวจ integrity/foreign keys และทดสอบการลงซ้ำ. ใช้บัญชี owner และ staff จำลอง มี verified LINE binding เฉพาะ channel UAT
5. ตั้งค่า `JOB_QUEUE_NAME` และ `JOB_DLQ_NAME` ให้ตรงคิวแยก ตรวจ consumer/DLQ binding ก่อนเริ่มรับข้อความ. Worker จะ retry หาก config ผิดหรือคิวไม่รู้จัก แต่ retry มีขีดจำกัด: ต้องเฝ้า alert และแก้ config ก่อนเปิด consumer ไม่อ้างว่า retry ไม่จำกัดหรือไม่มีทางสูญหาย
6. ยืนยันจากผู้มีสิทธิ์และหลักฐานอิสระว่า Worker UAT ใช้ LINE channel และ spreadsheet ทดสอบจริง รวมทั้งไม่มีสิทธิ์เขียนไปยัง production; Cloudflare settings ที่แสดงเพียงชื่อ secret ไม่ใช่หลักฐานนี้ ตรวจ preflight และบันทึกหลักฐานโดยไม่เผย secrets, LINE user IDs หรือข้อมูลบุคคล
7. เมื่อ isolation ได้รับการพิสูจน์ ทดสอบผ่าน LINE/Worker/D1/Sheets จริงด้วยข้อมูลสมมติ ครอบคลุมค้นหาและแก้ 5 ช่อง, owner/staff, pending/confirmed, กดซ้ำ, แก้พร้อมกัน, แทรกแถว, ย้ายเดือน/รอบบัตร, หลายรายการต่อใบเสร็จ, LINE/Sheets ขัดข้อง, unknown outcomes และ DLQ/recovery. อ่าน D1, ชีตรายวัน, raw, รายละเอียดและรายงานกลับมาตรวจว่าตรงกัน; รายการที่ยังไม่รองรับต้องพักตรวจ ไม่บันทึกหรือเดา
8. บันทึกผลแต่ละกรณีและ SHA พร้อม evidence ที่ไม่เปิดเผยข้อมูลส่วนตัว ตรวจรายการซ้ำ/สูญหายและสิทธิ์ หากไม่ผ่านให้ปิดรับคำแก้และรักษาคิว/ประวัติตามขั้นตอน rollback; ห้ามถือว่า UAT ผ่านเพียงเพราะ deploy หรือ preflight สำเร็จ

## ข้อจำกัดของ code และการย้อนกลับ

การทดสอบในเครื่องเป็น fixture ไม่ใช่หลักฐานว่าบริการจริงเชื่อมต่อสำเร็จ. การย้ายข้ามเดือนและโครงสร้างที่ยังอยู่ระหว่างพัฒนาต้องตรวจ integration ของ SHA สุดท้ายก่อนกำหนด expected outcome ไม่สมมติว่าทำงานได้แล้ว. หลังเปิดใช้ correction แล้ว การ rollback ห้ามลบตาราง shared fence และต้องคงการกู้คิวที่คอมมิตแล้วไว้ รวมถึงรอผลคำสั่ง Sheets ที่ยังไม่แน่นอนและ drain Worker รุ่นเก่าก่อนเปลี่ยนเวอร์ชัน
