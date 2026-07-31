# MaliPang V1 Closeout — ฐานปฏิบัติการปัจจุบัน

สถานะเอกสาร: Closeout baseline สำหรับ Issue #114  
วันที่ตรวจ: 31 กรกฎาคม 2026 (Asia/Bangkok)  
Functional baseline / Production source SHA: `d9ef490a6e0d9bce0c4153b0166c912b8dfd11a5`  
Worker version ที่ตรวจล่าสุด: `9bedd01b-c17a-460b-ae4d-d7fb6666c28f`  
Rollback target ที่ใกล้ที่สุด: `e1b4e327-9e06-49a4-848a-ac1fb0d15111`

เอกสารนี้เป็น **baseline การใช้งาน V1** ไม่ใช่แผนสร้าง V2 และไม่ทำให้มี V2 UI, V2 session หรือระบบบัญชีใหม่เพิ่มขึ้น

## 1. Runtime และแหล่งข้อมูลจริง

| หัวข้อ | Baseline V1 |
|---|---|
| Runtime | Cloudflare Worker `malipang-backend-v5-2` ใน `production` mode |
| Database | Cloudflare D1 เป็น operational source of truth |
| Evidence | R2 private evidence; ห้ามเปิด public และห้ามลบจากการแก้รายการ |
| Ingress | LINE OA webhook → Queue → D1/service → Sheets sync |
| Reporting | Google Sheets Direct API; Sheets เป็น mirror/report/config ไม่ใช่ตัวตัดสินธุรกรรม |
| Migration | additive chain `0001`–`0014`; `0014_failed_job_reconciliation.sql` บันทึกผลกู้ incident แบบ append-only |
| Sheets sync | เปิดใช้งาน; sync/reconcile ใช้ key และ version เพื่อ idempotency |

`/health` ต้องตอบ production และ `/admin/readiness` ต้องผ่าน D1, LINE Reply, Google Sheets, R2 และ attendance configuration ก่อนทำงานดูแลระบบที่มีผลต่อข้อมูล

## 2. Identity และสิทธิ์

- Owner หลักและ Owner ลำดับที่สองเป็น `OWNER / ORGANIZATION / ACTIVE`; การผูก LINE ของ Owner ลำดับที่สองต้องผ่าน flow HR และ Owner approval เท่านั้น
- พนักงานเดิมของสาขา B001 ยังคงสถานะและสิทธิ์ตามข้อมูลเดิม
- รหัสทดสอบเดิมเป็น historical alias เพื่อ resolve หลักฐานเก่าเท่านั้น ไม่ใช่ Staff ID ที่ใช้งานได้
- บทบาทจริงมาจาก `staff_roles.role + scope + branch_id` ไม่ใช่ prefix ของ Staff ID
- `ADMIN_TOKEN` เป็น developer/system admin authentication แยกจาก human RBAC

การขอผูก LINE ใหม่ต้องรอ Owner approve; รู้ Staff ID อย่างเดียวห้ามทำให้เกิด verified binding

## 3. Attendance และ Payroll

### Attendance

- เวลาทางการมาจาก white photo timestamp/overlay ที่มีเวลา วันที่ และ location/GPS
- รูปนาฬิการ้านเป็นหลักฐานยืนยันว่าอยู่ร้าน ไม่ใช่เวลาทางการ
- reply ของ Attendance เป็น Thai/English/Myanmar และไม่แสดงยอด Payroll
- webhook, message และ state ของ Attendance ป้องกัน redelivery/duplicate; Durable Object จัดลำดับ IN/OUT ต่อพนักงานต่อวัน
- การแก้ไข Attendance ทำผ่าน flow ที่มี audit เท่านั้น

### Payroll

- รอบ Payroll คือ **Thursday–Wednesday**
- Pay date คือ **Wednesday ที่ปิดรอบ**
- ใช้ preview เพื่ออธิบายผลก่อน Apply; Apply มี idempotency
- ค่าแรงและ wage history เป็น snapshot/audit data; ห้ามแก้ historical rows ใน Sheets โดยตรง

## 4. Expense V1.2 และ hotfixes

### LINE flow

