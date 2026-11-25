# ลำดับการส่งค่าใช้จ่ายจาก D1 ไป Google Sheets

ใช้รับช่วงงาน #296 และ #348 ใน PR #349 อ้างอิงโค้ด `5a72db3` อ่านจากบนลงล่าง ลูกศรทึบคือการเรียกหรือส่งงาน ลูกศรประคือผลที่ตอบกลับ **A** คือรายการเดิมที่พัก **B** คือรายการแรกที่ได้รับสิทธิ์ และ **C** คือรายการถัดไป ทั้งสามเป็นชื่อสมมติ ภาพอธิบายโค้ดใน PR ส่วนสถานะคิวและจำนวนที่ส่งบน Production ต้องตรวจแยกตามเวลาจริง

[เปิดฉบับ PDF](serial-sequence.pdf) · [ภาพรวมระบบ](README.md) · [คู่มือ UAT และการใช้งาน](../ISSUE296_NORMAL_QUEUE_PILOT_TH.md)

## 1. จากการกดยืนยันใน LINE ถึงงานรอใน D1

```mermaid
sequenceDiagram
    autonumber
    participant L as LINE
    participant H as Webhook
    participant Q as Cloudflare Queue
    participant W as Worker คิว
    participant D as D1
    L->>H: POST /webhook/line พร้อมเหตุการณ์ยืนยัน
    H->>H: ตรวจขนาดและลายเซ็น แล้วแปลงเหตุการณ์
    H->>Q: ส่ง LINE_EVENT เข้าคิว
    H-->>L: HTTP 200 หลังรับเข้าคิว
    Q->>W: ส่ง LINE_EVENT ให้ประมวลผล
    W->>D: ตรวจเหตุการณ์ซ้ำ สิทธิ์ และรุ่นค่าใช้จ่าย
    W->>D: ยืนยันรายการและสร้าง sync_jobs เมื่อเปิดซิงก์
    D-->>W: ธุรกรรมผ่าน งานรายงานเป็น PENDING
    W->>Q: ส่ง SHEETS_SYNC หลังบันทึก D1
    Note over Q,D: ถ้าข้อความปลุกส่งไม่ถึง งาน PENDING ยังอยู่ใน D1
```

HTTP 200 ยืนยันว่า webhook รับเหตุการณ์แล้ว ส่วนยอดที่ร้านยืนยันดูจาก `expense_events` และรุ่นข้อมูลใน D1 เมื่อมี claim ของไฟล์อยู่ใน `REVIEW` ตัวกู้คิวงดส่งงาน ส่วนข้อความที่ถึง Worker แล้วอาจจบด้วย `BLOCKED` และ ACK โดยงานรอยังอยู่ใน D1. [Webhook](../../src/webhook/handler.ts) · [ยืนยันและสร้างงาน](../../src/expense/confirm.ts) · [ปลุกคิวหลังบันทึก](../../src/expense/service.ts) · [ตัวกู้คิว](../../src/db/repositories.ts)

## 2. เลือกชุดงาน พิสูจน์ A และจอง B

```mermaid
sequenceDiagram
    autonumber
    actor O as ผู้ดูแล
    participant R as GitHub Actions
    participant W as Worker Admin
    participant D as D1
    participant S as Google Sheets
    O->>R: เริ่ม RUN_SERIAL
    R->>R: ตรวจ SHA, Worker version และเงื่อนไขการเขียน
    R->>D: อ่านสายการจองจาก audit และเลือกชุดงานรอบนี้
    alt มีงานที่จองล่าสุดแล้ว
        R->>W: ติดตามงานล่าสุดก่อน แม้งานพ้น PENDING แล้ว
    else ยังไม่มีการจอง และพบ B
        R->>W: INSPECT หลักฐาน A
        opt DAILY ของ A ยังเป็น IN_FLIGHT และเข้าเงื่อนไข
            R->>W: PROBE แล้ว SETTLE เมื่อหลักฐานตรงกัน
            W->>S: ตรวจแถวเดิมและหลักฐานการเขียน
            W->>D: บันทึก DAILY ที่พิสูจน์แล้ว คง A ใน REVIEW
        end
        R->>W: HANDOVER_ONE ระบุ B และหลักฐาน A
        W->>S: ตรวจแถวและสถานะไฟล์ก่อนส่งมอบ
        W->>D: บันทึก audit สลับ claim เปิด epoch และจอง B ในธุรกรรมเดียว
        W-->>R: RESERVED
    end
```

