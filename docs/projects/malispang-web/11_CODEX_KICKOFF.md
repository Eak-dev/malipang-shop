# เริ่มโครงการใน session ใหม่

**คำสั่งหลักรุ่นล่าสุดอยู่ที่ [14_EXECUTION_MANDATE.md](14_EXECUTION_MANDATE.md)** ครอบคลุม readiness→implementation→UAT→release→retirement และ checkpoint. ใช้คำสั่งนั้นหากต้องการมอบหมายงานทั้งโปรแกรม. Prompt W00 ด้านล่างเก็บไว้สำหรับการตรวจสถานะแบบ read-only โดยเฉพาะ ไม่ใช่คำสั่งหลักสำหรับพัฒนาจนจบ

ใช้เอกสารนี้กับ [Epic #175](https://github.com/Eak-dev/malipang-shop/issues/175) และ [Task index](tasks/README.md). เอกสารอยู่บน planning PR จน Owner อนุมัติ merge; อย่าอ้างว่าเป็น approved main policy ก่อน merge. Prompt แรกออกแบบให้ทำงานที่ตรวจได้จนสุด allowed scope โดยไม่ข้าม #58

## Prompt พร้อมใช้ — planning continuation / W00

```text
Recommended Model
- PO/PM: GPT-6 Astra — Thinking High
- Codex Dev: GPT-6 Astra — Thinking High
- Reason: establish current authority, legacy prerequisite and data/security baseline before web development.
- Upgrade to: GPT-6 Astra / High เมื่อพบ policy, money, identity หรือ release contradiction; retain High for final review.

สำหรับงานนี้ให้คุณเอกเลือก GPT-6 Astra และ Thinking High

Project: MalisPang Operations Web (MPW)
Repository: Eak-dev/malipang-shop
Epic: #175
Task: #176 / W00
Planning branch: codex/docs-malispang-web-project-plan
Planning package: docs/projects/malispang-web/README.md
Authority: REVIEW_ONLY for this continuation prompt unless the Owner explicitly grants a named documentation or development task.

Read AGENTS.md, README.md, docs/07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md,
docs/projects/malispang-web/PROJECT_CONTROL.md and 09_ROADMAP.md,
then latest Issue #176 and #58 relevant evidence/comments.
If documents are not on main, read the planning PR/branch as proposals; do not merge it automatically.

Baseline inspected during planning: 597b8d0f016f2cabb9656a8a54b6356ff5d565fc.
Fetch and verify current canonical main before any future repository mutation.
Use a clean isolated checkout if existing work is uncommitted; never reset/overwrite it.
Current Production SHA/config must be verified separately; never infer from main or old README snapshot.

Goal: complete W00 current gate/evidence matrix and give the next concrete allowed action.
Allowed: read-only inspection, compare control/issue/source, identify completed/remaining evidence, report decisions.
Forbidden: V2 runtime/frontend/session/API implementation while #58 hard gate remains; no production/TEST hosting, merge, deploy, remote migration, LINE messages/settings, Sheets writes, queue replay, retention or business-policy changes.

DoD: record authority, phase/status/action, baseline, dependency states, source confidence, unknowns,
allowed/forbidden scope, deployment permission and precise next task.
If #58 is still open or evidence incomplete, mark implementation BLOCKED_BY_LEGACY_DECOMMISSION.
Do not rename work as planning to start code. Do not close #58 from this task.
If gate passes, prepare a concrete control-transition proposal for the next named task;
do not treat this prompt as development approval.

Keep ChatGPT/PO-PM, Codex Developer and LINE bot AI model separate. Do not change bot model.
Finish all authorized investigation without restarting the project or requesting known information again.
Return evidence links and exact next action; unknown remains UNKNOWN, never PASS.
```

## Prompt template หลังมี named implementation authority

```text
Recommended Model
- PO/PM: GPT-6 Astra — Thinking High
- Codex Dev: [model selected for the named task] — Thinking [level]
- Reason: [specific task risk and accepted contract]
- Upgrade to: GPT-6 Astra / High เมื่อเกี่ยวกับ identity, accounting, concurrency, migration หรือ release review

สำหรับงานนี้ให้คุณเอกเลือก [model] และ Thinking [level]

Task: [exact Issue, existing PR if any]
Authority: [Owner-approved named mode; never infer]
Control: docs/projects/malispang-web/PROJECT_CONTROL.md
Roadmap: docs/projects/malispang-web/09_ROADMAP.md
Baseline: verify latest canonical main and current approved task head.
Prerequisites: #58 CLOSED with completion evidence, W00 transition, task-specific dependencies and approved design.
Allowed scope/forbidden scope: use exact Issue body plus subsequent approved decisions.
Read AGENTS.md and required docs, then only affected subsystem/diff and task acceptance criteria.
Do the complete named task, focused tests then mandatory check/dry-run/CI on exact head.
Schema changes: clean/old-shape/rerun/integrity/FK and rollback compatibility tests.
Do not use Production secrets/live fixtures to make tests pass.
Keep current business invariants; no policy/identity inference; no unrelated fixes.
Open/update the focused PR with base/head, AC→evidence, migrations/config, UAT, rollback and limitations.
Deployment/merge permission: NONE unless separately authorized for exact target and candidate.
Stop only for real security/credential/Owner-policy/environment/conflict blockers after preparing concrete reviewable options.
Checkpoint exact next action to resume without resetting work.
```

## New chat/project context

ชื่อ: มะลิปัง — Operations Web. ใส่ลิงก์ Epic #175 และ package README เป็นจุดเริ่ม ไม่คัดลอกข้อมูลพนักงาน/สูตรจริงเข้า public project prompt. เอกสารสรุปนี้ไม่สร้าง ChatGPT project หรือ GitHub Projects board อัตโนมัติ; Epic และ Issues เป็นโครงติดตามงานที่สร้างได้จริงในรอบนี้
