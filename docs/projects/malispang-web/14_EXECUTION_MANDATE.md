# คำสั่งหลัก — ทำ MPW ตั้งแต่ตรวจความพร้อมจนเว็บใช้งานจริง

Version 1.1 • 2026-09-08 • Epic #175 / PR #193

เอกสารนี้เป็นคำสั่งที่เตรียมให้ Owner ส่งเข้า Codex เพื่อมอบหมายงานต่อเนื่อง. การเขียน/อัปโหลดคำสั่งในรอบนี้เป็น docs-only ไม่ได้เริ่ม implementation หรืออนุมัติ deploy. คำสั่งพร้อมใช้ด้านล่างไม่ต้องเติมชื่อ Issue ทีละตัว แต่ยังรักษา business/Legacy/release gates ที่มีอยู่

## คัดลอกส่วนนี้ส่งให้ Codex

```text
Recommended Model
- PO/PM: GPT-6 Astra — Thinking High
- Codex Dev: GPT-6 Astra — Thinking High
- Reason: own readiness, identity, data migration, accounting correctness and delivery across the complete MPW program.
- Upgrade to: GPT-6 Astra / High เมื่อพบ architecture/security/concurrency/money/release risk; keep High for final review. Bounded UI tasks may use the approved per-task model without changing scope.

สำหรับงานนี้ให้คุณเอกเลือก GPT-6 Astra และ Thinking High

ฉันมอบหมายให้คุณเป็น Codex Developer และผู้ดำเนินงานของ MalisPang Operations Web (MPW) จนถึงเว็บหลังบ้านที่ Owner และพนักงานใช้งานจริงได้ครบตามขอบเขตโครงการ ไม่หยุดเพียงส่งแผน เขียนโค้ดผ่าน หรือเปิดหน้าเว็บตัวอย่าง

Repository: Eak-dev/malipang-shop
Epic: https://github.com/Eak-dev/malipang-shop/issues/175
Planning PR: https://github.com/Eak-dev/malipang-shop/pull/193
Planning branch: codex/docs-malispang-web-project-plan
Document root: docs/projects/malispang-web/
Execution guide: 14_EXECUTION_MANDATE.md
Readiness/Owner-action contract: 15_READINESS_AND_OWNER_ACTIONS.md
Durable checkpoint contract: 16_EXECUTION_STATE.md
Tasks: W00–W16 / Issues #176–#192, dependency links in tasks/README.md

AUTHORITY เมื่อฉันส่งคำสั่งนี้:
- DEV_OWNED สำหรับตรวจข้อมูล/ความพร้อม จัดทำเอกสาร และพัฒนา/ทดสอบใน local isolated environment ภายใน MPW หลัง prerequisite/design/control gates ของงานนั้นผ่าน
- หนึ่ง program mandate นี้ครอบคลุมการเลือกและทำงานถัดไปใน W00–W16 ที่ได้รับอนุญาตแล้ว ไม่ต้องขอให้ฉันสั่ง “ทำต่อ” ทุก Issue
- คำสั่งนี้ไม่อนุมัติข้าม #58, ไม่ถือว่า design/business policy ที่ยังไม่อนุมัติผ่านแล้ว, และไม่ขยาย AUTO_RELEASE ของงานเก่ามา MPW
- ไม่อนุมัติ merge/deploy/remote migration/Production changes/paid purchase/real staff messages/retention deletion แบบล่วงหน้า ให้เตรียม candidate และคำขออนุมัติที่ระบุ exact target ครบก่อน
- การ provision/host TEST ที่แตะบัญชีภายนอกหรือมีค่าใช้จ่ายต้องมี approved TEST scope/config/budget; local setup ที่ย้อนกลับได้และไม่แตะข้อมูลจริงทำเองภายใน authority

1. ตรวจของจริงก่อนเริ่ม
อ่าน AGENTS.md, README.md, docs/07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md, PROJECT_CONTROL.md, 09_ROADMAP.md, เอกสารนี้ และ latest Issue/comments/PR ที่เกี่ยวข้อง. ถ้า docs ยังไม่อยู่บน main ให้เปิด PR #193 และอ่าน head ล่าสุดเป็น proposal; ห้าม merge เองเพื่อให้เริ่มง่าย
ตรวจ canonical remote/latest main, dirty worktrees, active task/PR, Production state evidence และ existing deployments. ใช้ isolated checkout; ไม่ reset/overwrite/force-push. บันทึก main SHA, docs SHA, task head แยกกัน
ยึด approved current sources ไม่ใช้ภาพราคา/แชตเก่าแทน config. ไม่รวมโครงการ CCTV/opsLens เข้ามาใน MPW

2. รับผิดชอบ readiness เอง
ทำ W00/W01 ด้วยรายการใน 15_READINESS_AND_OWNER_ACTIONS.md: software/runtime/package tools, GitHub permissions/CI, Google file access, Cloudflare resources/billing, LINE Login/LIFF/OA bindings, TEST isolation, browser/phone/camera/network, backup/restore, accounts/recovery/domain และ budget
ตรวจ version/existence/access แบบไม่เผย secrets. ตรวจ safe read ก่อนเรียก setup scripts; อย่ารัน provisioning/deploy commands ใน setup doc เก่าโดยไม่ตรวจว่า resource เดิมมีแล้ว
หาก local tool ขาด ติดตั้ง dependency ตาม lockfile ใน isolated workspace เมื่ออนุญาตและย้อนกลับได้; ห้าม broad upgrade หรือเปลี่ยน security policy
ค้นและอ่านข้อมูลที่มีอยู่เอง ไม่ให้ Owner คัดลอกสามไฟล์หรือไล่ตรวจซอฟต์แวร์ให้. ใช้ connector/skill ที่เกี่ยวข้องตาม access ที่มี; ลิงก์เดียวกันที่อ่านไม่ได้ต้องแยก permission/network/unsupported capability
ผลทุกข้อใช้ VERIFIED / MISSING / INACCESSIBLE / UNKNOWN / NOT_REQUIRED พร้อม environment, timestamp, evidence, impact, next action. ห้ามตีความไม่เห็น tool ว่าไม่มี account หรืออ่าน repo ได้ว่า deploy ได้

3. รวมเรื่องที่ต้องให้ Owner ทำเป็นชุดเดียวต่อ gate
ทำทุกขั้นที่ทำเองได้ก่อน. เหลือเฉพาะ OAuth/2FA/consent, อนุมัติค่าใช้จ่าย, verified identity/business-policy decisions, physical phone actions, destructive action และ exact release GO จึงขอ Owner
แต่ละรายการบอกว่าขาดอะไร เหตุใดต้องเป็น Owner ตรวจอะไรไปแล้ว ต้องเปิดหน้าไหน/กดอะไร เสนอค่าใด ผลกระทบราคา/ข้อมูล/สิทธิ์ ทำอย่างไรจึงถือว่าเสร็จ และหลังจากนั้นคุณจะทำอะไรต่อ
ไม่ขอรหัสผ่าน/token/API key ในแชต; ใช้ sign-in/secret provisioning ที่ระบบรองรับ. ไม่ขอสิ่งที่มี approval แล้วซ้ำ. ไม่ตั้งคำถาม “จะทำต่อไหม” หลัง milestone ที่ผ่าน
ถ้า gap ไม่ขวางงานอื่น ให้ทำงานอิสระที่ยังอนุญาตต่อและรวบรวมคำถามไว้; security incident/ข้อมูลเสียหายที่กำลังเกิดต้องรายงานทันที ไม่รอ batch

4. ผ่าน prerequisites โดยไม่หลบ gate
ตรวจ #58 CLOSED พร้อม LEGACY_FULLY_DECOMMISSIONED evidence ก่อน V2 implementation. หากยังไม่ผ่าน ให้ทำ readiness/source mapping/design ที่อนุญาตให้ครบ ไม่หยุดที่คำว่า blocked อย่างเดียว และห้ามทำ frontend/session/API implementation รวมถึง mock app เพื่อหลบ gate
หากต้องทำ Legacy prerequisite ให้ตรวจ latest #58/#60/#71/#65/#66 และใช้ authority เดิมเฉพาะ named targets ที่ยัง valid ใน task แยก. W00 ไม่ได้รับอำนาจปิด #58 หรือทำ legacy mutation เอง. อย่าขอ approval เดิมซ้ำ แต่ unknown target/backup/observation/destructive gate ที่ยังไม่ครบต้องคงไว้
ก่อนเปลี่ยน scope/phase บันทึก control transition พร้อม evidence; การปิด gate หรือเปลี่ยนสถานะในไฟล์ไม่ใช่การอนุมัติจาก Owner
W02 รวม policy/permission/source conflicts ที่เหลือเป็น decision packet ครั้งเดียวก่อนเปิด module ที่เกี่ยวข้อง. ไม่ invent ค่าแรง/ต้นทุน/สูตร/ราคา/สต๊อก/บัญชีที่ไม่รู้

5. ทำทีละงานจนสุดขอบเขต
ใช้ latest roadmap/dependencies เป็นลำดับ: W00→W01→W02→W03 แล้ว foundation/read-only/recovery W04/W13; Team W05/W06/W07; stock W08/W09; Owner W10/W11/W12; rehearsal W14; rollout W15; retirement W16
ตารางนี้ไม่แทน dependency ของ Issue. เลือกงานพร้อมที่ไม่ชน shared schema/service; ไม่ส่งหลาย agents ทำงานชนกันหรือ spawn agents โดยไม่มี explicit instruction ที่เกี่ยวข้อง
หนึ่ง task ต่อ focused branch/PR. อ่านไฟล์ที่เกี่ยวข้อง ใช้ service เดิม ตรวจ root cause→พิสูจน์→แก้→regression→UAT/evidence. ไม่ทำเครื่องคิดเงิน/ค่าแรง/สมาชิกอีกชุดเพื่อให้เว็บง่าย
ต่อยอด canonical identity, D1, private R2, attendance evidence/ordering, payroll/expense/personal contracts. รักษา Team field allowlist และตรวจสิทธิ์ที่ server ทุกครั้ง. Web/LINE duplicate, stale edits, closed periods, network lost และ optional notification failures ต้องมี proof
Consumer ของ #163–#171/#148 ใช้ approved final contracts และ evidence ไม่แก้ซ้ำในงานเว็บ. ไม่ต้องรอ hardening ที่ไม่เกี่ยวข้องก่อน read-only work ถ้า gate อื่นผ่าน

6. ตรวจและแก้จนผ่านจริง
รัน focused tests ระหว่างแก้ แล้ว npm run check, npx wrangler deploy --dry-run และ CI ที่ repo บังคับบน exact candidate. Schema ต้องมี clean/old-shape/rerun/integrity/FK/compatibility; browser UAT ต้องเปิดหน้าจอจริงและตรวจ mobile states
แก้ test failures ที่เกิดจากงานของคุณ ไม่เพิ่ม retry/timeout เพื่อกลบ root cause ไม่ลด AC หรือใช้ Production secrets เพื่อให้ tests ผ่าน. ถ้า blocker อยู่ใน baseline แยกหลักฐานและ task โดยไม่อ้างว่างานใหม่ทำครบแล้ว
Build/CI PASS ไม่เท่ากับใช้งานได้. เตรียม TEST URL และ approved test identities, ทำ journeys ของ Owner/Team ทั้ง success/error/duplicate/recovery, full scoped reconciliation และ backup/delta-preserving rollback drill
การทดสอบ manual ที่ต้องใช้โทรศัพท์/2FA ให้เตรียมหน้าและ script ให้พร้อม แล้วขอ Owner ทำเฉพาะส่วนที่ตัวแทนระบบทำแทนไม่ได้; automated browser ไม่พิสูจน์ว่าทดสอบ iPhone จริงแล้ว

7. PR integration และ release
ถ้า dependent task ต้องใช้ code ที่ยังไม่ merged ให้เตรียม ordered merge packet ที่มี SHA/CI/review/compatibility; ทำงานอิสระต่อได้ แต่ห้ามสร้าง giant PR หรืออ้าง stacked candidate ว่าผ่าน canonical-main policy โดยไม่ review
Merge/deploy authorization ต้องเจาะจงเป้าหมาย. รวม PR หลายตัวในคำขอเดียวได้เมื่อ dependencies ชัด แต่ CI/UAT ของแต่ละ head และ integration candidate ต้องครบ. ถ้าไม่มี standing merge authority อย่า merge เอง; คำสั่งเดียวไม่ทำให้เงื่อนไขนี้หายไป
เตรียม release packet หลังทำงานครบ: exact repo/branch/SHA/build, environment/domain/resources, secret scope (ไม่ใช่ secret values), modules/users, database ordering, approved policy versions, CI/UAT evidence, private verified backup, before counts/totals, rollback/forward-fix, expected cost และ monitoring
ขอ GO เฉพาะ candidate/target นี้. เมื่อ Owner อนุมัติแล้วทำต่อจน deploy+smoke+permission+reconciliation+observation/handoff ครบ ไม่ขอให้สั่งใหม่ทุกขั้น. ถ้า candidate/target/material risk เปลี่ยน ให้ระบุ approval impact ก่อนทำต่อ
เปิดใช้เป็นรุ่น: Team pilot ไม่ต้องรอทุกการเงินเสร็จ แต่ objective ยังไม่ complete จน full scoped web replacement/retirement ผ่าน. รักษาช่องทางเดิมตามแผนจน parity ผ่าน; ห้ามเปิดสอง authoritative writers

8. เก็บ checkpoint และทำต่อโดยไม่เริ่มใหม่
ทุก milestone และก่อน pause/session end บันทึกตาม 16_EXECUTION_STATE.md: authority/gates, last completed AC, active task/PR, base/head, changed paths, evidence/skips, readiness gaps, approvals, in-flight/financial state และ exact next command/action
เก็บบน GitHub ใน authorized docs path/Issue อย่าง sanitized และอ่านกลับยืนยัน. หาก remote save ไม่ได้ ให้รักษา local artifact และรายงานว่า checkpoint ยังไม่ durable
ก่อน pause ให้ทำ safe atomic work ที่ทำได้ให้จบ. เมื่อ quota/session/environment ขาด ให้บันทึก next action; ไม่รับประกันว่าคำสั่งจะปลุกตัวเองเมื่อ quota กลับมา. ใช้ “ทำงาน MPW ต่อจาก checkpoint ล่าสุด” ได้โดยไม่ส่งประวัติทั้งโปรเจกต์ใหม่

9. Definition of done
ส่ง URL ที่เข้าถึงได้จริง, Owner/Team login instructions, approved module coverage, tested device/browser matrix, no unauthorized field access, real scoped data/config migrated and reconciled, no unexplained lost/duplicate/financial variance, policy/evidence correctness, restore/rollback evidence, operator/user guides, recurring cost observations และ known limitations
แยก NOT_STARTED / READY_FOR_TEST / UAT_PASSED / READY_FOR_RELEASE / PILOT_LIVE / FULL_WEB_OPERATIONAL / RETIREMENT_COMPLETE ตาม evidence. ไม่ใช้ “เสร็จแล้ว” หากยังมี mock data, module ที่หาย, Production gate, real-device UAT หรือ observation ที่ไม่ครบ
การสร้าง/อัปเดต Issue ไม่เท่ากับปิดงาน. ปิด Issue/Epic เฉพาะ DoD ครบและมี closeout authority; ไม่ปิดเพื่อให้ board ดูสะอาด

ChatGPT/PO-PM, Codex Developer และ AI model ของ LINE bot เป็นสามส่วนแยกกัน. การเลือกโมเดลสำหรับ Dev ไม่อนุมัติเปลี่ยน bot model
รายงานความคืบหน้าภาษาไทยสั้น ๆ ว่าได้อะไร พบอะไร และกำลังพิสูจน์อะไรต่อ. ทำงานต่อเองจนสุด allowed scope โดยให้ Owner รับเฉพาะการตัดสินใจหรือยืนยันตัวตนที่จำเป็นจริง
```

## การออกแบบคำสั่งนี้

ใช้เป้าหมายคงที่ งานย่อยที่ตรวจได้ และ checkpoint ที่อ่านต่อได้ แทนการรวมงานทั้งระบบไว้ใน patch เดียว. แนวทาง milestone→validation→repair→status ตรงกับ [OpenAI: Run long horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex). นี่เป็นแนวทางดำเนินงาน ไม่ใช่การรับประกันว่าจะจบใน session เดียวหรือข้ามข้อจำกัดบริการได้
