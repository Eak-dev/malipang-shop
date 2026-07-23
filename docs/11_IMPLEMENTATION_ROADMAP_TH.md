# Implementation Roadmap — MaliPang Backend V5.2

อัปเดต: 23 กรกฎาคม 2026

## เป้าหมาย

แผนนี้เรียงลำดับงานตามความเสี่ยงและความจำเป็นของร้าน โดยไม่เร่งเพิ่มฟีเจอร์ก่อนระบบหลักเสถียร

## Milestone A — Governance และ Inventory

สถานะ: กำลังดำเนินการ

- [x] เพิ่ม `AGENTS.md`
- [x] เพิ่ม Architecture และ Operating Model
- [x] เพิ่ม Release/Cutover Plan
- [x] เพิ่ม Owner Checklist
- [x] เพิ่ม Codex Task Template
- [x] เพิ่ม Issue Forms
- [x] เพิ่ม Pull Request Template
- [x] เพิ่ม CODEOWNERS
- [ ] เปิดและ Merge Governance PR
- [ ] ตั้ง Main branch ruleset
- [ ] เชื่อม Codex Environment
- [ ] Inventory Apps Script triggers/deployments
- [ ] ตรวจ LINE webhook และ Auto-reply

ผลลัพธ์: ทุกงานมี Scope, Test, UAT, Rollback และ Owner Approval ที่ตรวจสอบได้

## Milestone B — Shadow/UAT Baseline

- [ ] ยืนยัน `HR_STAFF_CONFIG`
- [ ] เก็บ Attendance real-photo baseline อย่างน้อย 50 รูป
- [ ] เก็บ Expense text baseline
- [ ] เก็บ KBank/SCB/เป๋าตัง baseline
- [ ] ทดสอบ duplicate/redelivery
- [ ] ทดสอบ missing punch และ concurrency
- [ ] ทดสอบ Queue retry/DLQ
- [ ] ทดสอบ Sheets reconcile
- [ ] สรุป Accuracy, lost event, duplicate และ failed jobs

ผลลัพธ์: มีหลักฐานเชิงตัวเลขว่าระบบพร้อมหรือยัง

## Milestone C — Production Readiness

- [ ] ปิดทุก UAT failure ที่เป็น High Risk
- [ ] ตรวจ Security และ Secret handling
- [ ] ตรวจ D1 migration history
- [ ] กำหนด R2 retention policy
- [ ] เตรียม Backup และ known-good commit
- [ ] สร้าง Production Change Issue
- [ ] Owner อนุมัติ commit และ config ที่เฉพาะเจาะจง

ผลลัพธ์: พร้อม Cutover โดยมี rollback จริง

## Milestone D — Production Cutover

- [ ] Deploy approved commit
- [ ] Readiness ผ่าน
- [ ] ตรวจ event จริงชุดแรก
- [ ] Monitor D1/R2/Queue/Sheets/LINE
- [ ] Reconcile รายวัน
- [ ] เฝ้าระวังอย่างน้อย 7 วัน

ผลลัพธ์: V5.2 เป็น runtime หลักที่เสถียร

## Milestone E — Legacy Apps Script Decommission

- [ ] Backup source Apps Script
- [ ] ยืนยันว่า LINE webhook ชี้ Worker เท่านั้น
- [ ] ปิด Trigger ที่สร้างงานซ้ำ
- [ ] เฝ้าดู 7 วันโดยยังไม่ลบ source
- [ ] Archive legacy project
- [ ] กำหนด Legacy sheets เป็น read-only history
- [ ] ลบ deployment เฉพาะหลังพ้น rollback window

ผลลัพธ์: ลดระบบซ้ำซ้อนโดยไม่สูญเสียข้อมูลหรือทางกู้คืน

## Milestone F — Feature Expansion

เริ่มหลัง Reliability Gate ผ่านเท่านั้น

ลำดับแนะนำ:

1. Receipt line-item extraction แบบเต็ม
2. Owner dashboard และ daily exception summary
3. Automated cost/usage alerts
4. Employee self-service corrections พร้อม owner approval
5. Operational reports ที่ลดงานมือ

ทุกฟีเจอร์ต้องประเมินต้นทุน OpenAI, Cloudflare, เวลาเจ้าของ และความซับซ้อนในการดูแล

## ลำดับที่แนะนำในทางปฏิบัติ

1. Merge Governance PR
2. เจ้าของตั้ง Ruleset และ Codex
3. เจ้าของส่งภาพ Apps Script/LINE/Cloudflare settings
4. สร้าง Inventory Issue
5. ปิดช่องว่าง UAT
6. สร้าง Production Readiness Issue
7. Cutover
8. Soak 7 วัน
9. ปิด Legacy
10. ค่อยเริ่มฟีเจอร์ใหม่