1. ข้อความค่าใช้จ่ายที่เข้าเงื่อนไข Quick Save บันทึก D1 ก่อน แล้วสร้าง Sheets sync และตอบ Saved Flex
2. ข้อความที่ไม่ชัด, Bank Slip/G-Wallet, Receipt/Tax Invoice และ Online Order สร้าง draft/review ก่อน finalization
3. พนักงานยืนยันหรือ Cancel ผ่าน Flex; มี audit และ Undo/CANCEL ที่ไม่ลบหลักฐาน
4. Delivery Order เดี่ยวเป็น supporting evidence เท่านั้น และห้ามสร้าง Expense payable เอง

### กฎเงิน

- `expense_events.amount_satang` คือเงินจริงที่ร้านจ่าย (final cash outflow)
- subsidy, voucher, shipping discount และ list price เก็บเป็น metadata; ห้ามลงยอดก่อนส่วนลดเป็น Expense
- ถ้า item total รวมตรงกับ final amount จึงลง `รายวัน` แบบหนึ่งแถวต่อ item
- ถ้าแบ่ง discount/subsidy/shipping ให้ item ไม่ได้อย่าง deterministic ให้ลง summary row เดียวเพื่อรักษายอด

### เอกสารและ idempotency

- รองรับ BANK_SLIP, G_WALLET, RECEIPT, TAX_INVOICE, RECEIPT_TAX_INVOICE, ONLINE_ORDER, DELIVERY_ORDER และ UNKNOWN
- D1 เก็บ document, normalized item, document links/cases และ append-only expense audit
- primary purchase document เท่านั้นที่สร้าง item posting; supporting document ห้ามสร้างยอดซ้ำ
- duplicate protection ครอบคลุม webhook/message, image hash, bank reference และ document identifiers ตามหลักฐานที่มี

### Google Sheets

- `V52_EXPENSE_RAW` มี summary หนึ่งแถวต่อ Expense เพื่อ traceability
- `รายวัน` รับเฉพาะ CONFIRMED expense
- itemized row key คือ `Expense_ID|Item_ID`; retry/reconcile ไม่สร้าง row ซ้ำ
- เดือนที่ไม่มี detail row ว่างจะขยายแถวก่อน `รวม` แบบ formula-safe และเลื่อน row mapping อย่างปลอดภัย
- ห้ามแก้ `V52_*` หรือ formula rows ด้วยมือ; ใช้ reconcile/recovery route ตาม Operations runbook

## 5. LINE Reply-first, Queue และการกู้คืน

- ข้อความตอบปกติจาก inbound event ใช้ LINE Reply API ก่อน จึงไม่พึ่ง Push quota
- หาก reply token ใช้ไม่ได้หรือ Reply ชั่วคราวล้มเหลว จะสร้าง `LINE_NOTIFICATION` fallback แบบ durable โดยไม่ replay Vision/D1/Payroll/Sheets
- Push quota ที่หมดเป็น `DEGRADED` สำหรับ fallback/alert เท่านั้น เมื่อ LINE auth และ Reply capability ผ่าน ยังไม่ทำให้ readiness ล้ม
- Sheets retry มี lease และ bounded backoff; reconciliation สร้าง job จาก D1 แบบ idempotent
- DLQ/failed jobs ต้องถูกตรวจและจัดประเภท ไม่ลบทิ้งเพื่อให้ตัวเลขสวย

### Failed-job baseline ณ closeout

failed job ทางประวัติศาสตร์ต้องผ่าน `/admin/reconcile-historical-failed-jobs` ก่อน closeout เสมอ โดย route นี้ไม่ replay webhook เก่าแบบ generic และไม่ลบ payload/error เดิม:

- ถ้ามี Attendance/Expense/Expense document ใน D1 แล้ว จะบันทึกผลว่า transaction commit สำเร็จ และปิดเฉพาะ failed-job record
- ข้อความที่ไม่มีธุรกรรม และภาพที่ไม่มีทั้งธุรกรรมหรือหลักฐานเก็บไว้ จะถูก audit เป็นผลเฉพาะรายการ; ภาพแบบหลังต้องส่งใหม่ ไม่สร้างยอดเดาเอง
- notification smoke ที่หมด retry จะเป็น delivery-only incident และไม่สร้างธุรกรรม
- notification หรือ job ชนิดใหม่ที่จัดประเภทไม่ได้ จะยัง OPEN เพื่อให้ operator ตรวจเอง