ก่อนเริ่ม RUN_SERIAL ตัวรันตรวจผล backup/restore ของ SHA ที่ระบุ การกันผู้เขียนอื่น และการเฝ้าดูของเจ้าของ รวมถึงตรวจว่า Worker รุ่นที่ระบุรับ traffic ทั้งหมด ตัวรันเลือกงานยืนยันรุ่น 1 ของเดือนปัจจุบันตามเวลาไทย หลัง cutover ซึ่งถึงเวลาทำและยังไม่เคยลองส่ง งานที่เข้ามาหลังเลือกชุดจะรอรอบถัดไป ถ้าไม่มีงานให้ติดตามและไม่มีผู้สมัคร ตัวรันจบที่ศูนย์ หาก DAILY ของ A ยืนยันไว้แล้ว จะใช้หลักฐานนั้นเข้าสู่ขั้นจองโดยตรง ถ้าหลักฐานไม่พอ ตัวรันหยุดก่อนจอง B. [ตัวเลือกงานและขั้น SETTLE](../../scripts/prod-normal-queue-pilot.mjs) · [การส่งมอบล็อก](../../src/admin/parked-expense-handover.ts)

## 3. งาน B ถูกเขียนและตรวจทีละขั้น

```mermaid
sequenceDiagram
    autonumber
    participant T as Cron ของ Worker
    participant D as D1
    participant Q as Cloudflare Queue
    participant W as Worker คิว
    participant S as Google Sheets
    T->>D: ตัวกู้คิวตรวจ epoch ที่จองและเงื่อนไขเวลา
    T->>Q: ส่ง SHEETS_SYNC ของ B เมื่อเข้าเกณฑ์
    loop แต่ละขั้นที่ยังขาดของ B
        Q->>W: ส่งงาน B
        W->>D: ตรวจสิทธิ์ รับ lease และ claim ตรวจ journal
        W->>D: บันทึกเจตนาการเขียนของขั้นนั้น
        W->>S: เขียน DAILY หรือ EXPENSE_RAW หรือ DETAIL หนึ่งรายการย่อย
        W->>S: อ่านหลักฐานผลการเขียนของขั้นนั้น
        W->>D: บันทึกผลตรวจรายขั้น
        W->>Q: เมื่อได้ CONTINUE ส่ง B กลับคิว หน่วง 90 วินาที
    end
    Q->>W: รับ B อีกครั้งเพื่อตรวจ FINAL
    W->>S: ตรวจรายงานที่เขียนไว้กับข้อมูลต้นทาง
    W->>D: ปิดงาน COMPLETED และรอบ COMPLETE เมื่อผ่านครบ
```

ตัวส่งกับตัวติดตามในภาพที่ 4 ทำงานคู่ขนานหลังการจอง คิวทำทีละขั้นตามลำดับ DAILY → EXPENSE_RAW → DETAIL ตามจำนวนรายการย่อย → FINAL ระยะ 90 วินาทีใช้กับ `CONTINUE` ส่วน `BUSY` ใช้เวลารอตามเงื่อนไข ถ้าผลเขียนคลุมเครือให้เก็บ journal เพื่อพิสูจน์ผลเดิม ขั้น FINAL ของตัวส่งและการอ่าน DAILY อิสระของตัวติดตามเป็นคนละการตรวจ. [ตัวส่งรายขั้น](../../src/sheets/stable-expense-job.ts) · [ตัวรับและส่งกลับคิว](../../src/index.ts) · [การตรวจแถวรายวัน](../../src/sheets/insert-daily-writer.ts)

## 4. ตรวจ B จากชีตจริงก่อนส่งสิทธิ์ให้ C

