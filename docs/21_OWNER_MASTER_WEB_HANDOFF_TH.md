# Owner Master → Website: สถานะจริงและสัญญาข้อมูล

บันทึก: 15 ตุลาคม 2026 (Asia/Bangkok)

## 1. ขอบเขตและหลักฐาน

งานนี้เป็น **DEV_OWNED เฉพาะเอกสาร**, ความเสี่ยง Low, mutation L0–L1: แก้เอกสาร ทดสอบ และเปิด PR ไม่อนุญาต merge/deploy, remote migration, replay, เขียน Sheets หรือแก้รายการย้อนหลัง

Canonical main ที่ใช้: `7d9a4007e78e560d482d8b0be07ee7a06a9e97fd` (PR #197)
นี่คือ source baseline ที่ fetch แล้ว ไม่ใช่หลักฐานว่า Production ยัง deploy SHA นี้อยู่

Acceptance criteria ของเอกสาร:

1. ข้อมูลเดิมใน README / mapping / architecture / roadmap เชื่อมมายังบริบทใหม่ ไม่เริ่มระบบซ้ำ
2. บันทึก 4 หน้าหลักและกติกาที่ Owner ยืนยัน พร้อมตำแหน่งต้นทางที่ตรวจได้
3. แยก **มีแล้ว**, **ยังจำกัด/ไม่ยืนยัน**, **เสนอสำหรับเว็บ** อย่างชัดเจน
4. ไม่เผยรายการเงินจริง ชื่อบุคคล LINE IDs ลิงก์หลักฐาน private หรือ backup locator ใน GitHub
5. มี acceptance tests, แผนพัฒนา, UAT และ rollback ของงานเอกสาร

หลักฐานที่ใช้:

- อ่าน metadata และ headers/formulas แบบจำกัดช่วงใน Owner Master ณ 15 ตุลาคม 2026; ไม่ export workbook หรืออ่านรายการธุรกิจทั้งฐาน
- อ่าน canonical source: `src/expense/repository.ts`, `src/sheets/daily-expense.ts`, `src/sheets/owner-month-close.ts` และเอกสารเดิม
- กติกาธุรกิจจากคำยืนยัน Owner ในช่องทางส่วนตัว; ตัวอย่างด้านล่างเป็นตัวอย่างอธิบาย ไม่ใช่รายการจริง
- งานปรับหน้า 13 ตุลาคมมี private whole-workbook backup และบันทึกเทียบผลก่อน/หลัง 8,651 ช่องตรงกัน ข้อนี้เป็นผลตรวจครั้งนั้น ไม่ใช่การกระทบยอดบัญชีหรือ timing benchmark ใหม่

ไม่ได้ตรวจ Production Worker version, D1 balances, failed jobs, DLQ หรือความครบถ้วนบัญชีใหม่ในงานนี้ ห้ามใช้เอกสารนี้เป็น release evidence หรือสรุปว่าปัญหาการเงินเดิมหมดแล้ว

## 2. โครงสร้างที่ใช้งานจริง

| หน้า Owner | ต้นทางหลัก | พฤติกรรม/ขอบเขตปัจจุบัน |
|---|---|---|
| `34_OWNER_DAILY_CASH` | `SRC_ACTUAL_0969`, `SRC_ACTUAL_1069`, `รายวัน`, `97_EXPENSE_CLEAN`, `30_RECON_DAILY` | เดือนเลือกที่ B2; เงินสด/เงินโอน/มัดจำ A9:I40; รายจ่ายแยกแหล่งเงิน A45:I77; รองรับ ก.ย.–ต.ค. 2026 เท่านั้นใน selector ปัจจุบัน |
| `04_OWNER_MONTH_CLOSE` | ยอดขาย/รายจ่าย/ต้นทุน/มัดจำ/ส่วนตัวและช่องกรอกกระทบยอดเดิม | เดือนเลือกที่ C2; ไม่ใช่หน้า read-only ทั้งหมด ต้องคงช่องกรอกและไม่ถือรายได้หักรายจ่ายประมาณการเป็นกำไรรับรอง |
| `03_ต้นทุนสินค้า` | `Product_Cost_By_Filling!A37:M53`; เดือนจาก `04_OWNER_MONTH_CLOSE!C2` | A4:H21 แสดงขนมปัง 17 รายการ; ราคาขาย, ต้นทุน, กำไรขั้นต้น, ค่าใช้จ่ายจัดสรร, คงเหลือ, % และหมายเหตุ |
| `05_รายการต้องตรวจ` | `30_RECON_DAILY` H/N/S และแกนวันที่ A | สรุปตั้งแต่สิงหาคมของปีในแกนวันที่ถึงวันนี้; รายละเอียด A15:D; คนละเรื่องกับ runtime health หรือ D1 failed jobs |

มีทั้งหมด 86 แท็บ: เก็บเดิม 84 + หน้าสรุปใหม่ 2 แท็บ ไม่ได้ลบประวัติ
วันตรวจมี 7 แท็บที่แสดง: 4 หน้าหลัก + `30_RECON_DAILY`, `SRC_ACTUAL_1069`, `รายวัน`
อีก 79 แท็บซ่อนอยู่; การมองเห็นเป็นการจัดหน้าจอ ไม่ใช่สถานะ dependency
ห้ามซ่อน/ลบแท็บที่เปิดเพิ่มเพียงเพราะข้อกำหนดเว็บมี 4 เมนู

แท็บที่ซ่อนเปิดได้จาก **มุมมอง → ชีตที่ซ่อน** การซ่อนไม่ปิดการคำนวณหรือ sync
ไม่ให้เว็บ rename, sort, move หรือ delete แถว RAW/รายวันโดยตรง เพราะ D1 เก็บ row mapping และระบบเขียนตามชื่อ/คอลัมน์เดิม

## 3. กติกาเงินที่ต้องรักษา

### 3.1 เงินหน้าร้านไม่เท่ากับวิธีจ่ายเงินสดทุกกรณี

Cash ที่ Owner กรอกคือเงินสดนับจริง **หลังใช้ซื้อของแล้ว ไม่รวมเงินทอนประจำ 2,500 บาท**
ตัวอย่างสังเคราะห์: ขายสด 1,000 ใช้เงินหน้าร้านซื้อของ 100 จึงกรอก Cash 900
ยอดขายเงินสดที่คำนวณได้คือ 900 + 100 ไม่ใช่ 900 − 100 และไม่หักเงินทอนซ้ำ

ต้องเก็บ **payment method** และ **source wallet** แยกกัน:

| วิธีจ่าย | แหล่งเงิน | ความหมาย | บวกกลับในฐานขายสดหน้าร้าน |
|---|---|---|---|
| `cash` | `CASH_DRAWER` | ซื้อด้วยเงินสดหน้าร้าน | ใช่ เฉพาะรายการที่เข้าฐานและตรวจแล้ว |
| `cash` | `SHOP_BANK` | ใช้เงินสดที่มาจากบัญชีร้าน | ไม่ใช่ |
| `transfer` | `SHOP_BANK` | โอนจากบัญชีร้าน | ไม่ใช่ |
| บัตรเครดิตตาม wallet ที่รองรับ | บัญชีบัตรที่ยืนยัน | แยกจากเงินสดหน้าร้านและการจ่ายชำระบัตร | ไม่ใช่ |
| ไม่ทราบ/ยังไม่ยืนยัน | ไม่ทราบ | ต้องตรวจ ไม่เดาจากคำว่า cash | ยังรวมเป็นยอดที่ยืนยันไม่ได้ |

`SHOP_BANK` เป็นกลุ่มแหล่งเงิน ไม่ยืนยันว่ามี sub-account แยก KBank/SCB พร้อมกระทบยอดแล้ว
หากเว็บต้องกระทบยอดแต่ละธนาคาร ต้องออกแบบและยืนยัน mapping เพิ่ม ไม่เดาจาก alias
รายการ `ACCUMULATED_CASH` และการถอน/คืนส่วนตัวเงินสดต้องแยกตรวจตามสูตร/นโยบายเดิม ไม่รวมเข้าฐานบวกกลับทั้งหมดโดยไม่มีเงื่อนไข

### 3.2 วันรับเงินกับวันส่งสินค้าเป็นคนละมิติ

Owner ยืนยันการรับมัดจำเข้าบัญชีร้าน; อาจรับบางส่วนหรือเต็มก่อนส่งข้ามเดือน

```text
ยอดขายปรับมัดจำ = เงินสดนับจริงหลังซื้อของ
                  + รายจ่ายที่ใช้เงินสดหน้าร้านในฐานที่ตรวจแล้ว
                  + เงินโอนรับจริงวันนั้น
                  - เงินรับล่วงหน้าที่รับวันนั้น
                  + มัดจำที่ตัดเมื่อส่งมอบวันนั้น
```

- เงินเข้าบัญชียังอยู่วันรับจริง ห้ามย้าย bank cashflow ไปวันส่ง
- ตัดมัดจำเฉพาะส่วนรับล่วงหน้าที่ส่งแล้ว ไม่บวกยอดออเดอร์เต็มซ้ำกับยอดชำระที่เหลือวันส่ง
- ตัวอย่างสังเคราะห์: รับล่วงหน้า 500 ในวันแรก และรับอีก 500 วันส่ง → cashflow 500 ต่อวัน; ยอดขายจากออเดอร์นี้เป็น 0 วันรับล่วงหน้า และ 1,000 วันส่ง
- `33_CUSTOMER_ADVANCES` แยกรับ / ตัดเมื่อส่งมอบ / คืน คนละแถวด้วยอ้างอิงเดียวกัน; ปัจจุบันระบุการเชื่อม ก.ย.–ต.ค. 2026 สำหรับบัญชีร้าน เงินสด/เดือนอื่นยังรอตรวจ
- จำนวนขายและส่งออกต้องนับตามหน้างาน ทั้งหน้าร้านและออเดอร์; ห้ามเพิ่มจำนวนสินค้าอีกครั้งเพราะมีแถวมัดจำ
- คืนมัดจำ, ส่งบางส่วน, ยกเลิกออเดอร์ และแก้หลังปิดเดือนต้องกำหนด test/policy ให้ครบก่อนเพิ่ม workflow บนเว็บ ห้ามขยายกติกาจากตัวอย่างเอง

### 3.3 ขายได้ / เงินรับ / กำไร / เงินคงเหลือ ไม่ใช่ค่าเดียวกัน

- `30_RECON_DAILY` เปรียบเทียบยอดขายปรับแล้วกับมูลค่าขนมตามราคา หักโปรโมชั่นและบวกรายการปรับที่มีหลักฐาน ส่วนต่างยังต้องตรวจ ไม่ใช่สรุปว่าเงินหาย
- จำนวนขาย, ของเสีย, จำนวนเหลือ และการตรวจสต๊อกเป็นคนละหลักฐาน หน้านี้ไม่ได้พิสูจน์ inventory balance ครบทั้งร้าน
- `PERSONAL_USE` / `PERSONAL_RETURN` อยู่ ledger แยก ไม่สร้าง Expense และไม่เป็นต้นทุน/P&L; มีผลต่อเงินคงเหลือตามประเภทและ wallet
- นับ personal transactions เฉพาะ `CONFIRMED`; Undo ไป `CANCELLED` ต้องคง audit และไม่คงยอดสุทธิไว้ในรายงาน
- อย่าตีความยอดขายลบรายจ่ายที่บันทึกเป็นกำไรสุทธิรับรอง ถ้าต้นทุน/ปิดเดือน/กระทบยอดยังมีข้อจำกัด

## 4. Data contract สำหรับเว็บ (ข้อกำหนด ไม่ใช่ API ที่เปิดใช้แล้ว)

| กลุ่มข้อมูล | แหล่งจริง/จุดตรวจ | ขอบเขตเว็บที่ควรทำ |
|---|---|---|
| Expense / documents / items | D1; `src/expense/repository.ts`, `src/expense/confirm.ts`, `src/expense/undo.ts` | ใช้ transaction identity เดิม; summary หนึ่งครั้งต่อ Expense แม้มีหลายเอกสาร; final paid ไม่บวก line items ซ้ำ |
| Personal transactions | D1 `owner_personal_transactions`; `src/personal-use/` | แยก ledger/status/audit; ไม่ตกไป Expense; reuse CAS/idempotency เดิม |
| เงินนับจริง/ยอดโอน/การยืนยันปิดวัน | `SRC_ACTUAL_*` และสูตร/ช่องกรอกที่ inventory แล้ว | ยังไม่อ้างว่ามี D1 model/API ครบ ต้องตรวจแหล่ง input และ provenance ก่อนเชื่อม |
| มัดจำลูกค้า | `33_CUSTOMER_ADVANCES` | แยก receipt date, fulfillment date และ reference; ยังไม่ backfill/เปลี่ยน source of truth |
| จำนวนขนมและของเสีย | `SRC_TEAM_*`, `24_CURR_PIECE_SUMMARY` | preserve คอลัมน์สินค้า หน่วย ช่องทาง และช่วงวันที่; ห้ามสร้าง stock balance จากยอดขายอย่างเดียว |
| ราคา/สูตร/ต้นทุน | `Product_Cost_By_Filling`, `09_COST_MONTHLY`, `41_RECIPE_BASE` | แสดง effective month/ฐานอ้างอิง/ความไม่แน่นอน; ไม่ใช้ราคาปัจจุบันทับต้นทุนย้อนหลัง |
| HR / Payroll | D1 + input/mirror ตาม docs/02 | ไม่เปลี่ยนกติกาและสิทธิ์จากงานเว็บบัญชี; ข้อมูลพนักงานต้องอยู่ใน scope ที่ได้รับสิทธิ์ |
| Operational health / failed jobs | authenticated backend diagnostics | แสดงเวลา/สถานะแยกจาก spreadsheet exceptions; ห้ามเปิดหน้าแล้ว replay โดยอัตโนมัติ |

`listExpenseCases` และ `getExpenseCase` มีอยู่ใน source เป็น read layer ไม่ใช่หลักฐานว่ามี public website API ครบ
สัญญา `getExpenseDocuments` / `reviewExpenseCase` ใน docs/20 เป็นเป้าหมาย interface ต้องตรวจ implementation/routing ก่อนเรียกใช้งาน
ก่อนนำ read layer ไปทำยอดรวมต้องทดสอบ multi-document join ว่าไม่ทำให้ Expense เดียวถูกนับเงินซ้ำ

ข้อกำหนดร่วมของ response ในอนาคต:

- เงินใช้ integer satang ภายใน แปลงบาทตอนแสดง; ไม่รวมยอดจาก formatted text
- วันธุรกิจเป็น ISO date ตาม Asia/Bangkok; รองรับ พ.ศ. เฉพาะชั้นแสดงผลและ normalize ISO text / Sheets date serial อย่างชัดเจน
- คง `null/ไม่ครบ`, `0`, `error`, `รอยืนยัน`, `รอปิดวัน` แยกกัน; ไม่ใช้ error → 0 เพื่อให้หน้าดูผ่าน
- ระบุ source, as-of/fetched-at, period, record/version และสถานะ reconciliation; ตัวเลข cache เก่าต้องไม่แสดงว่า live
- อ่านแบบ bounded/paginated พร้อม scope; capacity ของแท็บไม่ใช่จำนวนข้อมูลสูงสุดของธุรกิจ
- ห้ามใช้ชื่อชีท/สถานะการซ่อนเป็น authorization; backend ตรวจ actor/role/branch/resource scope ทุกครั้ง
- ไม่ส่ง `ADMIN_TOKEN`, service-account key, private R2 key หรือ raw LINE IDs ไป browser/log/public artifact
- ไม่ให้ browser เขียน D1/Sheets หรือเรียก admin mutation โดยตรง; หน้า read-only ต้องไม่มี side effects

## 5. ข้อจำกัดที่ต้องแสดง ไม่ใช่ทำให้หายไปด้วย UI

1. ตัวเลือกเงินหน้าร้านรองรับเพียง ก.ย.–ต.ค. 2026 แม้มี source tabs เดือนอื่น; ห้ามให้เว็บเดือนถัดไปดูเหมือนรองรับแล้ว
2. แกนวันที่ `30_RECON_DAILY!A4` ยังเริ่มปี 2026 บางสูตรอิงแถวคงที่ 368/369; การปรับช่วงตามปีในบางสูตรไม่ได้แปลว่าทั้งระบบ rollover ปีอัตโนมัติ
3. ยังมีสูตรอิง `รายวัน` ถึงแถว 3554, `97_EXPENSE_CLEAN` ถึง 4500 และ guard ส่วนตัวในหน้าเงินสดถึง 1000 แถว; ต้องมี growth/parity tests ก่อนพอร์ต ไม่คัด cutoff ไปทำยอด API
4. ต้นทุน 17 รายการเป็นขนมปัง; ชิฟฟอน/คุกกี้ยังไม่ยืนยันต้นทุนต่อชิ้นในหน้าใหม่ ห้ามแสดงศูนย์แทน unavailable
5. Exception counts เป็นจำนวนวัน แต่ละกลุ่มอาจซ้ำวันเดียวกัน; ไม่ใช่จำนวนธุรกรรมเสีย/เงินหาย และไม่พิสูจน์ว่า failed jobs เดิมหายแล้ว
6. `CHECK`, `WARN`, `DATA_CHECK`, `IN PROGRESS`, `HOLIDAY`, `FUTURE` มีความหมายต่างกัน; หน้าเว็บต้องรักษา drill-down และหลักฐาน ไม่รวมเป็น PASS/FAIL อย่างเดียว
7. ซ่อนแท็บไม่ลดการคำนวณ; งาน 13 ต.ค. ปรับสูตร 310 ช่อง ลด INDIRECT 713 ครั้ง แต่ไม่ได้วัดเวลาเปิดไฟล์จริง ยังมี external imports และสูตรซ้ำบางส่วน
8. การ Undo หลังปิดเดือนและการ lock/reopen เดือนยังต้องยืนยัน policy ก่อนเพิ่มบนเว็บ ไม่ใช้การยืนยัน UAT ของรายการทั่วไปเป็นการอนุมัติแก้เดือนปิดแล้ว

## 6. ลำดับพัฒนาและ acceptance tests (ยังไม่ได้ทำใน PR เอกสารนี้)

เริ่มจาก Owner-only, read-only 4 เมนู แล้วขยายหลังมี authority ของงานพัฒนาแยก:

1. Inventory data/inputs/dependencies และกำหนด login/session + RBAC โดย reuse domain เดิม
2. สร้าง read adapter/API ที่แยก D1 facts จาก Sheets-derived metrics พร้อม provenance และ freshness
3. ทำ UI เงินหน้าร้าน / ปิดเดือน / ต้นทุน / รายการต้องตรวจ โดยไม่เปิด write flows แฝง
4. เทียบ parity ด้วย local synthetic fixtures; ใช้ Production read-only reconciliation เฉพาะเมื่อได้รับขอบเขตชัดเจน
5. ให้ Owner UAT ก่อนเสนอ write workflow, migration หรือ cutover; release ต้องมี approval ต่างหาก

ชุดทดสอบขั้นต่ำ:

- cash + CASH_DRAWER เทียบ cash + SHOP_BANK และ transfer + SHOP_BANK; ไม่หักรายจ่าย/float ซ้ำ
- เงินรับล่วงหน้าบางส่วน/เต็ม ข้ามเดือน และยอดชำระที่เหลือวันส่ง ไม่เกิดยอดขายหรือจำนวนขนมซ้ำ
- CONFIRMED/CANCELLED, duplicate webhook, multi-document Expense, retry และ Undo ไม่เพิ่มผลทางการเงินซ้ำ
- missing vs zero, invalid/negative counts, formula/source failure, source stale, ยังไม่ปิดวันนี้ และ unsupported period ต้องแสดงเหตุผล
- ISO date + Sheets serial, Bangkok เที่ยงคืน, สิ้นเดือน, ปีอธิกสุรทิน และเปลี่ยนปีโดยไม่แก้ประวัติ
- dataset เกิน 1,000 / 10,000 / 100,000 records, pagination ครบ, ไม่มี double-count ข้ามหน้า และไม่ query ทั้งฐานทุก request
- เจ้าของ/พนักงาน/ผู้ไม่มีสิทธิ์/ข้ามสาขา: server ปฏิเสธข้อมูลนอก scope; ไม่รั่วข้อมูลผ่าน error/cache/client bundle
- money/price/unit/effective month และ nullable chiffon/cookie costs; ไม่ตีความ contribution เป็น certified profit
- read-only page refresh ไม่ bootstrap/replay/reconcile/import/apply/confirm หรือสร้างธุรกรรม
- custom Sheets formulas, hidden tabs, raw evidence และ D1 row mappings ไม่ถูกเขียนทับจาก UI

## 7. ตรวจรับและย้อนแก้เอกสาร

Manual UAT ของ PR นี้: เปิดลิงก์เอกสารจาก README / mapping / architecture / roadmap, ตรวจชื่อแท็บ/ช่วงที่ระบุเทียบแหล่ง private แบบ read-only, แยกข้อจำกัดจากงานที่เสนอ และตรวจ diff ว่าไม่มีข้อมูลจริง/credentials หรือ runtime changes

Validation: `git diff --check`, ตรวจ relative Markdown links, ตรวจขอบเขต docs-only/ข้อมูลส่วนตัว และรัน `npm run check` กับ Wrangler dry-run ตาม repository gate ผลอยู่ใน PR ของ head ที่ส่งจริง ไม่อ้างว่าชุดทดสอบ backend พิสูจน์ website parity แล้ว

Rollback: revert เฉพาะ commit เอกสารผ่าน PR ปกติ ไม่ restore D1/Sheets และไม่ rollback Worker เพราะไม่มีการแก้ Production
ผลส่งมอบคือเอกสารเตรียมพัฒนา ไม่ใช่การเปิดเว็บหรือรับรองความถูกต้องของยอดบัญชีทั้งหมด
