# กติกาแชท งาน และ Branch

## ขอบเขตรอบแรก

งาน #272: Owner อนุมัติเริ่มจัดระเบียบ 11 พ.ย. 2026; authority `DEV_OWNED`, ความเสี่ยง Low, mutation L0–L1. Acceptance: ทุกงานใหม่มี Issue/branch/PR และทะเบียน; branch เดิมมีสถานะตามหลักฐาน; ทดลองรวบรวมแผน #248; CI รายงานโดยไม่บล็อก PR เดิม. Canonical main ที่เริ่มงาน: `34475766a6af0fa15608069d464a554239a17b53`.

ไม่รวมการ merge, deploy, เปลี่ยน release authority, รวมโค้ด #248, ลบ branch, ปิด PR, prune worktree หรือแก้ branch protection. กติกาจะมีผลร่วมกันบน canonical main เมื่อ PR นี้ได้รับการอนุมัติและ merge แล้ว; แชทหรือ checkout เก่าต้องอ่านกติกาที่อัปเดตก่อนงานรอบใหม่.

## วิธีทำงานประจำ

1. เปิด Issue และกำหนดเกณฑ์เสร็จ ระบุแชทประสานงานหลักหนึ่งแชทต่อ work item.
2. อ่าน AGENTS และทะเบียน ตรวจสิทธิ์ งานค้าง และ writer ก่อนเปลี่ยน checkout. ทำ Canonical Main Gate แล้วสร้าง branch งาน.
3. เพิ่ม work item เป็น `MANAGED` และลงทะเบียน remote branch หลักเพียงหนึ่งรายการ `ACTIVE` สำหรับ Issue นั้นเมื่อ push แล้ว. บันทึก SHA ล่าสุดและ target `main`; ระหว่างเริ่มต้นที่ยังไม่ push ใช้ `MIGRATION_PENDING`.
4. พัฒนา/commit/push/ทดสอบและเปิด PR พร้อมหัวข้อ Branch lifecycle. อัปเดต snapshot SHA หลัง commit โดยรวมทะเบียนที่แก้ไว้ใน commit ถัดไปได้; snapshot ไม่ต้องตรง HEAD ของ commit ที่บรรจุทะเบียนเอง แต่ต้องระบุว่าเป็น observation ไม่ใช่ live ref.
5. จบงานตามเกณฑ์แล้วตรวจการรวมและ dependency ก่อนเปลี่ยน `INTEGRATED` เป็น `DELETE_READY`. แยก merge สำเร็จจาก deploy สำเร็จเสมอ.
6. ก่อนลบต้องตรวจสดและได้รับการอนุมัติสำหรับรายการนั้น เมื่อยืนยันลบแล้วบันทึก `DELETED`. ไม่ลบอัตโนมัติจาก workflow นี้.

branch สนับสนุนเพิ่มเติมต้องมีเหตุผลและแผนรวมกลับ ใช้ `PENDING_INTEGRATION`; ห้ามซ่อนงานกำลังพัฒนาเพิ่มด้วยสถานะนี้. หากต้องมี writer มากกว่าหนึ่งคน/agent ให้บันทึกผู้รับผิดชอบและจุด handoff โดยไม่เขียน checkout เดียวกันพร้อมกัน. การเปลี่ยนเป็น Gitflow ไม่อยู่ในรอบนี้.

## แหล่งสถานะ

`docs/branch-lifecycle.json` เป็นทะเบียนที่ตรวจและ review ผ่าน Git. คีย์รายการคือ `(scope, source, branch)` เพื่อแยก branch ชื่อเดียวกันที่อยู่คนละ clone หรืออยู่ local/remote. ไม่ใส่ absolute local path, production payload, secret หรือเนื้อหา backup ในทะเบียน; ใช้รหัสแหล่ง เช่น `issue248-handoff-clone` และอ้างหลักฐานส่วนตัวที่มีสิทธิ์เข้าถึง.

