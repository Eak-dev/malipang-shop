# Sheets Dependency Audit — Final Status 2026-07-26

Parent: #46  
Primary inventory: `docs/board/01_SHEETS_DEPENDENCY_INVENTORY.md`

เอกสารนี้บันทึกสถานะสุดท้ายของ Phase-0 dependency audit หลังมี code fixes, Owner-confirmed Legacy Version 19 evidence และตรวจ current Owner Master จาก Google Drive เพิ่มเติม

> การปิด #46 หมายถึง **audit/inventory เสร็จ** ไม่ได้หมายความว่า Google Sheets พร้อมปิด หรือ Legacy Apps Script พร้อมปิด

## 1. Repository Sheets dependencies — audited

พบและบันทึก dependency หลักครบใน primary inventory:

- Direct Google Sheets API client/auth
- `HR_STAFF_CONFIG` import
- `HR_SHIFT_SCHEDULE` import + mirror
- Attendance mirror
- Daily/Weekly Payroll mirror
- Wage History mirror
- OT mirror
- Expense raw mirror
- `รายวัน` legacy accounting layout read/write/clear behavior
- bootstrap-sheets
- reconcile-sheets
- retry/stale sync recovery
- `/admin/readiness` Sheets metadata + daily-layout dependency
- Google service-account config names
- behavior ของ `SHEETS_SYNC_ENABLED=false`

## 2. Current Owner Master — Drive-side structural confirmation

Google Drive metadata ของ current `MaliPang_OWNER_MASTER` ยืนยันว่าไฟล์จริงมีทั้ง Worker V5.2 tabs และ Legacy Version-19 tabs อยู่ร่วมกัน

ตัวอย่าง tabs ที่ยืนยันแล้ว:

### Worker / V5.2
- `HR_STAFF_CONFIG`
- `V52_ATTENDANCE_RAW`
- `V52_DAILY_PAYROLL`
- `V52_WEEKLY_PAYROLL`
- `V52_EXPENSE_RAW`
- `V52_SYSTEM_LOG`
- `HR_WAGE_HISTORY`
- `HR_SHIFT_SCHEDULE`
- `HR_OT_REQUESTS`
- `รายวัน`

### Legacy Version 19
- `Config`
- `Logs`
- `HR_LINE_RAW`
- `HR_ATTENDANCE_RAW`
- `SYS_IMAGE_PENDING`
- `SYS_EXPENSE_CASES`
- `SYS_EXPENSE_ITEMS`
- `SYS_EXPENSE_EVIDENCE`
- `SYS_IMAGE_ROUTER_LOG`
- `EXPENSE_CATEGORY_MASTER`
- `EXPENSE_WALLET_MASTER`
- `EXPENSE_ITEM_RULES`
- `EXPENSE_SYSTEM_CONFIG`

Spreadsheet timezone ที่ตรวจได้คือ Asia/Bangkok.

ไม่มี Spreadsheet ID, URL, owner email หรือ service-account identifier ถูกเก็บในเอกสารนี้

## 3. Expense wallet/category dependency

Current Worker ไม่ได้อ่าน `EXPENSE_WALLET_MASTER` หรือ `EXPENSE_CATEGORY_MASTER` เป็น runtime config จาก Google Sheets

Current implementation อยู่ใน TypeScript:

- payment/card aliases + Wallet mapping: `src/expense/text-parser.ts`
- auto category keywords: `src/expense/text-parser.ts:autoCategory`
- `รายวัน` payment-column/cutoff mapping: `src/sheets/daily-expense.ts`

ดังนั้น Legacy Expense master tabs เป็น **historical/reference dependency** สำหรับ parity ไม่ใช่ runtime Sheets input ของ Worker V5.2 ในปัจจุบัน

ก่อนย้ายไป Board editable config ในอนาคต ต้องตัดสินใจว่าจะ migrate mappings เหล่านี้เข้า D1/config service หรือคง code-owned policy ไว้

## 4. Payroll cycle regressions found during audit — resolved

ระหว่าง dependency audit พบจุด Monday-cycle ที่หลงเหลือหลังเปลี่ยน Payroll เป็น Thursday–Wednesday และแก้แล้ว:

