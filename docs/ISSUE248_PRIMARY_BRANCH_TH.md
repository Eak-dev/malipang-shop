# Branch หลักสำหรับงาน #248

ตรวจและเริ่มจาก canonical main `aa908e2362ce79d03d961186ffb1786f6c3be9c5` เมื่อ 2026-11-13T00:13:34.095759+00:00. Issue หลัก #248; งานประสาน #274. Authority `DEV_OWNED`, mutation L0–L1, ความเสี่ยง Low: เปลี่ยนเอกสารและ metadata เท่านั้น.

## เป้าหมายและเกณฑ์ผ่าน

เลือก `codex/restore-daily-sheet-sync-248` เป็น selected/staging primary สำหรับพัฒนางาน #248 ต่อ โดยรับผลโค้ดที่ผ่าน merge แล้วจาก main ไม่ merge/cherry-pick tip เก่าทั้ง 19 ซ้ำ. เกณฑ์รอบนี้คือ 19/19 มีหลักฐานผูกกับ base, diff อยู่ใน allowlist เอกสาร 4 ไฟล์, source checkouts เดิมไม่ถูกเปลี่ยน, งานค้างทุกแหล่งมี disposition และ checks ผ่านบน tree ส่งมอบ.

รอบนี้ไม่ได้เพิ่มฟีเจอร์ระบบร้าน: main มีโค้ดที่ merge แล้วของทั้ง repo อยู่ตามปกติ ส่วนการเปลี่ยนใหม่ของ PR นี้จำกัดเฉพาะการจัดงาน #248. ไม่เปลี่ยน src, migrations, wrangler, package, scripts หรือ workflows. ไม่ merge PR, deploy, แก้ Production, ปิด Issue #248, ปิด/retarget PR หรือสั่งลบ branch.

## ผลปรึกษา Claude และสิ่งที่นำมาใช้

Claude ให้ GO_WITH_CONDITIONS: ทำ provenance/inventory/ทะเบียนก่อน, รักษา MIGRATION_PENDING และไม่อ้าง writer handoff. ตัด PR #278 ออกจากรอบนี้ เพราะ diagnostic pin ที่ 1fead409 ก่อน #277 และมีประเด็น auto-run failure กับ synthetic isolation. แหล่งอื่นที่ยังไม่รวมต้องคัดและรีวิวทีละส่วน ไม่รวมเพราะชื่อ branch คล้ายกัน. ผลรีวิวไม่ใช่อำนาจ deploy หรือ deletion approval.

## ขั้นตอนที่ทำในรอบนี้

1. ตรวจ checkout แยกให้ clean, fetch canonical main, switch main และ fast-forward แล้วสร้าง branch ใหม่จาก SHA ข้างต้น.
2. ตรวจ 19 live source tips กับ exact merged PR; merge tree ตรง source tree ทั้งหมด และ merge result เป็น ancestor ของ base.
3. ตรวจการแก้ path เดิมหลังแต่ละ merge ถึง base: ทุก commit เชื่อมกับ merged PR ได้ และไม่พบ commit subject ที่เริ่ม Revert. นี่เป็นหลักฐานประวัติ/การรวม ไม่ใช่คำรับรองว่า semantics ในอดีตต้องคงทุกบรรทัด เพราะ main มีการแก้ต่อที่ตั้งใจ.
4. สำรอง Git ปัจจุบันและตรวจคืน base กับ 19 source commits พร้อม fsck; เก็บหลักฐานส่วนตัวตาม receipt ใน manifest. ไม่เก็บ backup หรือ absolute private paths ใน repo.
5. ทำ manifest ของ source และงานที่เก็บไว้/ไม่ได้นำเข้า พร้อมทะเบียน primary แบบ staging.
6. ตรวจ diff allowlist, lifecycle tests, npm run check และ Wrangler dry-run แล้วเปิด PR หลัก #248 ให้รีวิว.
7. ให้ Claude ตรวจ diff สุดท้าย; ยังไม่ย้าย writer หรือทำ DELETE_READY จากการสร้าง primary เพียงอย่างเดียว.