| สถานะ | ความหมาย | ลบได้หรือไม่ |
|---|---|---|
| PROTECTED | main หรือ branch ถาวรที่ห้ามลบ | ไม่ได้ |
| NEEDS_AUDIT | ยังตรวจไม่ครบหรือข้อมูลไม่พอ | ไม่ได้ |
| ACTIVE | งานปัจจุบัน / มี PR เปิด โดยต้องอ่านเหตุผลประกอบ | ไม่ได้ |
| PENDING_INTEGRATION | งานสนับสนุนที่รอนำเข้าปลายทาง | ไม่ได้ |
| INTEGRATED | รวมงานที่จำเป็นแล้ว รอหลักฐานปิดครบ | ไม่ได้ |
| DELETE_READY | หลักฐานครบที่ source และ target SHA ที่ระบุ | เป็นผู้สมัครลบ ต้องตรวจสดและอนุมัติก่อน |
| DELETED | มีการอ่านกลับยืนยันว่า ref หายแล้ว | เสร็จ; เก็บประวัติและหลักฐานกู้คืน |

CI ตรวจรูปแบบและความครบของหลักฐานได้ แต่ไม่ได้พิสูจน์ว่าคำรับรองเป็นจริง ไม่ตรวจ writer หรือระบบภายนอกแทน operator. ทะเบียนไม่มีรายการใด `DELETE_READY` ในการเริ่มใช้งานนี้.

## เงื่อนไข DELETE_READY

`readiness` ต้องผูก `source_sha` ตรงกับรายการและระบุ `target_branch`, `target_sha`, `checked_by`, `checked_at` พร้อม:

- `integration_verified` และ `integration_evidence`: นำการเปลี่ยนแปลงที่จำเป็นครบ รวม dependency. ตรวจ ancestry หรือ exact merged PR; squash/cherry-pick ต้องเทียบเนื้อหาและบันทึกเหตุผลส่วนที่เลิกใช้. Merge เข้า branch อื่นเพียงอย่างเดียวไม่ใช่หลักฐานว่าอยู่ในปลายทางที่เลือก.
- `target_pushed`: ปลายทาง SHA นี้มีบน remote และดึงกลับตรวจได้.
- `checks_passed`, `checks_evidence`: ทดสอบโค้ดชุดปลายทางจริงพร้อมผล checks ที่ระบุ SHA.
- `worktrees_clear`, `worktree_evidence`: ตรวจ clone/worktree ที่เกี่ยวข้อง ไม่มี active writer หรืองาน tracked/untracked ที่สูญหาย. Worktree อ่านไม่ได้เป็น UNKNOWN. เก็บการแก้ที่ยังไม่ commit แยกจาก source commit backup.
- `dependencies_clear`, `dependency_evidence`: ไม่มี PR เปิดทั้ง head/base, stacked branch หรืองานอื่นยังพึ่ง source. PR ที่ใช้ source เป็น head ต้องได้รับการจัดการก่อน; การ push ปลายทางไม่ปิด PR แทน.
- `external_refs_reviewed`, `external_refs_evidence`: ตรวจ workflow, release, builds และ automation ที่อ้าง branch; tag/merge ไม่ใช่หลักฐาน Production.
- `backup`: `source_sha`, `verified: true`, `reference` ของ backup ที่ตรวจอ่านคืน source commit และประวัติได้จริง. SHA อย่างเดียวไม่ใช่ backup; tag ที่ยังชี้โค้ดใน object store เดิมไม่แทนการตรวจ recovery. ข้อมูลส่วนตัวเก็บในที่ส่วนตัว.

ทุก boolean ข้างต้นต้องเป็น `true` และทุก evidence reference ต้องไม่ว่าง. หาก `protected`, `active_writer` หรือ `uncommitted_work` เป็น true จะผ่านไม่ได้. ตัว validator เป็น structural check ไม่ใช่ผู้อนุมัติ.

ก่อนลบ operator ต้องดึง live source และ target SHA, ตรวจว่า target SHA ที่ทดสอบยังอยู่ในปลายทาง, ตรวจ dependency/worktree/backup ซ้ำ. หาก SHA หรือเงื่อนไขเปลี่ยน ให้เปลี่ยนกลับ `NEEDS_AUDIT` หรือ `ACTIVE` และยกเลิกเครื่องหมายเดิม. เมื่อได้รับอนุมัติแล้ว ควรใช้การลบ ref แบบผูก expected SHA เพื่อกัน source เคลื่อนระหว่างตรวจและลบ. การลบ local กับ remote ต้องอนุมัติและตรวจแยกกัน. `DELETED` ต้องมี `deletion.verified_at`, `absence_verified: true`, `evidence`.

