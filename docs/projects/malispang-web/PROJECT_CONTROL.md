# MPW Project Control

Scope: เฉพาะโครงการ MalisPang Operations Web / Epic #175. ไม่แทน control ของ current-runtime, #58 หรือ #163–#171

## Current state — 2026-09-08

| Field | Value |
|---|---|
| Owner mandate | วางแผนให้จบและเก็บเอกสารบน GitHub ตามคำสั่ง 2026-09-08 |
| Authority รอบจัดทำเอกสาร | DEV_OWNED จำกัด documentation และ planning metadata, L0–L1 |
| Phase | P0 — PROJECT_PLANNING |
| Planning deliverable | READY_FOR_OWNER_REVIEW เมื่อ PR และ readback verification ครบ |
| Implementation | BLOCKED_BY_LEGACY_DECOMMISSION |
| Active runtime task | ไม่ dispatch จากโครงการนี้; current portfolio อ้าง #163 |
| Allowed | อ่าน source/issues, ออกแบบ, เอกสาร, task backlog, docs branch/commit/PR |
| Forbidden | runtime/frontend implementation, migrations, merge, deploy, Production/API business writes, LINE messages/settings, Sheets writes, Legacy actions, policy changes |
| Deployment permission | NONE สำหรับ TEST hosting และ Production; local documentation validation ได้ |
| Canonical source baseline | 597b8d0f016f2cabb9656a8a54b6356ff5d565fc |
| Production state | UNKNOWN ในรอบนี้; main และ README ไม่ใช่หลักฐาน runtime สด |
| Rollback รอบนี้ | reviewed docs revert; ไม่มี business data เปลี่ยน |

## Authority and evidence

Project instructions/Owner decisions กำหนดสิ่งที่อนุญาต; repository/runtime evidence พิสูจน์สิ่งที่มีจริง ห้ามใช้ code presence เป็นการอนุมัติ และห้ามใช้เอกสาร override ความจริงที่ขัดกัน

ไม่พบ root PROJECT_CONTROL.md ใน canonical tree ที่ตรวจ จึงสร้างไฟล์นี้ภายใต้โครงการใหม่ ไม่อ้างว่าเป็น global control. เอกสารที่ยังอยู่บน PR เป็นข้อเสนอให้ review ไม่ใช่ merged policy

Hard gate: [Owner direction #58](https://github.com/Eak-dev/malipang-shop/issues/58#issuecomment-5139941204) กำหนด #58 CLOSED พร้อม LEGACY_FULLY_DECOMMISSIONED ก่อน V2 implementation. วันที่ผ่านไปหรือ archive บางส่วนไม่เท่ากับ gate ผ่าน. คำสั่งวางแผนรอบนี้อนุญาต planning ต่อ ไม่ได้ยกเลิก gate

## Transition rules

| From → To | หลักฐานที่ต้องมี | ผู้ตัดสิน |
|---|---|---|
| P0 planning → design accepted | Owner review ขอบเขตและ decision ที่กระทบธุรกิจ; docs version/head | Owner |
| Planning → implementation ready | #58 completion evidence, latest baseline, W01 mapping และ W02 contract ผ่าน, task-specific authority | Owner/PO ตาม authority ที่ได้รับ |
| Task ready → DEV_OWNED active | ระบุ Issue/branch/base, allowed files/scope, DoD, dependency, forbidden scope; ไม่มีงานชน | PO ภายในขอบเขตที่ Owner อนุมัติ |
| Candidate → UAT | exact SHA, required local/CI checks, approved testers/environment/data และ UAT authority | Owner |
| UAT → rollout | concrete change request: target/SHA/config/secret scope/backup/reconcile/rollback + explicit GO | Owner |
| Module rollout → retirement | parity/observation, all readers/writers replaced, restore evidence + exact retirement authorization | Owner |

ทุก transition บันทึกวันเวลา Asia/Bangkok, evidence URLs, approver, from/to, allowed action, outstanding blockers. ห้ามลด AC หรือเปลี่ยนสถานะเพียงเพื่อให้เริ่มงานได้

## Existing work boundaries

- #163–#171 เป็น current-runtime hardening: เว็บต้อง consume final approved contracts ไม่ทำแพตช์ซ้ำ
- #148 เป็น payroll historical evidence/correction; เว็บไม่ recalculation ประวัติแทน Issue นี้
- #58/#60/#71/#65/#66 เป็น legacy track; MPW ไม่สืบทอด AUTO_RELEASE
- #45/#47–#57 เป็นแผนเก่าที่ frozen/closed; ไม่ reopen/close โดยไม่มีงานและหลักฐานเฉพาะ
- เอกสารในชุดนี้ไม่อนุญาตลดสิทธิ์ LINE เดิมหรือเปิดสิทธิ์เว็บใหม่จริง

## Session handoff

### Program execution proposal — 2026-09-08 follow-up

Owner ขอให้ออกแบบคำสั่งเดียวที่ให้ Codex รับผิดชอบตรวจซอฟต์แวร์/บัญชี/อุปกรณ์และทำงานถึงเว็บใช้งานจริง. รอบนี้อนุญาตแก้ docs/Issues/PR เพื่อจัดคำสั่ง ไม่ได้เริ่ม runtime หรือขยาย deployment permission. [Master mandate](14_EXECUTION_MANDATE.md) มีผลเป็นการมอบหมายงานเมื่อ Owner ส่งคำสั่งนั้นจริง; repository text ไม่ใช่หลักฐานการอนุมัติตัวเอง

เมื่อมี submitted program mandate ให้บันทึก authority source และ eligible next tasks ใน control: routine L0–L1 tasks ภายใน approved scope ทำต่อได้โดยไม่ขอ dispatch ซ้ำทุก Issue. #58, W02 business decisions, TEST resources/budget, ordered merge และ exact release/retirement gates ยังคงครบ. ถ้าต้องรอ ให้ทำ independent authorized planning ต่อและจัด [Owner Action Packet](15_READINESS_AND_OWNER_ACTIONS.md) แทนการทิ้ง checklist ให้ Owner ตรวจเอง

ใช้ [Execution state](16_EXECUTION_STATE.md) เป็น schema สำหรับ latest checkpoint; ไม่ใช่คำสั่งตั้ง automation หรือหลักฐานว่ามี job ทำงานอยู่เบื้องหลัง

บันทึก task, authority, current phase, base/head, changed paths, AC→evidence, test skips, unknowns, next exact action และ environment. เมื่อเปลี่ยน session อ่าน control + Issue + diff หลัง checkpoint ไม่เริ่มวิเคราะห์ทั้งโครงการใหม่ และไม่เขียนทับงานค้างของผู้อื่น