## หลักฐาน 19 branch ที่ได้รับผ่าน main

ตารางนี้ไม่ใช่คำสั่งลบ. รายละเอียด source/merge tree และการเปลี่ยนภายหลังอยู่ใน `issue248-consolidation.json`.

| Source branch | PR | Source SHA | Merge SHA | Disposition |
|---|---:|---|---|---|
| `codex/issue248-g7-audit-relay` | #262 | `95912e26122e` | `edd88a0e4054` | INHERITED_VIA_MAIN |
| `codex/issue248-gh-audit-writer` | #261 | `cf4fecb420da` | `59bba076783b` | INHERITED_VIA_MAIN |
| `codex/issue248-nonfinancial-release-a3` | #276 | `d22f806ac2f5` | `1fead409ea36` | RELEASE_HOLD |
| `codex/issue248-post-cas-proof` | #259 | `1414078390fc` | `c5941ea3f884` | INHERITED_VIA_MAIN |
| `codex/issue248-release-test-env-isolation` | #277 | `5af269150565` | `ebc655ba2ce1` | RELEASE_HOLD |
| `issue248/g6a-gate-on` | #253 | `7061e0222b55` | `1e2c1cc44218` | INHERITED_VIA_MAIN |
| `issue248/g6a-incident-recheck` | #254 | `c6a8af9670b6` | `8dbd630e43d6` | INHERITED_VIA_MAIN |
| `issue248/g6b-notice-readonly-diagnostic` | #255 | `c990cc9d4b08` | `acc65da73123` | INHERITED_VIA_MAIN |
| `issue248/g7-owner-receipt-writer` | #266 | `549b7b320023` | `36b3c80eaf40` | INHERITED_VIA_MAIN |
| `issue248/g7-register-audit-workflow` | #264 | `323c2d12e862` | `e68f9da59fa3` | INHERITED_VIA_MAIN |
| `issue248/g7-zero-audit-writer` | #263 | `a8b4cc50c3b2` | `81cce5eaae8c` | INHERITED_VIA_MAIN |
| `issue248/g8-gh-audit-log-fix` | #267 | `bdc3fbc48b1b` | `24be2659aa91` | INHERITED_VIA_MAIN |
| `issue248/g8-zero-e68f-review` | #265 | `9f39c5455ff2` | `b75376e11f01` | INHERITED_VIA_MAIN |
| `issue248/nonfinancial-completion-review-guard` | #271 | `2680c515b39a` | `46885c6b63e0` | RELEASE_HOLD |
| `issue248/original-notice-diagnostic-20261110` | #256 | `403dac842cbe` | `c4b4ab96e2f2` | INHERITED_VIA_MAIN |
| `issue248/supervised-notice-caller` | #257 | `5bf0515d59b9` | `c9862eb44351` | INHERITED_VIA_MAIN |
| `issue248/terminal-direct-delivery-guard` | #268 | `af696f766616` | `90a311f34c02` | INHERITED_VIA_MAIN |
| `issue248/terminal-guard-release-control` | #269 | `752283939e80` | `3f0b7c7659bb` | INHERITED_VIA_MAIN |
| `issue248/terminal-hotfix-head-repin` | #270 | `b75ca59445e5` | `34475766a6af` | INHERITED_VIA_MAIN |

## งานค้างที่ไม่ได้นำเข้า

