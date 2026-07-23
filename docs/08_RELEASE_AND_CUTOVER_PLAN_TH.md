# Release, UAT และ Cutover Plan — MaliPang Backend V5.2

อัปเดต: 23 กรกฎาคม 2026

## 1. เป้าหมาย

เอกสารนี้กำหนดวิธีนำการเปลี่ยนแปลงจาก GitHub ไปใช้งานจริง โดยลดความเสี่ยงต่อ:

- เวลาเข้า–ออกงาน
- ค่าแรงพนักงาน
- ค่าใช้จ่ายร้าน
- หลักฐานรูปภาพ
- Google Sheets
- LINE OA
- ระบบ Apps Script เดิม

หลักการคือ **แยก Merge ออกจาก Deploy และแยก Deploy ออกจาก Production Approval**

## 2. สถานะระบบ

Environment ที่ใช้:

1. `local/test` — สำหรับพัฒนาและ automated test
2. `shadow/UAT` — เชื่อมบริการจริง แต่จำกัดผู้ใช้และตรวจเทียบข้อมูล
3. `production` — ใช้งานจริงเต็มรูปแบบ

การ Merge เข้า `main` ไม่ได้หมายความว่าอนุญาตให้ Deploy Production โดยอัตโนมัติ

## 3. Release Flow มาตรฐาน

```text
Owner problem
-> GitHub Issue
-> ChatGPT ออกแบบ Acceptance Criteria
-> Codex สร้าง Branch และแก้โค้ด
-> Automated tests
-> Draft Pull Request
-> ChatGPT review
-> Codex แก้ review
-> Owner อนุมัติ Merge
-> Merge main
-> Shadow/UAT deploy
-> Manual UAT
-> Owner อนุมัติ Production
-> Production deploy
-> Monitor และ reconcile
```

## 4. Phase 0 — Inventory และ Baseline

ต้องทำก่อนเปลี่ยน Runtime หรือปิด Legacy system

### Checklist

- [ ] ตรวจ LINE Developers Webhook URL
- [ ] ตรวจ Apps Script Triggers
- [ ] ตรวจ Apps Script Manage deployments
- [ ] จด Script ID และ Deployment ID
- [ ] Backup source Apps Script
- [ ] Export/Backup แท็บ Legacy สำคัญ
- [ ] ตรวจ Cloudflare bindings และ Secrets ว่าครบ โดยไม่เปิดเผยค่า
- [ ] ตรวจ `HR_STAFF_CONFIG`
- [ ] บันทึก baseline จำนวน failed jobs, duplicate และ missing punch

### ผลลัพธ์ที่ต้องได้

เอกสารชัดเจนว่า:

- Runtime ใดรับ LINE webhook จริง
- Legacy trigger ใดยังทำงาน
- ข้อมูลใดอยู่ D1
- ข้อมูลใดอยู่ Sheets
- รูปหลักฐานเก็บที่ใด

## 5. Phase 1 — Repository Guardrails

### ต้องมี

- [ ] `AGENTS.md`
- [ ] Architecture document
- [ ] Legacy Apps Script status
- [ ] Codex task template
- [ ] Pull Request template
- [ ] GitHub Actions CI
- [ ] Main branch ruleset
- [ ] CODEOWNERS หรือ owner review rule

### Gate

ห้ามเริ่ม feature ใหญ่ถ้า:

- CI ไม่ทำงาน
- Codex ยัง Push `main` ได้โดยไม่มี PR
- ไม่มี rollback plan template

## 6. Phase 2 — Shadow/UAT Stabilization

### Attendance UAT

ทดสอบอย่างน้อย 50 รูปจริง ครอบคลุม:

- iPhone
- Android
- ระยะใกล้/กลาง/ไกล
- แสงเช้า/กลางวัน/เย็น
- Overlay ตำแหน่งต่างกัน
- GPS ครบ
- GPS หาย
- อยู่นอกรัศมี
- Timestamp เกินกำหนด
- รูปส่งซ้ำ
- IN/OUT พร้อมกัน
- missing punch

