# MaliPang repository branch cleanup — 14 พฤศจิกายน 2026

งานติดตาม [#282](https://github.com/Eak-dev/malipang-shop/issues/282). Owner อนุมัติ DEV_OWNED และการลบ remote branch ที่พิสูจน์ว่าซ้ำซ้อน/ไม่ใช้งานเมื่อ 14 พ.ย. 2026; L0–L1, ความเสี่ยง Medium จากการเปลี่ยน ref, ไม่มีอำนาจเปลี่ยน Production. Acceptance: ตรวจทุก live head และทุก issue/PR, รักษางานที่ยังไม่รวมและผู้ใช้งาน, ตรวจ backup กู้คืนจริง, ลบเฉพาะ exact-SHA readiness แล้วอ่านกลับยืนยัน. ฐาน canonical main `6ba993eedd9fd13466b1f8169075ad76fb4e2176`; checkout แยก clean และผ่าน main gate ก่อนแก้เอกสาร.

## หลักฐานและขอบเขต

- [Branch audit](repo-branch-audit-20261114.json): 133 remote heads, 145 PR ทั้งสถานะเปิด/ปิด/merged, 27 PR เปิด. ไม่รวม repo LINEOA คนละ repository.
- ตรวจ 18 Git stores, 95 worktree registrations: อ่านได้42, อ่านไม่ได้/หาย53 (ไม่ถือว่า clean). 17 dirty checkouts สำรองไฟล์พร้อม hash ตรงทั้งก่อน/หลัง/ใน archive. ไม่มีการ reset/clean/switch checkout ของผู้อื่น.
- สำรอง remote ทั้ง133refs แบบ full-history bundle; cloneคืนแยกและ fsckผ่าน, tipsตรง133/133. Source checkout และ local branches คงเดิม. Local historiesสำรองแยก18stores:กู้คืนและfsckผ่าน17stores, อีก1storeสร้างbundleไม่สำเร็จจึงเก็บต้นฉบับและไม่ลบbranchที่เกี่ยวข้อง; รายการอ่านไม่ได้หรือ verification ไม่ผ่านต้องคงไว้.
- พบ Codex automation4รายการ (ACTIVE2/PAUSED2) และ LaunchAgentที่เกี่ยวข้อง2รายการ; ไม่เปลี่ยน schedule. GitHubไม่มี actionsรัน/คิว, hooks/releases/tagsไม่มี, ไม่พบ create/delete workflow. Cloudflareบัญชีที่เชื่อม: Worker3ตัวไม่มี Builds trigger, Pages2โครงการไม่มี Git source. ไม่รับรองระบบนอกบัญชี/เครื่องที่เข้าถึงไม่ได้.
- Branchที่มี local refs/worktrees/open headหรือbase PR/ชื่อในruntimeautomation หรือยังพิสูจน์ integrationไม่ได้ คงไว้ทั้งหมด. #248ทั้งหมดคงไว้รอhandoffตามเงื่อนไขเดิม รวม damagedstoreของg6a-gate-on. ไม่ถือว่าการมีprocess/idleพิสูจน์writerquiescence.
- กลุ่ม59รายการเริ่มเป็น DELETE_READY โดยตรงจาก ancestryหรือ exact mergedPR+tree equality, ไม่มี observed dependencies. เป้าหมาย1branchยังทำไม่ได้โดยรักษา27openPRและงานไม่รวมไว้ครบ; ต้องคัดและreviewงานเหล่านั้นก่อน ไม่force-mergeเพื่อให้จำนวนเหลือ1.

## Issues

[รายงานทุก136issues](issue-status-20261114.json) แยก GitHub completed58 จาก not_planned31 และ duplicate2. Open45 ไม่ถือว่าเสร็จจาก merge หรือ checklistเพียงอย่างเดียว. #248ยังติดpostverify/acceptance; #251พึ่ง248และมีdraft252; #242รอeffective date/scopeและdraft243; #202/223มีงานimplementationเปิดอยู่; #249และแผนเว็บ175–192เป็นbacklogที่ยังไม่มีหลักฐานproductacceptance. #219และ246รายงานreleaseแล้วแต่รอcloseoutverification. Legacy58/60/65/66/71มีexternalwriter/approvalgates. ไม่เปลี่ยนสถานะissueอัตโนมัติ.

## วิธีดำเนินการและกู้คืน

รีวิวทะเบียนก่อนลบ → ตรวจ live refs/PR/worktree/automation/backupอีกครั้ง → ลบเฉพาะรายการอนุมัติแบบ `git push --atomic` และ expected-SHA leaseทุกref → ยืนยันrefหาย → บันทึก DELETEDพร้อมเวลาและหลักฐาน. ถ้าข้อใดเปลี่ยนจะตัดออกทั้งbatchก่อนดำเนินการ. ไม่มีlocalbranch/worktree deletionในรอบนี้.

กู้คืน remote: restore bundleส่วนตัว → ตรวจSHA/ประวัติ → push sourceSHA กลับชื่อเดิมตามการอนุมัติ. Backupไม่ทดแทนการตัดสินใจว่างานที่ยังไม่รวมเลิกใช้ได้. เก็บ payload/absoluteprivatepaths/credentialsนอกGit.

Productionอ่านอย่างเดียวเมื่อ2026-11-14T01:28Z: activeWorker `a205bba7-c754-4e0d-b1aa-736189650f28` traffic100%, deployล่าสุด12พ.ย.21:18Z. ไม่อ้างว่าhealthy/reconciliation/soakผ่าน; postverify run43308722311ยังfailure. การลบrefไม่เปลี่ยนWorker/D1/Sheets/LINE.

## Validation และ rollback

ตรวจ JSON/lifecycle validator, lifecycle tests, scopeเอกสารเท่านั้นและdiffcheck; รัน npmcheckและwranglerdryrunตามกติกา. ไม่รันliveintegrationหรือdeploy. RollbackเอกสารคือrevertPR; refที่ลบกู้จากverifiedbundle. Final counts และ deletion receipts อยู่ใน branchaudit ที่อัปเดตหลังปฏิบัติจริง.