| แหล่ง | สถานะ / เหตุผล |
|---|---|
| PR #258 / #260 | HELD_RELEASE_POLICY_REVIEW: มีการแก้ G8 workflow/config/guard; #260 มีฐานซ้อนบน #258 ต้องเทียบกับ main และรับส่งต่องานก่อน |
| PR #278 | EXCLUDED_PENDING_WRITER: diagnostic ของ code pin เก่า ไม่ใช่ส่วนที่ต้องเพิ่มเพื่อรวมโค้ด 19 ตัว |
| Handoff, PR-A, PR-B, PR-B-ready | เก็บ source commits/checkout เดิมไว้ ไม่ได้นำ draft config และไฟล์ค้างเข้ามา |
| Claude nonfinancial release checkout | ยังคงไฟล์ที่แก้ค้าง ไม่ได้อ้างว่าผู้พัฒนาส่งมอบแล้ว |
| mp248-* checkouts | เก็บไว้พร้อม SHA/จำนวน status entries; ไม่รวม test/node_modules/เอกสารค้างอัตโนมัติ |
| damaged dev-golive | UNKNOWN_DAMAGED_STORE: อ่าน Git store ไม่สมบูรณ์ ห้ามตีความว่า clean หรือพร้อมลบ |

PRESERVED/EXCLUDED หมายถึงคงต้นฉบับโดยไม่แก้ไข ไม่ใช่คำรับรองว่า backup ทุกแหล่งเป็น snapshot ล่าสุด. แต่ละแหล่งต้องสำรองใหม่และตรวจความนิ่งเมื่อมี actual handoff. ไฟล์ untracked 4 ไฟล์ที่พบเพิ่มใน independent review เคยสำรองแยกแล้ว ยังไม่ถือว่าผู้เขียนส่งมอบ. รายละเอียด local ใช้ id/SHA/count เท่านั้น เพื่อไม่เผย path และ payload.

## จุดส่งต่อก่อนเริ่ม port งานค้าง

- ผู้พัฒนาในแชท `Restore Daily Sheet Sync #248` ระบุ branch/SHA สุดท้าย, git status, ผลทดสอบ/review และรายการงานเลื่อนออกไว้ พร้อมยืนยันว่าไม่มี writer หรือ scheduled resume เขียน source ชุดนั้นอยู่
- ตรวจ source refs/worktrees และสำรองใหม่อีกครั้ง ไม่ใช้สถานะ idle ของแชทแทน writer quiescence
- จัด commit/file/hunk เป็น ใช้ / ซ้ำกับ main / เลิกใช้ / ต้องตัดสินใจ พร้อมเหตุผล
- นำเข้าเฉพาะสิ่งที่จำเป็นต่อ #248; การเปลี่ยน payroll/attendance/accounting policy ต้องได้รับ Owner decision แยก
- เปลี่ยน work item เป็น MANAGED หลัง handoff และประสาน primary แล้วจริง; การลบเก่าต้องมี DELETE_READY ตาม SHA/target/evidence และอนุมัติแยก

## สถานะ Production

หลักฐานก่อนงานนี้: release run [43308722311](https://github.com/Eak-dev/malipang-shop/actions/runs/43308722311) deploy จาก ebc655ba แล้ว โดยขั้นตรวจหลัง deploy ไม่ครบ. รอบสร้าง branch นี้ไม่ได้ตรวจ Production สด ไม่อ้าง Production healthy, backlog หมด, acceptance/soak ผ่าน หรือ #248 เสร็จ. การสร้าง branch ไม่เปลี่ยน Worker ที่ใช้งานจริง.

## การตรวจและ rollback

ใช้ lifecycle validator/test ที่มีอยู่, npm run check และ npx wrangler deploy --dry-run; ตรวจ `git diff --name-only <base>..HEAD` เทียบ allowlist. ทุกไฟล์นอก allowlist และ runtime/config ต้องไม่มี diff. ผลตรวจแนบใน PR พร้อม base/HEAD จริง ไม่สร้างค่า PASS ใน manifest ก่อนรัน.

Rollback รอบนี้คือ revert metadata PR ตามอำนาจ merge ปกติ หรือหยุดใช้ staging primary โดยเก็บ source/backups ไว้ ไม่มี schema/runtime/Production rollback. Old branches และ worktree ต้องยังอยู่จนกว่าจะมีการอนุมัติการลบแยก.