```mermaid
sequenceDiagram
    autonumber
    participant R as GitHub Actions
    participant W as Worker Admin
    participant D as D1
    participant S as Google Sheets
    R->>W: FINISH_STATUS ของ B ระบุ jobId และ fingerprint
    W->>D: ตรวจ job, epoch, งานที่เขียน และหลักฐานของ B
    W-->>R: JOB_COMPLETE พร้อม proof ของ B
    R->>W: READBACK ของ B
    W->>S: อ่านสูตร ค่าที่แสดง และตรวจแถวกับ marker ซ้ำ
    W->>D: เทียบต้นทางและตรวจว่าหลักฐานยังคงเดิม
    W-->>R: MATCHED
    R->>W: FINISH_STATUS ของ B ซ้ำ
    W-->>R: JOB_COMPLETE พร้อม proof เดิม
    opt ยังมี C ในชุดและมีเวลาส่งต่อ
        R->>W: ADVANCE_ONE ระบุ B, proof และ C
        W->>S: อ่าน DAILY ของ B อิสระอีกครั้ง
        W->>D: ตรวจหลักฐานเดิมและจอง C แบบอะตอมมิก
        alt ได้รับคำตอบ
            W-->>R: RESERVED แล้วเริ่มติดตาม C
        else คำตอบหาย
            R->>D: อ่าน audit หาคู่ B ไป C และ proof เดิม
            Note over R,D: คู่ตรงทุกค่า จึงติดตาม C ต่อ หากพิสูจน์ไม่ได้ให้จบรอบ
        end
    end
```

โหมดเดิมตรวจ `FINISH_STATUS` ได้สูงสุด 15 ครั้ง ห่างกันครั้งละหนึ่งนาที; โหมดรอบทดลองใช้ progress ของชุดหลักฐานต่อเวลารอเมื่อมีความคืบหน้า โดยมีเพดานเวลารวมและห้ามใช้ progress ให้สิทธิ์เขียน ตัวรันนับ B ว่ายืนยันแล้วหลังอ่าน DAILY ตรงและได้ proof เดิมซ้ำ ส่วนการเลือก C ต้องผ่านการตรวจอีกชั้นที่ Worker ภายในธุรกรรม D1 มีสิทธิ์สร้างการส่งมอบได้เพียงหนึ่งครั้งต่อ B การจอง C ปลุกเส้นทางในภาพที่ 3 เมื่อคิวเข้าเกณฑ์. [ตัวติดตาม](../../scripts/prod-normal-queue-pilot.mjs) · [อ่านแถวแบบระบุงาน](../../src/admin/normal-pilot-readback.ts) · [การจองต่อแบบอะตอมมิก](../../src/admin/serial-expense-handover.ts)

## 5. รับช่วงเมื่อรอบหยุด

| สิ่งที่เห็น | หลักฐานที่ต้องเทียบ | การทำงานต่อ |
| --- | --- | --- |
| คำตอบ SETTLE ของ A หาย | INSPECT ต้องพบ VERIFIED พร้อม fingerprint และ preimage digest เดิม | ตรงจึงไปขั้นจอง B หากต่างให้พัก A พร้อมเหตุผล |
| HANDOVER_ONE ตอบ HELD เพราะ `FINISH_STATUS` อ่านไม่ได้ | claim, epoch, job และ audit ต้องเหมือนก่อนสั่ง | หยุดรอบ ตรวจ schema และรุ่น Worker ก่อนสั่งใหม่ ห้ามจองด้วยวิธีอื่น |
| คำตอบ HANDOVER_ONE หาย | audit การจองแรกต้องมีรายการเดียว ตรงทั้ง jobId ของ B และ fingerprint | ติดตาม B เมื่อพบตรง เก็บสถานะไม่แน่ชัดหากยืนยันไม่ได้ |
| B เป็น JOB_REVIEW หรือ JOB_FAILED | ตัวรันพยายามอ่าน DAILY หนึ่งครั้งและรายงานผลควบคู่กับสถานะงาน | จบรอบก่อนจอง C แม้ DAILY เพียงขั้นเดียวจะตรง |
| B ยัง IN_PROGRESS จนหมดเวลา หรือหลักฐานก่อน/หลังอ่านต่างกัน | ตรวจ job และ epoch ของ B รวมถึงแถว DAILY ของ B | ใช้ FINISH_PILOT ตรวจงานล่าสุดแบบอ่านอย่างเดียว งานในคิวอาจยังทำต่อได้ |
| คำตอบ ADVANCE_ONE หาย | ปลายสายการจองต้องเป็น C และระบุ B, proof และ fingerprint เดิม | คู่ตรงจึงติดตาม C ถ้าขาดหรือต่างให้หยุดและรักษาหลักฐาน |
| FINISH_STATUS เป็น NOT_STARTED หรือ UNVERIFIED | ตรวจ audit, jobId, fingerprint, รุ่น Worker และ epoch ของงานที่เลือก | จบรอบพร้อมเหตุผล ตรวจงานเดิมก่อนส่งต่อ |
| ต้องกลับมาส่งต่อ | RUN_SERIAL อ่าน audit ของสายเดิมและตรวจงานที่จองล่าสุดก่อน รวมถึง Worker version ที่รับช่วง | ถ้าผ่านจึงส่งต่องานในชุดของรอบใหม่ ถ้า Worker เปลี่ยนรุ่นให้ตรวจหลักฐานเพื่อกู้ตามคู่มือ |

