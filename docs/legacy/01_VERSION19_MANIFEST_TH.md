# Legacy Apps Script Version 19 — Sanitized Manifest

สถานะ: Owner ยืนยันว่า Legacy Web App ที่ใช้งานจริงในช่วง cutover preparation คือ **Version 19**

เอกสารนี้เป็น manifest แบบปิดบังข้อมูลสำคัญสำหรับ #60/#58 เท่านั้น ไม่ใช่ source backup และไม่อนุญาตให้ปิด Legacy.

## หลักฐานที่ยืนยันแล้ว

- Apps Script project: `Home Expense Mali's pang`
- Manage Deployments แสดง Active Web App Version 19
- Execution history มี `doPost` แบบ Web app
- Execution history มี `MPSYS_cleanupExpiredImages` แบบ Time-driven ราว 02:00
- project-level Triggers ของบัญชีที่ Owner เปิดดูแสดง 0 triggers ณ เวลาที่ส่งหลักฐาน จึงยังต้องยืนยัน ownership/current trigger state ใน #71

ห้ามคัดลอก Script ID, Deployment ID, Web App URL, Token, API key หรือ private key ลงเอกสาร/Issue สาธารณะ

## Source modules ที่ Owner ส่งและใช้เป็น Version-19 baseline

### `Code.gs`
หน้าที่หลัก:
- `doGet()` health-style response ของ Legacy bot
- `doPost(e)` รับ LINE webhook
- dedup webhook/message
- route text / image / postback
- quick Expense entry
- session + Save/Cancel/Undo
- compatibility กับ `Logs` และ `รายวัน`

Legacy direct sheets:
- `Config`
- `Logs`
- `รายวัน`

### `MP_EXPENSE_SETUP.gs`
หน้าที่หลัก:
- `MPSYS_setupFullSystem()` สร้าง/ตรวจ system sheets
- seed category / wallet / item rules / system config
- `MPSYS_installCleanupTrigger_()` สร้าง daily time-driven cleanup
- `MPSYS_cleanupExpiredImages()` expire pending action และทำ retention ของ Drive evidence ในระบบเดิม

System sheets ที่ source ระบุ:
- `SYS_IMAGE_PENDING`
- `SYS_EXPENSE_CASES`
- `SYS_EXPENSE_ITEMS`
- `SYS_EXPENSE_EVIDENCE`
- `SYS_IMAGE_ROUTER_LOG`
- `EXPENSE_CATEGORY_MASTER`
- `EXPENSE_WALLET_MASTER`
- `EXPENSE_ITEM_RULES`
- `EXPENSE_SYSTEM_CONFIG`

Legacy retention defaults:
- pending selection TTL: 15 นาที
- normal evidence retention: 90 วัน
- cancelled/expired/failed retention: 7 วัน

### `MPHR_TIMESTAMP_GPS_FINAL.gs`
หน้าที่หลัก:
- route รูปพนักงานเข้าสู่ Attendance เมื่อมี Timestamp/GPS signature
- อ่าน Timestamp จากภาพเป็นเวลาอ้างอิง
- GPS/radius validation
- Shop clock evidence + fallback validation
- dedup message/image/attendance key
- บันทึก Attendance raw และ LINE raw

Sheets ที่ source ระบุ:
- `HR_STAFF_CONFIG`
- `HR_ATTENDANCE_RAW`
- `HR_LINE_RAW`

## Config / Script Property names ที่พบ

บันทึกเฉพาะ **ชื่อ key** เพื่อ dependency mapping ห้ามเก็บ value:

- `SPREADSHEET_ID`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `VISION_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL_RECEIPT`
- `IMAGE_PENDING_TTL_MIN`
- `IMAGE_RETENTION_DAYS`
- `HR_STORE_LAT`
- `HR_STORE_LNG`
- `HR_ALLOWED_RADIUS_M`
- `HR_MAX_LINE_DIFF_MIN`
- `HR_REQUIRE_CLOCK_EVIDENCE`
- `HR_CLOCK_OPENAI_FALLBACK_ENABLED`
- `OPENAI_MODEL_VISION`

## Version 19 → Worker/D1/R2 mapping

| Version-19 responsibility | Current replacement | Code status | Shutdown evidence still required |
|---|---|---|---|
| `doPost` LINE ingress | Worker `/webhook/line` + Queue | Implemented | #59 runtime/webhook proof + #61 observation |
| webhook/message dedup | D1 inbound claim/idempotency + domain duplicate guards | Implemented | Lost/Duplicate = 0 observation |
| image routing | Worker router + Vision classification | Implemented | UAT/parity |
| HR Timestamp/GPS Attendance | Attendance service + Durable Object + D1 | Implemented | real IN/OUT parity |
| Attendance Drive evidence | R2 `EVIDENCE` | Implemented | runtime/R2 evidence |
| Expense text/image/postback | Expense service + LINE Flex + D1/R2 | Implemented | real Expense parity |
| Expense raw/mirror output | Direct Sheets API | Implemented while sync remains enabled | reconcile parity |
| `รายวัน` accounting write | Direct Sheets API legacy-layout writer | Implemented, Sheets still required | formulas/report parity before Sheets retirement |
| Payroll | D1 daily/weekly payroll | Implemented | Thursday–Wednesday production evidence |
| cleanup/retention | non-destructive R2 retention audit, PR #76 | Implemented, disabled by default | Production activation is separate; no R2 deletion |
| Version-19 Web App shutdown | staged shutdown #58/#65/#66 | Not authorized | all gates + Owner GO |

## Important policy difference: evidence retention

Legacy Version 19 deletes old Drive files. Worker repository invariant forbids deleting R2 evidence.

Therefore Worker replacement intentionally:
- preserves R2 objects
- inventories R2 directly including orphaned uploads
- marks old objects `RETENTION_ELIGIBLE`
- performs no destructive delete

This difference is intentional and is not a parity defect.

## External backup checklist still required for #60

Full evidence must be kept in a private location, not committed to this repository:

- [ ] Export Version-19 Apps Script source/project
- [ ] Record project owner/collaborators
- [ ] Record Active Deployment count/type/version with identifiers stored privately
- [ ] Record account-level/project-level trigger inventory
- [ ] Confirm latest `MPSYS_cleanupExpiredImages` execution and current trigger owner/state (#71)
- [ ] Export/backup Legacy Google Sheets used by Version 19
- [ ] Record rollback instructions for re-enabling Legacy execution if Stage 1 fails
- [ ] Verify backup can be opened/read

## Shutdown rule

Version 19 remains available for rollback until #59 → #60/#46 → #61 → #65 pass and Owner explicitly approves Stage 1.

Do not archive, delete, redeploy or edit Version 19 as part of this manifest work.