### Expense UAT

ทดสอบ:

- ข้อความ Quick Save
- รายการที่ต้อง WAITING_CONFIRM
- เปลี่ยนวันที่
- เปลี่ยนหมวด
- เปลี่ยน Wallet
- Undo
- KBank
- SCB
- เป๋าตัง/G-Wallet
- สลิปซ้ำ
- สลิปไม่สำเร็จ
- ยอดคำนวณไม่ตรง
- Receipt ที่ยังต้อง review

### Sheets UAT

ตรวจ:

- D1 เทียบ `V52_ATTENDANCE_RAW`
- D1 เทียบ `V52_DAILY_PAYROLL`
- D1 เทียบ `V52_WEEKLY_PAYROLL`
- D1 เทียบ `V52_EXPENSE_RAW`
- ค่าใช้จ่ายที่ยืนยันแล้วเทียบ `รายวัน`
- สูตรที่ห้ามแตะยังอยู่ครบ
- Undo ล้างเฉพาะช่องที่ Backend เขียน
- reconcile ไม่สร้างรายการซ้ำ

### Gate ก่อน Production

- [ ] Attendance accuracy ≥ 99%
- [ ] Lost event = 0
- [ ] Duplicate attendance = 0
- [ ] Duplicate payroll = 0
- [ ] Duplicate finalized expense = 0
- [ ] Failed job ที่ยังไม่จัดการ = 0
- [ ] Readiness ผ่าน
- [ ] Reconcile ผ่าน
- [ ] Staff/payroll config เป็นข้อมูลจริง
- [ ] Owner ลงชื่ออนุมัติ

## 7. Phase 3 — Production Cutover

### ก่อนเปลี่ยน

- [ ] ระบุ commit SHA ที่จะ Deploy
- [ ] บันทึก config ปัจจุบัน
- [ ] Backup D1 ตามวิธีที่รองรับ
- [ ] ตรวจ migrations และ rollback/forward-fix
- [ ] ตรวจ Webhook URL ปลายทาง
- [ ] เตรียมข้อความแจ้งพนักงานหากระบบมีปัญหา
- [ ] ระบุผู้ตัดสินใจ rollback

### ลำดับ Cutover

1. Deploy commit ที่อนุมัติในโหมดที่ปลอดภัย
2. ตรวจ `/health`
3. ตรวจ `/admin/readiness`
4. ส่ง test event จากบัญชีที่อนุญาต
5. ตรวจ D1
6. ตรวจ R2
7. ตรวจ Google Sheets
8. ตรวจ LINE reply
9. เปลี่ยน Production flags ตามแผน
10. ตรวจเหตุการณ์จริงชุดแรกทันที

### ห้ามทำพร้อมกัน

- เปลี่ยน Payroll rule
- เปลี่ยน Attendance rule
- เปลี่ยน LINE Webhook
- Apply D1 migration ใหญ่
- ปิด Apps Script

ควรแยกเป็นคนละ release เพื่อให้หา root cause และ rollback ได้

## 8. Phase 4 — Production Soak

ช่วงเฝ้าระวังหลังเปิดจริงอย่างน้อย 7 วัน

ตรวจทุกวัน:

- LINE event count
- Attendance count ต่อพนักงาน
- Missing punch
- Duplicate key
- Payroll totals
- Expense totals
- Sheets sync failures
- Queue/DLQ
- OpenAI usage
- R2 evidence

หากพบความผิดปกติ ให้หยุดเพิ่ม feature และแก้ reliability ก่อน

## 9. Phase 5 — Legacy Apps Script Decommission

ทำหลัง V5.2 Production เสถียรเท่านั้น

### เงื่อนไข

- V5.2 ทำงานต่อเนื่องอย่างน้อย 7 วัน
- Lost event = 0
- Duplicate = 0
- LINE Webhook ชี้ Worker เท่านั้น
- Backup source Apps Script แล้ว
- จด Trigger/Deployment ครบ
- Owner อนุมัติ