**อ่านตัวเลขให้ถูกชุด** จำนวนที่ยืนยันและจำนวนค้างในผล RUN_SERIAL อ้างชุดที่เลือกของการเรียกครั้งนั้น งานที่กลับมาตรวจซ้ำอาจถูกนับว่ายืนยันในรอบใหม่ ยอดค่าใช้จ่ายที่ส่งจริงต้องกระทบยอดตามรหัสและรุ่นของรายการ

**คำที่ใช้ตามเหตุ** `sync_jobs` เก็บสถานะของงาน • `lease` คือสิทธิ์ทำงานชั่วคราวเฉพาะงาน • `claim` คือสิทธิ์เขียนไฟล์ร่วม • `epoch` คือรอบที่อนุญาตเป้าหมาย • `fingerprint` ผูกสายกับหลักฐานของ A • `proof` ผูกผลจบกับหลักฐานของงานที่กำลังตรวจ

**ตรวจซ้ำในเครื่อง** ใช้ชุดทดสอบตัวรันสำหรับการเลือกชุดงานและคำตอบหาย และชุดทดสอบ Worker สำหรับ A คง REVIEW, B และ C ปิดครบ, การจองแข่งกัน และแถวที่ไม่ตรงกับ D1. [ทดสอบตัวรัน](../../tests/prod-normal-queue-pilot.test.mjs) · [ทดสอบ Worker และคิว](../../tests/insert-daily-writer.test.mjs)


## 6. รอบจำลอง #348: พัก B, จอง C และบันทึกผล

ภาพนี้เป็น local mock เท่านั้น; barrier ปิดโดยปริยาย และยังไม่มีหลักฐาน external fence ตาม #296. ตัวรัน local test ฉีด coordinator ที่เรียก helper สำหรับ oracle/ลงนาม/โอน C; CLI ปกติไม่มี coordinator และไม่มี route สำหรับลงนามหรือโอนจริง; `CLOSE_MOCK_ROUND` จำกัด localhost และ Worker `APP_ENV=test` ไม่ใช่การสั่ง Production.