ดังนั้น `LOST=0` หมายถึงไม่มีธุรกรรมที่หายแบบอธิบายไม่ได้ ไม่ได้หมายถึงลบประวัติความล้มเหลว. รายการใหม่ที่ไม่เข้า pattern นี้ต้องถือเป็น incident จนกว่าจะมี root cause และ reconciliation.

## 6. การตรวจ Production และ Sheets

หลักฐาน closeout ที่ต้องทำซ้ำก่อน release สำคัญ:

1. ตรวจ Worker SHA/version, `RUNTIME_MODE`, `/health`, `/admin/readiness`, queue และ DLQ
2. ตรวจ staff identity/RBAC โดยไม่เปิดเผย raw LINE identity
3. ตรวจ Attendance accept/reject และ LINE reply ที่มองเห็นได้
4. ตรวจ Payroll preview ตามรอบ Thursday–Wednesday เท่านั้น; ห้ามทดลอง Payroll Apply เพื่อ smoke
5. ตรวจ Expense text, Bank/G-Wallet, Receipt/Tax Invoice, Online Order, Delivery Order, Undo และ duplicate behavior
6. เปรียบ D1 กับ `V52_EXPENSE_RAW` และ `รายวัน`; ยืนยัน formula/total, row mapping และ no duplicate finalized Expense
7. ตรวจ legacy tabs เป็น history-only และไม่มี new legacy business write หลัง Worker cutover

Google Sheet `MaliPang_OWNER_MASTER` มีทั้งแท็บ V52 และ Legacy อยู่ร่วมกันได้ แต่เฉพาะ `V52_*`, `HR_STAFF_CONFIG`, `HR_WAGE_HISTORY`, `HR_SHIFT_SCHEDULE`, `HR_OT_REQUESTS` และ `รายวัน` ที่ Worker ใช้ตาม configuration ปัจจุบัน. การมีแท็บ Legacy ไม่ได้แปลว่าเป็น runtime write path

## 7. Legacy Apps Script

V1 ไม่ใช้ Apps Script เป็น core runtime และ repository ไม่มี `.gs`, `appsscript.json` หรือ Apps Script API call. การตรวจ Sheet log ยืนยันว่า legacy intake/image-router ไม่มีข้อมูลใหม่ตั้งแต่ 22 กรกฎาคม 2026 ขณะที่ V52 มีรายการหลัง cutover.

การถอน Apps Script แบบถาวรยังเป็นงาน operations แยกต่างหาก: ต้อง inventory owner/collaborator, trigger/deployment, source backup และ rollback window ก่อน disable/delete. โดยเฉพาะ cleanup trigger ที่เคยทำงานช่วง 25 กรกฎาคม 2026 ยังต้องยืนยัน ownership/current state ที่ Google-side. งานนี้ไม่ใช่เหตุให้ V1 runtime กลับไปใช้ Legacy และห้ามปิด/ลบ Legacy โดยเดา.

## 8. ขอบเขต V1 และงานหลัง V1

### V1 ปิดที่นี่

- Backend Worker + D1 + Queue + R2 + Direct Sheets API
- Identity/RBAC/branch foundation
- Attendance, Payroll preview/apply capability, Shift, Expense text/document flow และ Sheets mirror
- Direct operational API/admin routes; ไม่มี frontend Board

### Post-V1 operational

- staged Legacy retirement, trigger/deployment ownership inventory และ retention policy activation เมื่อมี owner approval
- monitoring failed-job baseline และ Push quota
- recurring real-photo/data-quality sampling และ Sheets reconciliation

### V2 boundary

V2 Board/API/UI roadmap ต้อง replan หลัง V1 closeout. V2 ใช้ D1 models, RBAC, expense-document items และ query/service contracts เดิมได้ แต่ **ยังไม่มี V2 frontend, session authentication, dashboard หรือ Board endpoint ที่พร้อมใช้งานจาก closeout นี้**.

## 9. เอกสารอ้างอิง

- `README.md` — entry point และ service overview
- `docs/02_SHEET_MAPPING_TH.md` — mapping และ formula-safe daily posting
- `docs/04_OPERATIONS_TH.md` — recovery/reconcile/LINE operations
- `docs/05_LINE_FLEX_FLOW_TH.md` — Expense Flex และ confirmation rules
- `docs/19_V11_IDENTITY_ACCESS_TH.md` — identity, RBAC และ onboarding
- `docs/06_LEGACY_APPS_SCRIPT_STATUS_TH.md` — historical inventory และ staged retirement safety