### ลำดับปิด

1. ปิด Trigger ที่สร้างงานซ้ำก่อน
2. ยังไม่ลบ source
3. เฝ้าดูอย่างน้อย 7 วัน
4. ถ้าไม่มี dependency ให้ Archive project
5. คง Legacy sheets เป็น read-only history ตามระยะเวลาที่กำหนด
6. ลบ Deployment เฉพาะเมื่อมั่นใจว่า rollback ไม่ต้องใช้แล้ว

## 10. Risk Classification และ Approval

| ระดับ | ตัวอย่าง | UAT | Owner Approval |
|---|---|---|---|
| Low | เอกสาร, test, copy | CI | ก่อน Merge |
| Medium | parser, Flex, mapping | CI + targeted UAT | ก่อน Deploy |
| High | payroll, sequencing, auth, migration, webhook | Full UAT + rollback drill | ก่อน Merge และก่อน Production |

## 11. Rollback Strategy

### Level 1 — Feature Flag

ใช้เมื่อโค้ดทำงานแต่ฟีเจอร์หนึ่งมีปัญหา

ตัวอย่าง:

- ปิด Expense
- จำกัดผู้ใช้ UAT
- ปิด LINE output เฉพาะ flow

### Level 2 — Deploy Previous Commit

ใช้เมื่อ runtime regression ชัดเจนและ migration ยัง backward compatible

ต้องจด previous known-good commit SHA เสมอ

### Level 3 — Data Reconcile

ใช้เมื่อ D1 ถูกต้องแต่ Sheets ผิดหรือขาด

- ปิดการเขียนที่เป็นปัญหาชั่วคราว
- แก้ code/config
- ใช้ reconcile จาก D1

### Level 4 — Incident Mode

ใช้เมื่อเสี่ยงต่อเงินหรือค่าแรง

- หยุด finalize ธุรกรรมใหม่
- แจ้งเจ้าของ
- รักษาหลักฐาน
- ตรวจ D1, R2, Queue และ Sheets
- ห้ามแก้ข้อมูลมือโดยไม่มีบันทึก

## 12. Incident Severity

### SEV-1

- ค่าแรงซ้ำหรือผิดหลายคน
- ข้อมูลธุรกรรมสูญหาย
- Secret รั่ว
- Authentication bypass
- LINE event จำนวนมากหาย

การตอบสนอง: ปิด flow ที่เสี่ยงทันทีและเข้า Incident Mode

### SEV-2

- Sheets sync ค้าง
- Vision accuracy ลดลงชัดเจน
- Expense บางประเภทบันทึกไม่ได้

การตอบสนอง: จำกัด flow, retry/reconcile และแก้ภายใน release ถัดไป

### SEV-3

- ข้อความ UI ผิด
- รายงานหรือเอกสารไม่ชัด
- ปัญหาที่มี workaround และไม่กระทบข้อมูล

## 13. Pull Request Release Checklist

ทุก PR ต้องตอบ:

- ปัญหาคืออะไร
- Root cause หรือ design rationale คืออะไร
- เปลี่ยนไฟล์ใด
- ก่อน/หลังต่างกันอย่างไร
- กระทบ Attendance/Payroll/Expense/Sheets หรือไม่
- Test อะไรผ่าน
- ต้องเปลี่ยน Config/Secret/Migration หรือไม่
- Manual UAT ทำอย่างไร
- Rollback ทำอย่างไร
- มีข้อจำกัดอะไรเหลือ

## 14. Production Approval Record

ก่อน Deploy Production ให้บันทึกใน Issue หรือ PR:

```text
Approved commit:
Approved by:
Approval date/time:
UAT evidence:
Migration required: yes/no
Config changes:
Rollback commit:
Monitoring window:
```

ห้ามใช้ข้อความว่า “น่าจะโอเค” เป็น Production approval