```mermaid
sequenceDiagram
    participant R as ตัวรันทดสอบ
    participant T as Fixture ในเครื่อง
    participant W as Worker จำลอง
    participant D as D1 ในเครื่อง
    participant O as Oracle จำลอง
    participant S as Sheets จำลอง
    R->>W: เปิด round และผนึกสมาชิก
    W->>D: ผนึก snapshot แล้วจอง B ในคำสั่งถัดไป
    R->>W: HOLD_RESERVED เมื่อพิสูจน์เงื่อนไขได้
    W->>D: แข่ง lease แล้วให้ B REVIEW และคง claim/epoch
    R->>T: เรียก coordinator ที่ฉีดเฉพาะ local test
    T->>D: อ่านซ้ำว่า B ไม่เคยลองทำและไม่มีหลักฐานผลข้างเคียง
    alt พบหลักฐานขัดกับเงื่อนไขของ hold
        D-->>T: context เป็น null
        T-->>R: หยุดก่อนเซ็นและงดเรียกจอง C
    else การอ่านผ่าน
        T->>O: ขอ attestation จำลองที่ผูก B, C, epoch, nonce และ fence
        O-->>T: ลงนามตามบริบทเดิม
        T->>D: helper อ่าน context ซ้ำหลังเซ็นก่อนส่ง batch
        alt หลักฐานขัดกันก่อนส่ง batch
            T-->>R: HELD คง claim เดิมและงดส่ง batch
        else การอ่านซ้ำผ่าน
            T->>D: ส่ง batch ตรวจ B และจอง C
            alt หลักฐาน B เปลี่ยนหลังอ่านและถูกพบใน batch
                D-->>T: ย้อนทั้ง batch และเก็บ claim เดิม
                T-->>R: UNCERTAIN หยุดจอง ตรวจหลักฐานเดิม ห้ามส่งซ้ำ
            else batch ผ่านและจอง C
                W->>S: C ทำ DAILY, RAW และ DETAIL แต่ละรายการ
                W->>D: เก็บ intent, postimage และผล FINAL ตามขั้น
                alt คำขอหรือผลตอบกลับของ C ไม่ชัด
                    W->>D: เก็บ claim และหลักฐาน REVIEW โดยไม่ส่งซ้ำ
                else หลักฐานพอสำหรับปิดรอบจำลอง
                    R->>W: CLOSE_MOCK_PARKED
                    W->>D: ตรวจ v2 proof และชุดรายการซ้ำ แล้วปิดรอบ
                    D-->>R: VERIFIED / PARKED / NOT_STARTED / RECONCILE
                end
            end
        end
    end
    Note over R,D: identity local ก่อน SETTLE/OPEN เมื่อ restart ให้หยุด ไม่ส่งซ้ำ
    Note over R,S: READ_HISTORICAL / READ_ROUND อ่านย้อนหลัง ไม่ให้สิทธิ์เขียน
```

การอ่านก่อนเซ็นและการอ่านซ้ำของ helper ต้องพบว่า B ยังมี attempt เป็น 0 และไม่มี projection, cancellation, row index, intent, notice handoff, notice dispatch หรือ failed job ตามคีย์ที่กำหนด ถ้าการอ่านก่อนเซ็นคืน context เป็น null ให้หยุดโดยงดเซ็นและงดเรียกจอง C ถ้าการอ่านซ้ำหลังเซ็นไม่ผ่าน ให้ helper คืน HELD โดยงดส่ง batch ถ้าหลักฐาน B ทำให้ batch ไม่ผ่าน ให้ย้อนทั้ง batch และเก็บ claim เดิม เมื่อได้ UNCERTAIN ให้หยุดจอง ตรวจหลักฐานเดิม และห้ามส่งซ้ำ หาก lease ของ C หมดและ intent ค้างตรงสาย ให้พัก C เป็น REVIEW พร้อมเก็บ claim และ intent แม้ Worker เปลี่ยนรุ่น

PARKED หมายถึง B ถูกพักและมี mock handoff ที่บันทึกไว้ ไม่ยืนยันว่า C สำเร็จ; VERIFIED เป็นผลที่ Worker บันทึก ณ เวลาตรวจ ไม่ยืนยันสถานะชีตปัจจุบัน. NOT_STARTED ต้องมี positive birth/lease provenance และไม่มี intent ที่เกี่ยวข้อง; legacy หรือข้อมูลขัดกันเป็น RECONCILE. การปล่อยจริงและเขียน Google/D1 จริงต้องผ่าน authority และ external-writer fence ของ #296 แยกต่างหาก. [Acceptance audit](../ISSUE348_ACCEPTANCE_AUDIT_TH.md) · [ตรวจและโอนสิทธิ์จำลอง](../../src/admin/serial-attested-handoff.ts) · [ทดสอบหลักฐาน B](../../tests/helpers/serial-handoff-b-predicates.mjs) · [รหัสปิดรอบ](../../src/admin/serial-expense-handover.ts)
