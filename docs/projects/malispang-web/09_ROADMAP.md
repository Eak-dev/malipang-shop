# Roadmap และลำดับเปิดใช้

ดู work packages พร้อม AC/test/UAT/rollback ที่ [Backlog](tasks/README.md). ทุกวันเป็นสมมติฐาน effort ไม่ใช่วันนัดส่ง; ไม่รวมเวลารอ Owner, access, #58, CI review หรือ observation

## Execution order

| ช่วง | Tasks | Deliverable / gate |
|---|---|---|
| Planning | W00→W01→W02 | verified control, complete mapping, accepted design; ไม่มี runtime implementation |
| Foundation | W03→W04; W13 หลัง W03 | sessions/auth, mobile read-only, transaction/recovery foundation |
| Team pilot | W05/W06/W07 หลัง prerequisites | นับสต๊อก ลงเวลา ประกาศ/requests; ผ่าน per-module W14/W15 ก่อน live |
| Stock operations | W08→W09 | ledger/units/recipe→production/order/receipt |
| Owner administration | W10 หลัง contracts hardening; W11 หลัง W06 | finance and HR adapters to existing services |
| Owner reporting | W12 หลัง W09/W10/W11 | reports and accounting close parity |
| Rehearsal/rollout | W14→W15 ต่อ release scope | exact module source/target/UAT/GO/observation |
| Retirement | W16 หลังทุก replacement และ observation | no operational Sheets or LINE intake dependency |

Task dependency graph ไม่มีวงจร. ลำดับในตารางคือการจัดคิว ไม่ใช่อนุญาตหลาย Dev/agents แก้ schema/permission/service พร้อมกัน. ใช้หนึ่ง active implementation task ต่อ shared subsystem; concurrency เพิ่มภายหลังเมื่อแยก ownership ได้จริงและได้รับอนุญาต

## Release-scope gates

- R1 read-only: W00/W01/W02/W03/W04 + read-path portions of W13/W14/W15 และ #58 gate. ไม่มี POST business functions เปิดจริง
- R2 Team: W05/W06 (W07 หากเปิดประกาศ) + complete relevant W13/W14/W15. ไม่ต้องรอ W10–W12 เสร็จ
- R3 stock: W08/W09 + module-specific reconciliation/UAT. ไม่ใช้ incomplete purchase plan เป็นคำสั่งซื้อจริง
- R4 Owner: W10/W11/W12 + upstream contracts and own rehearsal/UAT. ไม่มี financial rollout เมื่อ policy/unknown mapping ค้าง
- R5: W16 หลัง actual month-close และ all-module dependency exit. อย่าปิด W14/W15 ทั้ง Issue เพียงเพราะ R1/R2 ผ่าน; ใช้ per-release acceptance checklist ใน Issue เดียว

## Relationship to existing backlog

| Existing work | Relationship to MPW |
|---|---|
| #58, #60, #71, #65, #66 | hard prerequisite to any V2 implementation; existing legacy authority remains scoped |
| #163 account identity | W10/W12 consume approved account model; unknown historical bank preserved |
| #164 expiry/closed periods | W10/W12 must wait for approved policy; UI cannot decide by itself |
| #165/#166/#167 Sheets safety/capacity/formulas | migration/parity while mirrors active; retire only after verified replacement |
| #168 audit | W10/W13 preserve final append-only contract |
| #169 money parser | W10 shared validation and business maximum from approved source |
| #170 notification recovery | web inbox integrates durable drafts; no duplicate recovery service |
| #171 failed-job completion | W13/reconciliation reuses verified recovery semantics |
| #148 payroll evidence | W11/W12 historical parity dependency, not invitation to recalculate old payroll |
| #45 and old children | design/history only; no automatic reuse of stale scope or approval |

ไม่สร้าง blanket gate “ทุก #163–#171 ต้องปิดก่อน read-only web” โดยไม่มีเหตุ. Hard dependency พิจารณาตาม behavior ของ module; ระหว่าง Sheets ยัง active ต้องรักษาทุก safety fix ที่เกี่ยวข้อง

## Resourcing and checkpoints

สมมติ Dev หนึ่งคนและ PO/reviewer ตามช่วง. ประมาณ effort รวม 64–117 focused person-days จาก W00–W16; ตัวเลขแต่ละ task เป็น starting range ต้อง re-estimate หลัง W01/W02. Calendar duration ยาวขึ้นเมื่อรอ gate และ required business cycles ไม่ควรสัญญาว่าเว็บทั้งหมดเสร็จในไม่กี่วัน

ทุก task ส่ง checkpoint เมื่อเปลี่ยน session: issue/base/head, modified files, tests/evidence, blockers, next action. อ่าน required docs + subsystem diff; ไม่ส่งประวัติทั้งโปรเจกต์ใน prompt. ใช้ existing test harness และ mandatory final gates ไม่ลด coverage เพื่อประหยัด token

## Program completion

Owner/Team ทำทุก scoped daily/weekly/monthly task ผ่านเว็บได้; permission/source mapping complete; all migration counts/totals correct; history/backup accessible; no unexplained lost/duplicate; optional notification failure recoverable; no operational dependency requiring Sheets or LINE chat input; Owner accepts outcomes and closes program with evidence. Planning complete is a separate milestone from this program completion
