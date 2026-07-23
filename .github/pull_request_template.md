## Problem / เป้าหมาย

อธิบายปัญหาที่แก้และผลลัพธ์หน้างานที่ต้องการ

## Root cause หรือ Design rationale

อธิบายสาเหตุจริงก่อนแก้ หรือเหตุผลของการออกแบบ

## Scope

### เปลี่ยน

- 

### ไม่รวมใน PR นี้

- 

## Files changed

- 

## Behaviour before / after

### Before


### After


## ผลกระทบต่อระบบ

เลือกและอธิบายทุกส่วนที่เกี่ยวข้อง

- [ ] LINE webhook / Reply
- [ ] Attendance / IN-OUT sequencing
- [ ] Payroll / ยอดเงิน
- [ ] Expense / Bank slip / Receipt
- [ ] D1 / Migration
- [ ] Queue / DLQ / Retry
- [ ] R2 evidence / Retention
- [ ] Google Sheets mapping / formulas
- [ ] Authentication / Admin / Secrets
- [ ] Legacy Apps Script
- [ ] Documentation / Tooling only

รายละเอียดผลกระทบ:

## Invariants ที่ต้องรักษา

- [ ] ไม่มี lost event
- [ ] ไม่มี duplicate attendance/payroll/finalized expense
- [ ] D1 ยังเป็น source of truth
- [ ] รายการ Expense ที่ยังไม่ยืนยันไม่ลงบัญชี
- [ ] Google Sheets formula columns ไม่ถูกเขียนทับ
- [ ] R2 evidence ยังเป็น private
- [ ] LINE signature และ Admin authorization ไม่ถูกลดความเข้มงวด
- [ ] ไม่แก้หรือปิด Legacy Apps Script โดยไม่มีงานและการอนุมัติเฉพาะ

## Tests executed

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

ผลลัพธ์:

Targeted tests เพิ่มเติม:

## Manual UAT

1. 
2. 
3. 

ผล UAT หรือหลักฐาน:

## Migration / Config / Secret impact

- D1 migration: yes/no
- Remote migration required: yes/no
- Cloudflare binding/config: yes/no
- Secret change: yes/no
- Google Sheets change: yes/no
- LINE setting/webhook: yes/no
- Apps Script trigger/deployment: yes/no

รายละเอียด:

## Security / Data / Business risk

Risk level:

- [ ] Low
- [ ] Medium
- [ ] High

ความเสี่ยงและวิธีควบคุม:

## Rollback plan

ระบุวิธีย้อนกลับ, previous known-good commit, feature flag หรือ reconcile plan

## Remaining limitations

- 

## Checklist ก่อน Review

- [ ] อ่านและทำตาม `AGENTS.md`
- [ ] แก้เฉพาะ Scope ของ Issue
- [ ] มี regression test เมื่อ behaviour เปลี่ยน
- [ ] `npm run check` ผ่าน
- [ ] `npx wrangler deploy --dry-run` ผ่าน
- [ ] ไม่ใส่ Secret, Token, Private Key หรือรูปจริงลง GitHub
- [ ] ไม่มีการ Deploy Production จาก PR นี้
- [ ] ไม่มีการ apply remote migration โดยไม่ได้รับอนุมัติแยก
- [ ] Documentation อัปเดตเมื่อ behaviour/config เปลี่ยน
- [ ] มี Manual UAT และ Rollback ที่ทำตามได้จริง

## Production approval

> การ Merge PR นี้ไม่ถือเป็นการอนุมัติ Deploy Production

หากต้องขึ้น Production ให้สร้าง Production Change Issue และระบุ:

- Approved commit SHA
- UAT evidence
- Backup
- Exact config/migration changes
- Rollback trigger
- Monitoring window
- Owner approval