เอกสาร cutover เก่าและ issue เก่าต้องอ่านเป็น historical evidence; เมื่อขัดกับเอกสารฉบับนี้ ให้ยึด rules และ runtime baseline ในเอกสารนี้ก่อน แล้วเปิด issue ใหม่หากต้องการเปลี่ยนกติกาธุรกิจ.

## 10. Backlog disposition ใน V1 Closeout (#114)

ตารางนี้เป็นผล audit ของ open backlog ณ วันที่ 31 กรกฎาคม 2026. `POST_V1_OPERATIONAL` ไม่ใช่ V1 runtime/data-correctness blocker แต่ยังต้องทำด้วย change control แยกต่างหาก. `V2_BLOCKED` คือการ freeze ไว้รอ replan หลัง closeout ไม่ใช่งานที่ถูกนำมาทำใน V1.

| Issue | Classification | หลักฐาน/การตัดสิน |
|---|---|---|
| #15 | SUPERSEDED | ขอบเขต UAT เก่าถูกแทนที่ด้วย automated regression และ production reconciliation ของ #114 |
| #19 | SUPERSEDED | กติกาเก่า Monday–Sunday ขัดกับ canonical Thursday–Wednesday |
| #20 | RESOLVED_BY_CURRENT_PRODUCTION | payroll cycle และ pay date ถูกทดสอบ/ใช้งานตาม Thursday–Wednesday แล้ว |
| #22 | RESOLVED_BY_CURRENT_PRODUCTION | cutover รุ่นแรกถูกแทนที่ด้วย exact deployed Worker/runtime และ readiness baseline ปัจจุบัน |
| #23 | SUPERSEDED | Day-1 checklist เดิมถูกแทนที่ด้วย reconciliation ครบระบบของ #114 |
| #58 | POST_V1_OPERATIONAL | เป็น parent ของ staged Legacy retirement; ไม่ใช่ V1 core runtime แล้ว แต่ยังห้ามถอนโดยเดา |
| #60 | POST_V1_OPERATIONAL | Legacy source/deployment/trigger inventory และ backup เป็นงาน retirement control ที่ต้องทำแยก |
| #61 | RESOLVED_BY_CURRENT_PRODUCTION | V52 operational evidence ต่อเนื่องเกิน 7 วันและไม่มี legacy intake/image-router write ใหม่หลัง cutover |
| #62 | DUPLICATE | ซ้ำกับ Stage-1 issue #65 |
| #63 | DUPLICATE | ซ้ำกับ Stage-2 issue #66 |
| #65 | POST_V1_OPERATIONAL | ต้องมี owner-approved Stage-1 shutdown/rollback window; ไม่ใช่งาน closeout runtime |
| #66 | POST_V1_OPERATIONAL | retirement/archive ขั้นสุดท้ายต้องมี controlled change แยก |
| #67 | RESOLVED_BY_CURRENT_PRODUCTION | current Worker version, production mode, dry-run และ readiness evidence แทน runtime ambiguity เดิม |
| #71 | POST_V1_OPERATIONAL | origin ของ legacy cleanup ทราบแล้ว แต่ Google-side owner/current trigger state ต้องตรวจแยกก่อน retirement |
| #83 | RESOLVED_BY_CURRENT_PRODUCTION | Reply-first/reliable notification fixes และ attendance regression/UAT ปัจจุบันครอบคลุม issue เดิม |
| #106 | RESOLVED_BY_CURRENT_PRODUCTION | receipt parent FK และ draft placeholder hotfixes (#108/#110) พร้อม receipt regression ปัจจุบัน |
| #109 | RESOLVED_BY_CURRENT_PRODUCTION | placeholder mismatch ถูกแก้ใน PR #110 และมี regression assertion |
| #45 | V2_BLOCKED | canonical Board epic; ต้อง replan หลัง V1 closeout |
| #47–#57 | V2_BLOCKED | Board/naming/UI/API roadmap; ไม่ได้ implement ใน V1 closeout |

เมื่อ comment/close บน GitHub แล้ว ให้ใช้ตารางนี้ร่วมกับ comment ที่มี evidence ไม่เปิดเผย secret, raw LINE identity หรือข้อมูลธุรกรรมส่วนบุคคล.
