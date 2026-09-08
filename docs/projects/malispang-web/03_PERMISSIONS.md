# Identity และ permission contract

## Compatibility decision

Owner/Team เป็นชื่อชุดหน้าจอ ไม่ใช่ role ใหม่ที่ใช้แทน roles เดิม. ใช้ canonical employee + verified identity binding และ permission engine เดิมต่อยอด; ไม่สร้างสมาชิกซ้ำจาก display name. Existing EMPLOYEE มี payroll.self.read ใน source แต่ Owner เคยจำกัด web Team จึงต้องทำ exposure decision แยก: **เว็บเริ่มปิด payroll field/menu/API projection จนมี explicit web grant; ไม่แก้ LINE role เดิมเงียบ ๆ**

Effective web access = active employee ∩ active role ∩ verified session ∩ domain capability ∩ approved web module grant ∩ resource scope ∩ allowed fields. Unknown/new module/action/field = deny. Manager/Assistant เดิมคง role/history แต่ไม่มี web grant ใหม่อัตโนมัติ; ห้ามลดหรือขยาย global grants ด้วยงาน UI

## Proposed launch matrix

R=read, W=write, Q=request, A=approve. Team scope คือสาขาตนและรายการที่ approved inventory อนุญาต. ช่อง “ปิด” คือ web launch default ไม่ใช่คำสั่งเปลี่ยนสิทธิ์ใน Production

| Resource/action | Owner web | Team web | Field constraints |
|---|---|---|---|
| Approved team stock/count/daily history | R/W/A | R/W ตามสถานะและวัน | ชื่อ/หน่วย/จำนวน/หมายเหตุ approved; ไม่มี cost/supplier price/recipe |
| Submitted stock count | R; correction with reason | R/Q แก้ไข | ไม่แก้ทับ finalized ledger |
| Attendance | R/W/A ตาม policy | self R/W/Q | own time/status; ไม่มีรูป/เวลาคนอื่น |
| Attendance corrections | A ตาม policy | self Q/R | requested time ไม่ใช่ official time |
| Calendar | R/W | R ตาม approved S-TEAM visibility | ไม่เผยเหตุผลลาหรือข้อมูลสุขภาพคนอื่น |
| Payroll/wage | R/preview/apply ตาม policy | ปิดจน approved web grant | own payroll ไม่เท่ากับ wage config ของร้าน |
| Expense | R/W/review ตาม policy | self เมื่อ existing can_submit_expense + web grant | ไม่มี branch financial totals |
| Personal use/return/month close | Owner-only | ปิด | ไม่รวม personal movements ใน P&L expense |
| Recipes/units/purchase costs | R/W versioned | ปิด | runtime payload ต้องไม่รวม secret formula |
| Production tasks | R/W | ปิดใน R1; เพิ่มเฉพาะ approved instructions | แยกคำสั่งผลิตจากสูตรเต็ม |
| Announcements | R/W/publish/archive | R เฉพาะ audience | publish เป็น business action ไม่ใช่ส่ง LINE อัตโนมัติ |
| Members/roles/identity | R/W/A | self minimum R/link request | ไม่มี infrastructure token ผ่าน Owner web |
| Export/evidence/system report | explicit capability | ปิด export; own evidence เฉพาะ policy | private signed/proxied response, sanitize diagnostics |

## Required capability design (proposed additions)

W02 กำหนด catalog versioned: stock.count.read/write/submit/correct, stock.cost.read, recipe.read/write, purchase.plan/order/receive, announcement.read/manage, report.finance.read/export, session.revoke, web.module.enable. แต่ละ capability ต้อง map role + web grant + scope + fields ใน test matrix; ไม่ให้ Owner เลือก unrestricted field names/SQL expressions ผ่าน settings

Web APIs ต้อง resolve resource จาก DB แล้วส่ง employeeId/branchId จริงเสมอ. Existing authorize helper ยอมให้ scope หายได้ในบางกรณี จึงห้ามเรียกด้วย empty resource บน resource-specific web route. List queries ต้อง filter ก่อน pagination/aggregation และ detail/evidence/export ต้องตรวจซ้ำ. Review W02/W03 ต้องพิสูจน์ deny เมื่อ resource scope ขาด

## Login and session

1. Browser LINE Login ใช้ authorization-code flow และตรวจ state/nonce/redirect allowlist; LIFF ส่ง token ให้ backend verify
2. ตรวจ issuer/audience/channel/expiry และ subject ฝั่ง server; ตรวจ LINE Login กับ Messaging API provider mapping ก่อนผูกกับ identity เดิม
3. ไม่รู้จัก subject → pending registration; ไม่ auto-link จากชื่อ/Staff ID/อีเมล
4. Approval ผูก employee เดิมแบบ atomic พร้อม uniqueness/audit; simultaneous approval ต้องไม่เกิดสอง binding
5. Session ใช้ opaque identifier ใน Secure/HttpOnly cookie; CSRF protection บนทุก mutation, strict origin/CORS allowlist; ไม่เก็บ token ใน localStorage
6. อ่าน active role/status และ session revocation ในทุก request; role change/deactivation ต้องมีผลก่อน request ถัดไปโดยไม่มี cached permission ค้าง
7. Session lifetime/re-auth policy เสนอ idle 30 นาที, absolute 12 ชั่วโมง, owner-sensitive actions ต้องยืนยันตัวตนใหม่ภายใน 5 นาที; เป็น proposed security config ต้อง review usability ก่อน rollout
8. ล็อกอินใหม่คืนหน้าที่ตั้งใจเปิดได้หลัง authorize; pending account เห็นเฉพาะสถานะ ไม่เห็นข้อมูลธุรกิจ

LINE login implementation อิง [LINE token-to-session guidance](https://developers.line.biz/en/tips/2026/08/13/send-token-to-server/) และ [using user data](https://developers.line.biz/en/docs/liff/using-user-profile/). Server authorization อิง [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

## Recovery and lifecycle

- Owner สองบัญชีที่ verify แล้วเป็นทางกู้สิทธิ์แบบมี audit หากมีจริง; ห้ามสร้าง/เดาว่าบัญชีที่สองพร้อมแล้ว
- Owner ทุกคนล็อกอินไม่ได้: ใช้ controlled identity recovery เดิมผ่าน private verified evidence + exact authorization ไม่ใช้ public self-serve “เป็น Owner” หรือ ADMIN_TOKEN ในเว็บ
- ย้ายพนักงานสาขาใช้ effective scope; historical data ไม่เผยให้สาขาใหม่เพียงเพราะเปลี่ยนสาขาวันนี้
- ข้อมูลออกจาก cache เมื่อ logout/account switch; ปิด private API caching/service worker storage และ purge drafts ที่มี PII
- New permissions/role changes แสดง before/after, audience, approver, version และ revoke affected sessions; ไม่ใช้ role level ตัวเลขแทน capability matrix

## Security acceptance

ทดสอบ unauthorized/expired/wrong-channel token, CSRF, role spoof, employee/branch ID tamper, missing scope, guessed evidence URL, export/count leak, inactive member, role revoke mid-session, shared-device account switch, simultaneous identity approval และ Owner-only actions. ทุกกรณีต้องไม่มี side effect/PII leak และมี sanitized audit ที่ใช้สืบย้อนกลับได้
