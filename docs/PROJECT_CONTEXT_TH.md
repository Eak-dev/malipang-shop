# จุดเริ่มต้นโปรเจกต์ MalisPang Shop

เอกสารนี้เป็นแผนที่เริ่มต้นสำหรับ repository `Eak-dev/malipang-shop` ทุกงาน ไม่ใช่สถานะ Production แบบสด ให้ตรวจแหล่งหลักฐานที่เกี่ยวข้องก่อนตัดสินใจ และอ่าน AGENTS.md ของ worktree ที่ใช้งานจริงเสมอ

## ภาพรวมระบบ

ระบบรับงานจาก LINE OA และ Back Office ผ่าน Cloudflare Worker โดยมี D1 เป็น operational source of truth, Google Sheets เป็นส่วนรายงานและงานปฏิบัติการ, R2 เก็บหลักฐานส่วนตัว และ Queue ช่วยประมวลผลงานเบื้องหลัง ระบบครอบคลุมค่าใช้จ่าย, การลงเวลา, กะ, Payroll, สิทธิ์ผู้ใช้, ข้อมูลภาพ และรายงานของเจ้าของ

- ภาพรวมและวิธีพัฒนา: [README](../README.md), [architecture](07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md), [roadmap](11_IMPLEMENTATION_ROADMAP_TH.md)
- LINE: [flow](05_LINE_FLEX_FLOW_TH.md); expense และบัญชี: [sheet mapping](02_SHEET_MAPPING_TH.md), [expense contract](20_V12_EXPENSE_V2_CONTRACT_TH.md)
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

## ก่อนเริ่มและเมื่อส่งต่องาน

1. ตรวจ branch, HEAD, uncommitted work และผู้ที่กำลังเขียน worktree ก่อนแก้ไข จากนั้นทำตาม Canonical Main Gate และ task authority ใน AGENTS.md
2. อ่านเอกสารเฉพาะระบบ ตรวจ issue, PR, CI และสถานะ Production เมื่อเกี่ยวข้อง ระบุเวลาตรวจ, SHA/version และข้อมูลที่ยัง UNKNOWN
3. เมื่อมีการเปลี่ยนพฤติกรรมหรือ configuration ให้อัปเดตเอกสารที่เกี่ยวข้องใน PR เดียวกัน; บันทึกสิ่งที่เพิ่ม แก้ ลบ ผลทดสอบ และสถานะ deploy ใน PR/issue ตามสิทธิ์และกติกา repository
4. ส่งต่อด้วยสรุปสั้น: เป้าหมาย, สถานะที่มีหลักฐานพร้อมเวลา, SHA/version, งานที่เหลือ, ข้อห้าม และลิงก์หลักฐาน ห้ามเก็บ credentials, PII หรือ Production payload ใน Git
5. ลดการทำงานซ้ำโดยใช้ผลตรวจเดิมที่ตรงกับ SHA และสภาพปัจจุบัน แต่ไม่ข้ามการตรวจที่จำเป็นหรือกล่าวว่าผ่านเมื่อไม่มีหลักฐาน

หากข้อมูลขัดกัน ให้ยึดลำดับหลักฐานใน AGENTS.md และตรวจความต่างก่อนเปลี่ยน Production; สถานะ issue หรือเอกสารเป็น snapshot ไม่ใช่หลักฐานว่า deploy สำเร็จหรือระบบใช้งานได้ในขณะนั้น