- Payroll core cycle: #44 / PR #64
- Sheets reconcile weekly key: #69 / PR #70
- Attendance-created Weekly Payroll sync key: #72 / PR #73

ทั้งหมดผ่าน CI ก่อน merge

## 5. `SHEETS_SYNC_ENABLED=false` — final documented behavior

Flag นี้ **ไม่ใช่ lossless pause** และไม่เท่ากับถอน Google Sheets:

- sync writer หยุด
- การ enqueue/persist sync jobs ใหม่ก็หยุดด้วย
- import employees/shifts, bootstrap และ readiness ยังพึ่ง Sheets
- เมื่อเปิดกลับ `/admin/retry-sync` อย่างเดียวไม่สามารถเติมช่วงที่ไม่มี sync job ได้

Rollback/backfill ที่ถูกต้องต้องใช้ date-bounded `/admin/reconcile-sheets` ครอบคลุม disabled interval แล้วรอ sync/failed/DLQ/parity gate กลับมาปกติ

## 6. `รายวัน` protected/formula-layout behavior

Backend ใช้ `รายวัน` เป็น legacy accounting layout ไม่ใช่ generic table

Current writer:

- อ่าน month blocks/header/cutoff config จาก layout เดิม
- reserve row ผ่าน D1 mapping
- clear เฉพาะ input ranges ที่ backend เป็นเจ้าของ
- เขียน date/description/payment/category/source wallet เฉพาะช่องที่กำหนด
- ไม่ rewrite formula/report areas อื่น

ดังนั้น Google Sheets retirement ต้องมี replacement สำหรับ monthly/accounting/card-cutoff/report behavior ก่อน

## 7. Legacy cleanup status — supersedes primary inventory line

Primary inventory เดิมระบุ `Daily image retention cleanup` เป็น `MISSING — #74 BLOCKER` ณ เวลาที่สร้างเอกสาร

สถานะล่าสุด:

- #74 resolved
- PR #76 merged
- Worker มี **non-destructive R2 retention audit**
- scan R2 โดยตรง รวม orphaned uploads
- mark `RETENTION_ELIGIBLE` ตาม policy 90/7 วัน
- ไม่เรียก `R2.delete()` และไม่ลบ R2 evidence
- feature flag disabled by default

นี่เป็น intentional policy change จาก Legacy Version 19 เพราะ repository invariant ห้ามลบ R2 evidence

## 8. Board 5-module data readiness conclusion

| Module | Current primary data | Phase-1 read-only Board | Google Sheets dependency that remains |
|---|---|---|---|
| Attendance | D1 + R2 | Ready to read after runtime parity gate | Staff config + mirror/parity |
| Payroll | D1 | Ready to read after release/parity gate | staff/shift input + mirror/parity |
| Expense | D1 + R2 | Ready to read | `รายวัน` accounting output still required |
| Employee Config | D1 after import | Read-only display possible | source/edit flow still `HR_STAFF_CONFIG` |
| System Status | D1/Queue/R2/integration checks | Read-only display possible | current readiness contract still requires Sheets |

## 9. Audit deliverable conclusion

Phase-0 dependency inventory itself is complete enough to unblock design/read-only Board work.

สิ่งต่อไปนี้ **เป็น migration/cutover blockers ไม่ใช่ audit gaps**:

- replace `HR_STAFF_CONFIG` source/edit flow before final Sheets retirement
- replace `HR_SHIFT_SCHEDULE` source/edit flow
- replace `รายวัน` accounting/report behavior
- make Sheets optional in readiness only when retirement is approved
- remove Google credentials/import/bootstrap/reconcile only after parity + Owner approval
- complete Legacy Apps Script external inventory/backup under #60/#71
- complete runtime proof #59 and observation #61 before Legacy shutdown

## Safety conclusion

- Google Sheets sync remains ON
- no Production deploy is authorized by this audit
- no Runtime Mode change
- no Secret/LINE Webhook change
- no Legacy Apps Script shutdown

#46 can be closed as **audit completed** while #58/#59/#60/#61/#65/#66 continue to control Legacy decommission and later issues control Google Sheets retirement.
