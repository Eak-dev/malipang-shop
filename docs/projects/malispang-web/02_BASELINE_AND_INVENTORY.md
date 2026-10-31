# Baseline, inventory และ traceability

วันที่ตรวจ GitHub: 2026-09-08; canonical main = `597b8d0f016f2cabb9656a8a54b6356ff5d565fc`.
เอกสารนี้ไม่ยืนยัน deploy/config/ข้อมูลจริงล่าสุด; Production state = UNKNOWN

## แหล่งหลักฐานที่อ่าน

| Source | พบอะไร | ข้อจำกัด |
|---|---|---|
| [AGENTS](../../../AGENTS.md) | authority, canonical-main gate, attendance/expense invariants | ต้องอ่านรุ่นล่าสุดก่อน implementation |
| [Architecture](../../07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md) | Worker/D1/R2/Queues และ business service เดิม | เอกสารมี snapshot เก่า |
| [Identity](../../19_V11_IDENTITY_ACCESS_TH.md), [authorize](../../../src/access/authorization.ts) | OWNER/MANAGER/ASSISTANT/EMPLOYEE, self/branch/org, existing payroll.self.read | code permission ไม่ใช่ approved web exposure ทุกช่อง |
| [Expense V2 contract](../../20_V12_EXPENSE_V2_CONTRACT_TH.md), [LINE flow](../../05_LINE_FLEX_FLOW_TH.md) | expense case/evidence/items/audit และ confirmation | doc service signatures บางส่วนเป็น intended contract ต้องตรวจ exports จริง |
| [Router](../../../src/router/process-event.ts) | HR, correction, OT, personal use, expense, attendance routing | actual LINE rich menus/auto-reply ต้องตรวจ setting เพิ่ม |
| [Sheets inventory](../../board/01_SHEETS_DEPENDENCY_INVENTORY.md) | imports, mirror, accounting layout, readiness, sync flag | historical audit ต้องทำ delta ล่าสุด |
| [#58](https://github.com/Eak-dev/malipang-shop/issues/58) | OPEN; hard gate ก่อน V2 | archive evidence ไม่ใช่ full decommission |
| [#45](https://github.com/Eak-dev/malipang-shop/issues/45) | CLOSED; Board เก่า read-only ไม่รวม stock | frozen ไม่ใช่ implemented |
| [#163](https://github.com/Eak-dev/malipang-shop/issues/163) | READY_FOR_DESIGN, current-runtime queue #163–#171 | design approval ไม่ได้เกิดจาก MPW |
| [#148](https://github.com/Eak-dev/malipang-shop/issues/148) | historical payroll ต้องตรวจ delta/evidence | ไม่เริ่มแก้ยอดจาก MPW |

## Source register — ไม่เผย file IDs ใน public docs

| Alias | ไฟล์ | แท็บจากบทสนทนาก่อนหน้า | หน้าที่ | สถานะรอบนี้ |
|---|---|---:|---|---|
| S-OWNER | MaliPang_OWNER_MASTER | 77 | Owner reports/config/accounting/HR | NOT_REVALIDATED |
| S-STOCK | MaliPang_STOCK_MASTER | 45 | stock/recipe/production/purchase | NOT_REVALIDATED |
| S-TEAM | MaliPang_StockCheck_TEAM | 17 | team counts/daily movement/calendar/bill | NOT_REVALIDATED |
| S-LINE | LINE OA หลังบ้าน | ไม่ใช้จำนวนแท็บ | attendance/HR/expense/personal/OT/feedback | code routes inspected; settings UNKNOWN |

77+45+17=139 เป็น historical context; ห้ามเขียนว่า field mapping ครบ 139 แท็บแล้ว. W01 ต้องเข้าถึง actual files แบบ read-only และสร้าง private inventory ที่สรุป coverage โดยไม่เผยข้อมูลธุรกิจ

## Required inventory row schema

ทุกแท็บ/range/command ต้องมี: source alias, stable tab ID (เก็บ private), display name, visibility/protection, role exposure, range/columns, meaning, input/formula/report/config/archive, unit/precision/timezone, reader, writer, import/sync/trigger, key strategy, target entity/field, transformation, null/zero rule, validation, history bounds, sensitivity, evidence timestamp, confidence, disposition, owning task และ reviewer

ถ้าข้อมูลใหม่พบเพิ่มจำนวน source rows ต้องเพิ่ม denominator ไม่ทำให้ coverage ผ่านด้วยการตัด source ที่ยากออก. Public summary แสดง count/coverage/decision references; exact file IDs, rows, staff data และสูตรจริงเก็บใน private evidence system เดิม

## Domain ownership baseline

| Domain | ก่อนย้าย | หลังย้ายที่เสนอ | สิ่งที่ต้องเคลียร์ |
|---|---|---|---|
| สมาชิก/สิทธิ์ | D1; มี import/HR flow เดิม | identity เดิม + web sessions | approved web exposure, provider binding |
| Attendance/Payroll | D1 core + Sheets mirror/config บางส่วน | services เดิม + web adapter | time evidence, corrections, historical parity |
| Expense/personal ledger | D1 case/transaction + Sheets accounting | services เดิม + database reports | #163–#171, closed periods, account unknown |
| Stock/recipes/units | S-STOCK/S-TEAM ตาม mapping ที่จะตรวจ | domain tables และ immutable movements | approved source/recipe/unit/opening balance |
| Production/purchasing | plans/formulas ใน S-STOCK | versioned plans/orders/receipts | supplier lead time, round yields, buffer |
| Daily sales quantities | S-TEAM | daily count sessions | actual sales vs inferred quantities, returns/transfers |
| Financial reports | S-OWNER รวมสูตร/inputs | independently reconciled report calculations | recognition/rounding/valuation/period rules |
| Shop announcements | current channel/settings UNKNOWN | versioned announcements | current editor/audience/expiry |

## Known conflicts to resolve without guessing

นม 1,000 ml อาจเป็นค่าตั้งไว้ ไม่ใช่ยอดนับจริง; เอกสารสูตรมีฐาน 3/4/5 kg ต่างบริบท; ปฏิทินมีข้อกำหนดวันหยุดเก่ากับคำสั่งใหม่. W01 ต้องเสนอค่า/แหล่งหลักฐาน/ผลกระทบให้ Owner ตัดสินเฉพาะที่ approved source ยังไม่พอ. ไม่ publish ค่าใช้จ่าย/สูตรจริง และไม่เปลี่ยนสูตรระหว่าง migration

## Coverage/finish proof

Inventory coverage = rows with reviewed disposition / all discovered rows. Acceptance 100% scoped rows with no unexplained business reader/writer. UNKNOWN ที่เหลือต้องมี blocker และ owner task; ไม่แทนด้วย PASS. การอ่าน inventory เก่าและ source code ไม่พิสูจน์ Google-side current triggers หรือ formulas
