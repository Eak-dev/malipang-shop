# จุดเริ่มต้นโปรเจกต์ MalisPang Shop

เอกสารนี้เป็นแผนที่เริ่มต้นสำหรับ repository `Eak-dev/malipang-shop` ทุกงาน ไม่ใช่สถานะ Production แบบสด ให้ตรวจแหล่งหลักฐานที่เกี่ยวข้องก่อนตัดสินใจ และอ่าน AGENTS.md ของ worktree ที่ใช้งานจริงเสมอ

## ภาพรวมระบบ

ระบบรับงานจาก LINE OA และ Back Office ผ่าน Cloudflare Worker โดยมี D1 เป็น operational source of truth, Google Sheets เป็นส่วนรายงานและงานปฏิบัติการ, R2 เก็บหลักฐานส่วนตัว และ Queue ช่วยประมวลผลงานเบื้องหลัง ระบบครอบคลุมค่าใช้จ่าย, การลงเวลา, กะ, Payroll, สิทธิ์ผู้ใช้, ข้อมูลภาพ และรายงานของเจ้าของ

- ภาพรวมและวิธีพัฒนา: [README](../README.md), [architecture](07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md), [roadmap](11_IMPLEMENTATION_ROADMAP_TH.md)
- LINE: [flow](05_LINE_FLEX_FLOW_TH.md); expense และบัญชี: [sheet mapping](02_SHEET_MAPPING_TH.md), [expense contract](20_V12_EXPENSE_V2_CONTRACT_TH.md)
- ความเชื่อถือได้ของการซิงก์รายจ่ายและข้อจำกัดการกู้เหตุ 15 พ.ย. 2569: [ผลตรวจและขอบเขต](SYNC_RELIABILITY_INCIDENT_20261115_TH.md)
- ต้นแบบ local เท่านั้นสำหรับ [นับ D1 และ queue ต่อ invocation](INVOCATION_BINDING_BUDGET_WIP.md); ยังไม่ได้เชื่อม Worker หรือเปิดใช้งาน
- พนักงานและ Payroll: [นโยบายค่าแรง](14_PAYROLL_POLICY_WAGE_HISTORY_AND_FIXED_OT_TH.md), [release Payroll](16_WEDNESDAY_PAYROLL_RELEASE_TH.md); สิทธิ์: [identity/access](19_V11_IDENTITY_ACCESS_TH.md)
- ปฏิบัติการและ release: [operations](04_OPERATIONS_TH.md), [release/cutover](08_RELEASE_AND_CUTOVER_PLAN_TH.md), [การทดสอบ](03_TEST_AND_CUTOVER_TH.md)
- ระบบ Legacy: [สถานะ Apps Script](06_LEGACY_APPS_SCRIPT_STATUS_TH.md), [แผนปิดตามขั้นตอน](17_LEGACY_APPS_SCRIPT_STAGED_SHUTDOWN_TH.md)
- เว็บหลังบ้าน: [Epic #175](https://github.com/Eak-dev/malipang-shop/issues/175) และงานย่อยที่เชื่อมโยง

## ดูสถานะและประวัติปัจจุบัน

- [Issues ที่เปิด](https://github.com/Eak-dev/malipang-shop/issues?q=is%3Aissue+is%3Aopen): งานค้าง ขอบเขต และการตัดสินใจ ดูวันที่และสถานะจริงของแต่ละเรื่อง
- [Pull requests ที่เปิด](https://github.com/Eak-dev/malipang-shop/pulls?q=is%3Apr+is%3Aopen): งานที่เสนอและผล review; draft หรือ merge ไม่เท่ากับ deploy
- [ประวัติ main](https://github.com/Eak-dev/malipang-shop/commits/main/): ติดตาม commit และ diff ว่าเพิ่ม แก้ หรือลบอะไร
- [GitHub Actions](https://github.com/Eak-dev/malipang-shop/actions): ผล CI และ release; เทียบ SHA กับหลักฐาน provider ทุกครั้ง
- Production/D1 และผู้ให้บริการ: สถานะที่ใช้งานจริง ณ เวลาที่ตรวจแบบอ่านอย่างเดียว ดูหลักฐานตามลำดับใน AGENTS.md อย่าใช้เอกสารหรือข้อมูลเก่าแทนสถานะสด

ตัวอย่างงานที่ยังต้องตรวจสถานะจากแหล่งจริง: [#248 Sheets Sync](https://github.com/Eak-dev/malipang-shop/issues/248), [#251 Sync Health](https://github.com/Eak-dev/malipang-shop/issues/251), [#242 Payroll Policy](https://github.com/Eak-dev/malipang-shop/issues/242), [#249 Classification](https://github.com/Eak-dev/malipang-shop/issues/249) และ [#175 Web](https://github.com/Eak-dev/malipang-shop/issues/175). รายการนี้ไม่ใช่รายการงานทั้งหมด

## กติกาอัปเดตสำหรับทุกฟีเจอร์

- ทุกงานหรือแชทใหม่ให้อ่าน `AGENTS.md` แล้วอ่านไฟล์นี้ก่อนเริ่มแก้ไข
- ทุกฟีเจอร์ใหม่ให้อัปเดตไฟล์นี้ในชุดการเปลี่ยนแปลงเดียวกัน โดยสรุปความสามารถสั้น ๆ และเชื่อมไปยังเอกสารหรือ Issue ที่เป็นหลักฐาน
- เมื่อแก้หรือลบฟีเจอร์ เปลี่ยนโครงสร้าง การตั้งค่า หรือพฤติกรรมปฏิบัติการที่มีผลต่อภาพรวม ให้ตรวจและปรับหัวข้อที่เกี่ยวข้องในชุดงานเดียวกัน บันทึกรายละเอียดใน PR/commit และเอกสารเฉพาะระบบ
- หากงานไม่มีผลต่อข้อมูลในไฟล์นี้ ให้ระบุเหตุผลในสรุปงาน ไม่สร้างข้อความที่ไม่จำเป็น สถานะ Production ต้องระบุเวลาตรวจและหลักฐานจริง หรือระบุ UNKNOWN
- กติกานี้ให้ผู้พัฒนาหรือ agent ที่ทำงานอัปเดตระหว่างทำงาน ไม่ใช่ระบบ background ที่แก้ไฟล์ได้เอง และไม่รับประกันว่าแหล่งข้อมูลภายนอกจะตรงเสมอ

## งานซิงก์รายวันแบบต่อเนื่องที่กำลังพัฒนา

[PR #291](https://github.com/Eak-dev/malipang-shop/pull/291) ภายใต้ work item [#292](https://github.com/Eak-dev/malipang-shop/issues/292) (แทน PR #289 ที่ปิดแล้ว) เตรียมตัวเขียนชีตรายวันแบบเพิ่มแถวและหลักฐานสำหรับตรวจยืนยันผลเขียนที่ตอบกลับไม่แน่ชัดของ DAILY, RAW, DETAIL และการยกเลิก หลักฐานนี้ใช้ยืนยันผลที่ตรวจพบเท่านั้น และยังไม่อนุญาตส่งซ้ำจากการไม่พบข้อมูล ตัวกู้ยังไม่เชื่อมวงจรปลดสถานะและยังต้องตรวจผลรายงาน งานค้าง ตัวเขียนอื่น และทดสอบ Production ก่อนเปิดใช้ รายละเอียดและสถานะล่าสุดอยู่ใน PR

ข้อจำกัดการ release ของ candidate นี้ (ตรวจ 17 พ.ย. 2569 ยังไม่ได้ deploy หรือรัน migration บน Production): ต้องรัน migration `0024`–`0061` ก่อน deploy Worker เพราะการเลือกงานใน batch ผสมอ่านตาราง `workbook_batch_fairness` (0051) และการแจ้งเหตุใช้ schema `0025`; migration `0048` และ `0055` รันซ้ำเองไม่ได้และพึ่ง ledger ของ D1. พฤติกรรมที่เคยเปลี่ยนโดยไม่มี flag ถูกย้ายไปอยู่หลัง flag ที่ปิดเป็นค่าเริ่มต้นแล้ว (ไม่ตั้งค่า = เหมือน main): `EXPENSE_SAVED_SYNC_NOTE_ENABLED` (ข้อความบนการ์ด LINE หลังบันทึก), `EXPENSE_FORCE_RECONCILE_HOLD_ENABLED` (force reconcile ไม่ส่งงาน `EXPENSE`), `STABLE_REDRIVE_HOLD_ENABLED` (พักงาน `FAILED`/lease หมดอายุเป็น `REVIEW` และปฏิเสธ terminal override ของ admin), `WORKBOOK_BATCH_FAIRNESS_ENABLED` (สลับคิวด้วยตาราง 0051) `SYNC_ALERT_DURABLE_ENABLED` (แจ้งเหตุ DLQ แบบ durable) และ `STABLE_SCOPED_REVIEW_ENABLED` (พักเฉพาะงานแทนทั้ง workbook และใช้ review_reason แบบเจาะจง). Redrive hold ครอบคลุมการ claim ของงานที่ส่งซ้ำจากคิวด้วย. แผน release อยู่ใน [#296](https://github.com/Eak-dev/malipang-shop/issues/296) และ [runbook](SYNC_RELEASE_RUNBOOK_TH.md); รายการ R1–R7 ของ #292 แก้แล้วในโค้ด: แจ้งเหตุ durable ต้องมี `SYNC_ALERT_DURABLE_SINCE` และลบ incident ที่ปิดแล้วตาม `SYNC_ALERT_INCIDENT_RETENTION_DAYS`, migration `0048`/`0055` รันซ้ำได้ยกเว้นการเพิ่มคอลัมน์ (มี `scripts/migration-forward-fix.mjs`), route วินิจฉัยต้องเปิด `EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED`, การอ่าน activation marker ที่ล้มชั่วคราวจะ retry. ค่าใช้จ่ายที่เขียนชีตไม่ได้ก่อนส่งคำขอจะถูกพักรอคนตรวจ ไม่ถูกยกเลิกเอง เว้นแต่ตั้ง `UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED=true` (#296 ข้อ 7). ห้าม deploy `wrangler.continuous-notice.jsonc`. หลักฐาน: เทสต์ต้นฉบับของ main ใน `tests/main-parity-*.test.mjs` และ `tests/default-off-behaviour-flags.test.mjs`. ส่วนที่ยังต่างจาก main แม้ flag ปิดและยังไม่ได้พิสูจน์ความเท่ากันทุกกรณี: การบันทึก outbox ของงานที่ถูกพักใน batch เดียวรวมเป็น D1 batch, cron อ่าน schema เพิ่มก่อนข้ามงานที่ flag อื่นปิด และ trigger แจ้งเหตุของ migration 0025 จะบันทึก incident เมื่อรัน migration แล้ว. เครื่องมืออ่านสถานะและสำรอง/ซ้อม migration ถูกถอดจาก PR #291 และเสนอใหม่ใน [#293](https://github.com/Eak-dev/malipang-shop/issues/293): workflow `prod-ops-readonly.yml` สั่งรันด้วยมือจาก `main` ผ่าน environment `production` ที่ต้องอนุมัติ, token อยู่เฉพาะ step ที่รัน wrangler, log ไม่มีตัวเลขของ Production: `scripts/prod-ops-snapshot.mjs` พิมพ์ชื่อ migration ที่ apply แล้ว/ค้าง, ชื่อตาราง, ช่วงจำนวนงานผิดปกติ (0 / 1-9 / 10+), สถานะ recovery epoch และเงื่อนไขอื่นของ `START_REVIEW` (งาน PROCESSING, journal การเขียน, recovery operation, operator, report attempts) เป็นสถานะ + ช่วงจำนวน หรือ `TABLE_ABSENT` เมื่อ migration ยังไม่สร้างตาราง และผลเทียบ Worker version กับ SHA-256 ของรหัสที่คาดไว้ (MATCH/MISMATCH/NOT_CHECKED; input เป็น hash เพราะ Actions พิมพ์ env ของทุก step ลง log) ผ่าน allowlist คอลัมน์ต่อ query; rehearsal พิมพ์เฉพาะผ่าน/ไม่ผ่านต่อขั้นและชื่อ migration และเนื่องจาก export ของ D1 บล็อกคำขออื่นระหว่างทำงาน ต้องรันในช่วงเงียบที่ระบุใน Production Change Issue และ `scripts/prod-ops-backup-rehearsal.sh` เขียน R2 เฉพาะเมื่อเลือก `write_backup`. การรันจริงต้องมี Production Change Issue แยก.

แผนขั้น 6 ของ [#296](https://github.com/Eak-dev/malipang-shop/issues/296) ให้ปิด Cutover Operator, Prewrite Review และ VIEWS Incident Recovery หลัง RELEASE ก่อนเปิด Continuous Daily และ Canary โดยคง Recovery Gate ระหว่างทดสอบ; สถานะ Production ต้องตรวจสดจากผู้ให้บริการและหลักฐาน release ในแต่ละรอบ ดู [runbook](SYNC_RELEASE_RUNBOOK_TH.md).

ขั้น 6 เตรียม workflow Canary แบบ manual ทีละ action ผ่าน production environment พร้อม SHA/version guard และ D1 readback; ผลที่ไม่แน่ชัดต้องหยุดตรวจ ไม่ retry อัตโนมัติ. Workflow เป็นช่องทางปฏิบัติการ ไม่ใช่หลักฐานว่า deploy หรือ Canary ผ่านแล้ว.

Backup rehearsal รองรับสำเนาหลัง cutover ACTIVE และปล่อย claim โดยทดสอบ synthetic claim และการเขียน projection บนสำเนาที่ restore เท่านั้น พร้อมพิสูจน์ว่า trigger ปฏิเสธเป้าหมายแท็บเดิม; สถานะ activation อื่นที่ไม่รองรับต้องหยุด ไม่ใช่หลักฐานว่า Production พร้อมใช้งาน.

ตัวตรวจ report health ยอมรับเฉพาะการที่ Google ตัดอัญประกาศชื่อแท็บ ASCII ที่กำหนด โดยสูตรรวมยังเทียบกับสูตรเป้าหมายและสูตรรายงานแต่ละเซลล์ยังต้องมี SHA-256 ตรง manifest ฉบับสมบูรณ์; ดู [runbook](SYNC_RELEASE_RUNBOOK_TH.md). การแก้โค้ดนี้ไม่ปล่อย workbook REVIEW หรือยืนยันว่า Production หายจาก incident.

การกู้ Canary สังเคราะห์ที่ติดก่อนเขียนรายวันมี operator เฉพาะรายการ พร้อมหลักฐานก่อนส่งและการตรวจผลแบบไม่ retry อัตโนมัติ; ขอบเขต เงื่อนไขและลำดับอยู่ใน [runbook incident](ISSUE296_UNWRITTEN_CANARY_RECOVERY_TH.md). การมีโค้ดหรือ config ใน main ไม่ใช่หลักฐานว่าได้รับอนุมัติหรือดำเนินการใน Production แล้ว.

ขั้นถัดไปของ #296 เตรียมปิด Canary operator และ incident recovery operator หลัง Canary ผ่าน โดยคง recovery gate จนตรวจจบและอนุมัติขั้นปล่อยคิว; การเปลี่ยน config ใน repository ไม่ใช่หลักฐานว่า Canary ผ่านหรือ Production เปลี่ยนแล้ว.

ขั้นปล่อยคิวของ #296 เตรียมปิด recovery gate หลัง Canary และขั้นปิด operator ผ่าน พร้อมคง pacing และ continuous daily; งาน Undo ที่ยังไม่เคยส่งและมีรายการเดิมอยู่ REVIEW โดยไม่มี journal หรือ row index จะถูกพัก REVIEW ก่อนถือ workbook เพื่อไม่ให้ล็อกงานอื่น และยังต้องตรวจผลรายการเดิมแยกตาม [runbook](SYNC_RELEASE_RUNBOOK_TH.md). ต้องตรวจ claim, epoch, journal, failed jobs และผลกระทบ HR/payroll สดก่อน deploy; config ใน repository ไม่ใช่หลักฐานว่าร้านกลับมาใช้งานแล้ว.

## ก่อนเริ่มและเมื่อส่งต่องาน

1. ตรวจ branch, HEAD, uncommitted work และผู้ที่กำลังเขียน worktree ก่อนแก้ไข จากนั้นทำตาม Canonical Main Gate และ task authority ใน AGENTS.md
2. อ่านเอกสารเฉพาะระบบ ตรวจ issue, PR, CI และสถานะ Production เมื่อเกี่ยวข้อง ระบุเวลาตรวจ, SHA/version และข้อมูลที่ยัง UNKNOWN
3. เมื่อมีการเปลี่ยนพฤติกรรมหรือ configuration ให้อัปเดตเอกสารที่เกี่ยวข้องใน PR เดียวกัน; บันทึกสิ่งที่เพิ่ม แก้ ลบ ผลทดสอบ และสถานะ deploy ใน PR/issue ตามสิทธิ์และกติกา repository
4. ส่งต่อด้วยสรุปสั้น: เป้าหมาย, สถานะที่มีหลักฐานพร้อมเวลา, SHA/version, งานที่เหลือ, ข้อห้าม และลิงก์หลักฐาน ห้ามเก็บ credentials, PII หรือ Production payload ใน Git
5. ลดการทำงานซ้ำโดยใช้ผลตรวจเดิมที่ตรงกับ SHA และสภาพปัจจุบัน แต่ไม่ข้ามการตรวจที่จำเป็นหรือกล่าวว่าผ่านเมื่อไม่มีหลักฐาน

หากข้อมูลขัดกัน ให้ยึดลำดับหลักฐานใน AGENTS.md และตรวจความต่างก่อนเปลี่ยน Production; สถานะ issue หรือเอกสารเป็น snapshot ไม่ใช่หลักฐานว่า deploy สำเร็จหรือระบบใช้งานได้ในขณะนั้น

## จุดทำงานหลักของ #248

เลือก `codex/restore-daily-sheet-sync-248` เป็น selected/staging primary จาก canonical main สำหรับงานกู้ Sheets Sync #248 ตาม [แผนและหลักฐาน](ISSUE248_PRIMARY_BRANCH_TH.md) และ [source dispositions](issue248-consolidation.json). ผลของ 19 branch ที่ merge แล้วได้รับผ่าน main; รอบนี้ไม่มี runtime/config หรือฟีเจอร์อื่นเพิ่ม. Work item ยังเป็น MIGRATION_PENDING เพราะงานค้างและ writer handoff ยังไม่ครบ ไม่ได้หมายความว่า branch เก่าพร้อมลบหรือ Production ผ่าน acceptance. ตรวจ base/SHA และแผนล่าสุดจาก PR/ทะเบียนก่อนทำงานต่อ.

## ตรวจ branch และ issues ทั้ง repo — 14 พ.ย. 2026

Ownerอนุมัติ audit/preserve/deleteเฉพาะremoteที่ไม่ใช้งานโดยไม่เปลี่ยนProduction ตาม [ขอบเขตและขั้นตอน](REPO_BRANCH_CLEANUP_TH.md), [branch audit](repo-branch-audit-20261114.json) และ [สถานะissues](issue-status-20261114.json). งานไม่รวม/PRเปิด/ผู้ใช้งานและ#248ที่ยังไม่ส่งมอบต้องรักษาไว้; เป้าหมาย1branchไม่ใช่อำนาจdiscardงานค้างหรือforce-merge. อ่านlivecountsและdeletionevidenceล่าสุดก่อนดำเนินการต่อ.

ผลcleanupรอบ14พ.ย.: ลบremoteเดิม76รายการและยืนยันabsenceครบ, คงbaseline57รายการเพื่อรักษางานจำเป็น. Deliverybranchชั่วคราวจะปลดหลังmerge; จำนวนสดและreceiptสุดท้ายดู [#282](https://github.com/Eak-dev/malipang-shop/issues/282). Goal1branchยังpending, ไม่มีProductionmutation.

## เคลียร์28branchที่รวมแล้ว — รอบส่งมอบ14พ.ย.2026

ตรวจเฉพาะ28integratedrefsตามOwnerสั่งในtask282 จากmain a4ca593. [ผลhandsoffรายbranch](integrated28-handoff-20261114.json):แชท#248ส่งมอบremote16refsแต่g6a-gate-onยังติดdamagedstore จึงเตรียม15refs;อีก13รายการคงไว้รอDeveloper/historicalowner/unknownstoreหรือprimaryที่ยังใช้. ไม่แก้featurecode, ไม่ลบlocalworktrees, ไม่เปลี่ยนProduction/scheduler. ตรวจexecutionล่าสุดใน#282ก่อนใช้snapshotเป็นสถานะสด.

ผลรอบส่งมอบ28branch: ลบremoteเพิ่ม15รายการแบบatomic/expectedSHAและตรวจabsenceแล้วเมื่อ2026-11-14T12:30:43.988009+00:00. อีก13รายการคงไว้พร้อมowner/หลักฐานที่ขาดในรายงาน; localworktrees/ไฟล์ค้างยังอยู่ครบ ไม่เปลี่ยนProduction. Deliverybranchชั่วคราวจะปลดหลังmergeผลส่งมอบ ดูจำนวนสด/receiptล่าสุดใน#282.

การตรวจ prefix ของ notice-close ใช้ `substr` แทน `GLOB` เพื่อรองรับขีดจำกัด pattern ใน Cloudflare D1 โดยคง guard เดิม; รายละเอียดการพิสูจน์และข้อควรระวังอยู่ใน [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md). สถานะ Production ต้องตรวจจากผู้ให้บริการ.

Canary RAW ที่มี timeout มีทางกู้แบบ positive-only เฉพาะรายการ โดยไม่ส่งข้อมูลรายงานซ้ำและไม่เปิด review ทั่วไป ดู [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md); การมีโค้ดไม่ยืนยันผล Production.

การปิด notice ตรวจผลลบ claim โดยรองรับจำนวน D1 ที่รวม trigger ปิด alert พร้อมคง guard จำนวน claim โดยตรง; รายละเอียดอยู่ใน [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md).

การจบงานค่าใช้จ่ายและ Undo รองรับจำนวน D1 ที่รวม trigger ปิด alert โดยคง unique job และ guards เดิม ดู [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md).

Canary ที่ job COMPLETED แต่ claim ยัง REVIEW จาก D1 นับ alert มี operator เฉพาะรายการพร้อม positive provider proof และ notice intent แบบไม่ retry; ดู [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md). โค้ดและเทสต์ไม่ใช่หลักฐานว่า Production กู้เสร็จ.

Canary Undo RAW ที่มี timeout มีทางกู้ positive-only เฉพาะรายการ โดยไม่ส่ง Undo ซ้ำ ดู [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md); สาเหตุ timeout เชิงลึกและ Production status ต้องตรวจสด.

การอ่านตรวจผล RAW หลัง POST ตอบรับใช้ deadline อย่างน้อย 45 วินาทีโดยไม่ retry การเขียน; รายละเอียดและข้อจำกัดอยู่ใน [incident #296](ISSUE296_DAILY_CANARY_INCIDENT_TH.md).
