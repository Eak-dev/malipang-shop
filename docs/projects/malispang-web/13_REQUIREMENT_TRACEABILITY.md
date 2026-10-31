# Requirement → design → task → acceptance

| Requirement | Design | Tasks | Evidence required |
|---|---|---|---|
| คำสั่งเดียวครอบคลุมงานจนเว็บใช้จริง | 14_EXECUTION_MANDATE, 16_EXECUTION_STATE | all tasks | submitted authority, eligible-task loop, exact checkpoints and full-program DoD |
| Codex ตรวจ software/hardware/accounts เอง | 15_READINESS_AND_OWNER_ACTIONS | W00/W01/W02/W13/W15 | observed status/evidence/remedy; no assumed purchase or fabricated readiness |
| Owner ทำเฉพาะสิ่งจำเป็นและไม่ถูกถามซ้ำ | 15_READINESS_AND_OWNER_ACTIONS | all tasks | prepared consent/policy/budget/release packet and approval reuse within exact scope |
| มือถือเป็นหน้าทำงานหลัก | 04_MOBILE_UX | W03/W04 | T20 + role happy/error paths |
| รวมสามไฟล์ ครบทุกข้อมูลที่จำเป็น | 02_BASELINE_AND_INVENTORY | W01/W08/W12/W14 | all-source disposition/lineage and reconciled totals |
| เลิก Sheets ทั้งหน้าจอและตัวคำนวณเมื่อย้ายครบ | 06_DATA_AND_API, 07_MIGRATION_CUTOVER | W12/W16 | actual period close + no unresolved reader/writer |
| สมาชิกหลายระดับ กำหนดเพิ่มได้ภายหลัง | 03_PERMISSIONS | W02/W03/W11 | capability×scope×field matrix; deny default; audited grants |
| Team เห็นเท่าขอบเขตไฟล์ทีมเดิม | 02_BASELINE_AND_INVENTORY, 03_PERMISSIONS | W01/W03/W04/W05 | approved field list; unauthorized API/export/evidence tests |
| รวม LINE OA อัปเดตข้อมูลร้าน | 04_MOBILE_UX | W01/W07/W16 | all command/menu rows mapped; audience/version UAT |
| ลงเวลาเข้า–ออกผ่านเว็บ | 04_MOBILE_UX, 05_ARCHITECTURE | W06/W13 | existing evidence rules + cross-channel duplicate/failure tests |
| รักษาสมาชิกและประวัติเดิม | 03_PERMISSIONS, 06_DATA_AND_API | W03/W11/W14 | uniqueness, canonical linking, historical parity |
| เงิน/ค่าแรงไม่ผิด | 06_DATA_AND_API | W10/W11/W12 | satang-level per-record/aggregate, no missing-punch auto pay, period CAS |
| สต๊อก/สูตร/ซื้อทำซ้ำได้ | 06_DATA_AND_API | W05/W08/W09 | unit precision, versions, actual/plan distinction, receipt uniqueness |
| ไม่มีงานตกหล่นเมื่อเลิกแชต | 04_MOBILE_UX, 07_MIGRATION_CUTOVER | W01/W07/W13/W16 | durable web receipts/inbox, all old flows accounted |
| ย้ายโดยไม่ทิ้งรายการใหม่ | 07_MIGRATION_CUTOVER | W14/W15 | interrupted import/rerun/delta rollback drills |
| ขึ้นโครงการใหม่และสั่ง Dev ต่อได้ | PROJECT_CONTROL, 09_ROADMAP, 11_CODEX_KICKOFF | W00/W02 | linked Issues, dependency graph, exact next action and authority |
| เอกสารเก็บ GitHub | README, 12_PLAN_VALIDATION | Epic #175 planning PR | remote SHA/content readback; no sensitive source payloads |
| ไม่ข้าม Project Control/Production approval | PROJECT_CONTROL | all tasks | #58 gate, named transition/GO, exact candidate evidence |

Coverage ในตารางนี้พิสูจน์ว่าแผนครอบคลุมความต้องการ ไม่ใช่หลักฐานว่า implementation หรือ source inventory เสร็จแล้ว