## ทยอยรับงานเดิม

Inventory เริ่มจาก remote heads ปัจจุบันและ local #248 ใน handoff clone หนึ่งแห่งเท่านั้น ไม่อ้างว่าครอบคลุม clone ทุกเครื่อง. Branch เดิมที่ไม่มี PR เริ่ม `NEEDS_AUDIT`; open PR เริ่ม `ACTIVE` ตามหลักฐาน PR ไม่ได้แปลว่ามีคนกำลังพิมพ์. การเป็น ancestor ของ main เพียงอย่างเดียวจะไม่ทำให้เป็น DELETE_READY อัตโนมัติ.

เริ่ม #248 เป็น `MIGRATION_PENDING`, `primary_branch: null`. ชื่อ `codex/restore-daily-sheet-sync-248` เป็นเพียงข้อเสนอ ยังไม่สร้างและไม่สั่ง writer ย้ายมาใช้. พบ handoff clone มี tracked/untracked work จึงต้องรักษา checkout เดิม. Open PR #258/#260/#271 และ branch อื่นที่ชื่อ issue248 ต้องตรวจ scope/dependency แยก ไม่รวมโค้ดเพียงเพราะชื่อคล้ายกัน. Release approvals ของ #248 ยังอิงคำสั่ง Owner ล่าสุดในงานนั้น.

ลำดับ handoff: ผู้เขียนหยุด ณ จุดบันทึกได้ → inventory + backup ทั้ง commit และงานค้าง → เลือกส่วนที่ใช้/ซ้ำ/เลิกใช้ → สร้างปลายทางตาม main gate → รวมเฉพาะส่วนจำเป็น → push และทดสอบ → review → เปลี่ยน work item เป็น MANAGED และประกาศ branch หลักในแชท → ตรวจ DELETE_READY ของต้นทางทีละตัว.

## รายงานและ rollout

```bash
node scripts/branch-lifecycle.mjs
node --test tests/branch-lifecycle.test.mjs
```

Workflow `Branch lifecycle report` ใช้ pull_request และ workflow_dispatch, token อ่าน contents เท่านั้น, ไม่มี production secrets หรือคำสั่ง mutate ref. แสดงผลใน Actions job summary และตรวจ PR head SHA/ทะเบียน/หัวข้อ PR. ไม่โพสต์ comment ไม่ติด label และไม่ลบ branch. `continue-on-error` ทำให้ไม่บล็อก PR เดิมระหว่าง rollout; registry invalid จะรายงานเป็นข้อผิดพลาดและห้ามใช้ readiness marker. PR ที่ไม่ลงทะเบียนจะเห็นคำแนะนำ. Workflow ต้อง merge เข้า main จึงจะใช้เป็นมาตรฐานร่วมกัน; ไม่แก้ required checks ในรอบนี้.

ทุก Issue/feature ควรทยอยมี work item; งานใหม่ต้องลงทะเบียนตามกติกา. งานเก่าที่ยังไม่รู้ Issue ใช้ `issues: []` แล้วตรวจเพิ่ม. Snapshot ไม่มีวันหมดอายุที่ถือว่าปลอดภัยอัตโนมัติ ต้องตรวจสดทุกครั้งก่อนการลบ. ทบทวน rollout หลังงานเดิมพร้อมแล้วจึงเสนอเปิด required checks แยก.

## Manual UAT และ rollback ของ tooling

1. รัน validator กับทะเบียนเริ่มต้น ต้องไม่มี DELETE_READY.
2. เปิด PR ที่ branch ยังไม่ลงทะเบียนหรือ SHA ต่างจาก snapshot: summary ต้องแสดงคำแนะนำโดยไม่บล็อก CI เดิม.
3. ลอง fixture readiness ที่ SHA เปลี่ยน/ไม่มี backup/มี dirty work: validator ต้องปฏิเสธ.
4. ตรวจว่า checkout ที่ทำ #248 ไม่ถูกแก้จากการติดตั้ง tooling นี้.

Rollback: revert PR ของ #272 ตามสิทธิ์ merge ปกติ หรือปิด workflow report ตามงานที่อนุมัติ. ไม่มี runtime/schema/secret เปลี่ยน ไม่มี Production rollback. เก็บทะเบียนและหลักฐานประวัติไว้หากถอน tooling ภายหลัง.
