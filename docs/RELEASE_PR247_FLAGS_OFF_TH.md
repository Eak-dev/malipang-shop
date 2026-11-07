# Release PR #247 — G4+G5 code-only (flags OFF, REVIEW retained)

สถานะ: เครื่องมือสำหรับ release ที่**ต้องได้รับอนุมัติ G4 และ G5 จาก Owner แยกกัน**ใน Production Change #248 เอกสารนี้ไม่ใช่คำอนุมัติ

## Workflow
`.github/workflows/production-pr247-flags-off-release.yml` (รันด้วยมือเท่านั้น)
- `expected_sha` = SHA ของ `main` ที่มี PR #247 merge แล้ว ไม่มีการกำหนด SHA ล่วงหน้า
- `confirmation` = `RELEASE PR247 4bb84a4 MIGRATION 0023 FLAGS OFF KEEP REVIEW`

## Guard (fail-closed)
1. runtime source (`src`, `migrations`, `wrangler.jsonc`, `package*.json`, `tsconfig.json`) ต้องเหมือน commit ที่ review แล้ว `4bb84a4869920f70981477de0ef69607438e2c74` และ `refs/pull/247/head` ต้องยังเป็น SHA นั้น
2. migration ที่รอลงหลัง `0022_stable_claim_diagnostics.sql` ต้องมีแค่ `0023_stable_recovery_admission.sql`
3. ใน `wrangler.jsonc` ต้อง**ไม่มี** `STABLE_RECOVERY_GATE_ENABLED`, `STABLE_SHEETS_PACING_ENABLED` และ `STABLE_SHEETS_READ_BUDGET_PER_MINUTE`
4. ก่อนเริ่ม Production ต้องมี REVIEW claim 1 อัน, ไม่มี HELD และไม่มี IN_FLIGHT

## ลำดับ
pause delivery → รอจนไม่มี lease หรือ HELD ที่ยังใช้งาน → **export D1** (ทำหลัง pause เพื่อไม่ให้เกิด `D1_ERROR: Currently processing a long-running export` กับ consumer) → checksum + restore + integrity/FK + ซ้อม 0023 บนสำเนา → apply เฉพาะ 0023 → deploy → ตรวจ `/health` และ `/admin/stable-sync/status` (claim REVIEW, recoveryGate DISABLED, sheetPacing DISABLED) → resume → **พิสูจน์ว่าไม่มีผลต่อระบบ**: COMPLETED ไม่เพิ่ม, failed_jobs OPEN ไม่เพิ่ม, REVIEW ยังเป็น 1

## Failure / rollback
- ล้มก่อน deploy: resume delivery อัตโนมัติ (Worker เดิมยังทำงาน และ 0023 เป็นแบบ additive)
- ล้มระหว่างหรือหลัง deploy: ตราบใดที่ REVIEW ยังอยู่ ใช้ `npx wrangler rollback` ได้อย่างปลอดภัย แล้วจึง resume
- workflow นี้**ไม่**เปิด gate หรือ pacing, ไม่ปลด REVIEW, ไม่ ARM epoch, ไม่แก้ B1/C1 และไม่ replay queue (เป็นงานของ G6a/G6b/G7/G8 ซึ่งต้องอนุมัติแยกทุกข้อ)
- หลัง G6b ห้าม rollback ไป Worker เวอร์ชันก่อน #247 จนกว่าจะใส่ break-glass REVIEW claim แล้ว เพราะ Worker เก่าไม่มี gate และ cron จะกู้งานทั่วไปทันที
