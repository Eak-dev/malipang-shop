# Codex Task Template — MaliPang Backend

ใช้ Template นี้สำหรับทุกงานที่ให้ Codex แก้ Repository

หลักการ:

- หนึ่ง Issue ต่อหนึ่งปัญหา
- หนึ่ง Branch ต่อหนึ่ง Issue
- หนึ่ง Pull Request ต่อหนึ่ง Branch
- ห้ามรวมงานที่ไม่เกี่ยวข้อง
- ห้าม Deploy Production จาก Task ปกติ

---

## Template

```markdown
# Task

## Business goal

อธิบายผลลัพธ์หน้างานที่ร้านต้องการ ไม่ใช่เพียงบอกชื่อฟังก์ชัน

## Problem

อธิบายอาการที่เกิดขึ้นจริง

- เกิดวันที่/เวลา:
- ผู้ใช้หรือ Employee ID:
- Message ID / Trace ID ถ้ามี:
- Input:
- Expected:
- Actual:
- Error/Log:

## Scope

สิ่งที่ต้องทำ:

- [ ]
- [ ]
- [ ]

## Out of scope

สิ่งที่ห้ามรวมในงานนี้:

- [ ]
- [ ]

## Acceptance criteria

- [ ] แก้ root cause ไม่ใช่เพียงซ่อน error
- [ ] เคสที่รายงานทำงานถูกต้อง
- [ ] เคสเดิมที่เกี่ยวข้องไม่ regression
- [ ] มี automated regression test
- [ ] ไม่มี duplicate event/attendance/payroll/expense
- [ ] ไม่มี lost event
- [ ] ไม่เขียนทับสูตร Google Sheets
- [ ] ไม่ลด security หรือ validation

## Invariants to preserve

เลือกส่วนที่เกี่ยวข้อง:

### Attendance

- Official Time มาจาก Timestamp + GPS overlay เท่านั้น
- Shop clock เป็น evidence ไม่ใช่แหล่งเวลาค่าแรง
- radius และ photo age validation ต้องอยู่ครบ
- LINE redelivery ต้องไม่สร้างรายการซ้ำ
- missing punch ห้ามพร้อมจ่ายอัตโนมัติ

### Expense

- รายการที่ยังไม่ยืนยันห้ามลงบัญชี
- Undo ต้องรักษา audit trail
- Bank slip ใช้ transfer / SHOP_BANK
- duplicate reference และ image hash ต้องถูกตรวจ

### Data

- D1 เป็น source of truth
- R2 เป็น private evidence
- Sheets เป็น report
- Legacy Apps Script ห้ามแก้หรือปิดโดยงานนี้

## Technical constraints

- Node.js 22+
- TypeScript strict
- Cloudflare Workers
- ใช้ migration เมื่อ Schema เปลี่ยน
- ห้ามใส่ Secret ใน GitHub
- ห้าม Deploy Production
- ห้าม apply remote migration
- ห้ามเปลี่ยน LINE webhook

## Files likely involved

ระบุจากการตรวจเบื้องต้น หากยังไม่รู้ให้เขียนว่า Codex ต้อง inspect ก่อนแก้

- `src/...`
- `tests/...`
- `docs/...`

## Required tests

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

Targeted tests เพิ่มเติม:

```bash
# ระบุเมื่อเกี่ยวข้อง
```

## Manual UAT

1.
2.
3.

## Migration/config impact

- D1 migration: yes/no
- Cloudflare binding: yes/no
- Secret: yes/no
- Google Sheets mapping: yes/no
- LINE setting: yes/no

อธิบายรายละเอียดหากตอบ yes

## Risk level

- [ ] Low
- [ ] Medium
- [ ] High

เหตุผล:

## Rollback plan

อธิบายวิธีย้อนกลับที่ทำได้จริง

## Deliverables

- [ ] Focused code change
- [ ] Automated tests
- [ ] Documentation update
- [ ] Draft Pull Request
- [ ] Test results
- [ ] Risk and limitation summary
- [ ] Manual UAT checklist
- [ ] Rollback procedure
```

---

## Prompt สำหรับส่งให้ Codex

```text
Work on the GitHub issue provided. Read AGENTS.md and all required project documents first.

Before editing, restate the problem, acceptance criteria, likely root cause, affected files, and risk level.

Make the smallest complete change. Add regression tests. Do not make unrelated refactors. Do not deploy production, apply remote migrations, modify secrets, modify legacy Apps Script, or change the LINE webhook.

Run npm run check and npx wrangler deploy --dry-run. Open a draft pull request with root cause, before/after behaviour, test results, risks, migration/config impact, manual UAT, rollback procedure, and remaining limitations.
```

## Prompt สำหรับให้ Codex แก้ Review

```text
Address every unresolved review comment on this pull request.

Do not make unrelated changes. Preserve the accepted architecture and invariants in AGENTS.md. Add or update tests for each behavioural correction. Run all mandatory checks again and update the pull request summary with the new results.

Do not deploy production, apply remote migrations, modify secrets, change the LINE webhook, or modify legacy Apps Script.
```

## Prompt สำหรับให้ ChatGPT Review

```text
Review this pull request as the system architect for MaliPang.

Check the full diff for correctness, scope creep, security, secrets, idempotency, lost events, duplicate attendance/payroll/expense, D1 migrations, Queue/DLQ reliability, R2 privacy, Google Sheets formula safety, legacy Apps Script impact, test coverage, UAT quality, and rollback feasibility.

Classify findings by severity. Request changes for any issue that can affect money, payroll, evidence, authentication, or production data. Do not merge or deploy.
```