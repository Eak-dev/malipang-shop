# Owner Action Checklist — สิ่งที่เจ้าของร้านต้องทำ

อัปเดต: 23 กรกฎาคม 2026

เอกสารนี้แยกเฉพาะงานที่ต้องทำด้วยบัญชีเจ้าของระบบ งานโค้ดและเอกสารใน GitHub ให้ ChatGPT/Codex จัดการผ่าน Pull Request

## ภาพรวม

เจ้าของร้านต้องทำ 8 ชุดงาน:

1. ตั้งกฎ GitHub
2. เชื่อม Codex
3. ตรวจ Apps Script เดิม
4. ตรวจ LINE Webhook
5. ตรวจ Cloudflare และ Secrets
6. ยืนยันข้อมูลพนักงาน/ค่าแรง
7. ทำ UAT จริง
8. อนุมัติ Production

อย่าส่งค่าจริงของ Secret, Token หรือ Private Key ผ่านแชตหรือ GitHub

---

## งานที่ 1 — ตั้งกฎ GitHub `main`

เปิด Repository `Eak-dev/malipang-shop`

ไปที่:

```text
Settings
-> Rules
-> Rulesets
-> New branch ruleset
```

ตั้งชื่อ:

```text
Protect main
```

Target branch:

```text
main
```

เปิดอย่างน้อย:

- Require a pull request before merging
- Require status checks to pass
- Require conversation resolution before merging
- Block force pushes
- Restrict deletions

Status check ที่ต้องเลือกหลังมี PR และ CI รันแล้ว:

```text
test
```

สำหรับโปรเจกต์เจ้าของคนเดียว ยังไม่ต้องบังคับ approval 1 คน หาก GitHub ไม่อนุญาตให้ผู้เปิด PR อนุมัติตัวเอง

### หลักฐานที่ส่งให้ ChatGPT

- ภาพหน้า Ruleset summary
- ภาพ Required status checks

---

## งานที่ 2 — เชื่อม Codex กับ Repository

เปิด Codex แล้ว:

1. Connect GitHub
2. เลือก `Eak-dev/malipang-shop`
3. สร้าง Environment ชื่อ `MaliPang Backend V5.2`
4. Setup command ใช้:

```bash
npm ci
```

5. ตั้งคำสั่งประจำ:

```text
Read and follow AGENTS.md before changing any file. Work on a separate branch, run the required checks, and open a pull request. Never deploy production or modify secrets unless the task explicitly authorizes it.
```

ไม่ต้องใส่ Production Secrets ใน Codex สำหรับงานทั่วไป

### หลักฐานที่ส่งให้ ChatGPT

- ภาพ Repository ที่เชื่อมแล้ว
- ภาพ Environment/Setup command

---

## งานที่ 3 — Inventory Apps Script เดิม

เปิด `MaliPang_OWNER_MASTER`

ไปที่:

```text
Extensions
-> Apps Script
```

จดข้อมูล:

- Project name
- Script ID
- รายชื่อไฟล์ `.gs` และ `.html`
- วันที่แก้ไขล่าสุด

### ตรวจ Triggers

กดเมนูรูปนาฬิกา `Triggers`

จดทุกแถว:

- Function
- Event source
- Event type
- Last run
- Failure rate

### ตรวจ Deployments

ไปที่:

```text
Deploy
-> Manage deployments
```

จด:

- Deployment ID
- Type
- Web app URL
- Version
- สถานะ

### ห้ามทำในขั้นนี้

- ห้ามลบ Trigger
- ห้าม Disable Deployment
- ห้ามแก้ source
- ห้ามเปลี่ยน Web app URL

### หลักฐานที่ส่งให้ ChatGPT

- ภาพหน้า Project overview
- ภาพ Triggers ทั้งหมด
- ภาพ Manage deployments ทั้งหมด

---

## งานที่ 4 — ตรวจ LINE Developers

เปิด LINE Developers Console ของ Channel จริง

ไปที่:

```text
Messaging API
-> Webhook settings
```

ตรวจ:

- Webhook URL
- Use webhook เปิดอยู่หรือไม่
- Verify ผ่านหรือไม่

Runtime หลักควรเป็น Cloudflare Worker V5.2 เพียง URL เดียว

ตรวจ LINE OA Manager ด้วยว่า Auto-reply ที่ทำให้ตอบซ้ำถูกปิดหรือจัดการอย่างตั้งใจ

### ห้ามทำ

อย่าเปลี่ยน Webhook URL จนกว่าจะส่งภาพให้ตรวจและมี Cutover plan

### หลักฐานที่ส่งให้ ChatGPT

- ภาพ Webhook URL
- ภาพ Verify result
- ภาพ Use webhook
- ภาพ Auto-reply setting

---

## งานที่ 5 — ตรวจ Cloudflare

เปิด Cloudflare Dashboard แล้วตรวจ Worker ของระบบ

ตรวจเฉพาะชื่อและสถานะ ไม่ส่งค่าจริง:

### Bindings

- D1 database
- Queue
- DLQ
- Durable Object
- R2 bucket
- AI binding ถ้ามี

### Secrets ที่ควรมี

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_OWNER_USER_ID`
- `ADMIN_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY_BASE64`
- `GOOGLE_SPREADSHEET_ID`
- `OPENAI_API_KEY`

ส่งเพียงภาพที่แสดงชื่อ Secret และสถานะว่า encrypted/ตั้งไว้แล้ว ห้ามเปิดเผย Value

### ตรวจ Worker URL

เปิด:

```text
/health
/admin/readiness
```

`/admin/readiness` ต้องใช้ Admin Token จึงควรให้ Codex หรือผู้พัฒนารันจาก Environment ที่ปลอดภัย ไม่ส่ง Token ในแชต

### หลักฐานที่ส่งให้ ChatGPT

- ภาพ Bindings
- ภาพรายชื่อ Secret แบบไม่เห็นค่า
- ผล `/health`
- ผล readiness แบบปิดบังข้อมูลสำคัญ

---

## งานที่ 6 — ยืนยันข้อมูลพนักงานและค่าแรง

เปิด Sheet:

```text
MaliPang_OWNER_MASTER
-> HR_STAFF_CONFIG
```

ตรวจต่อพนักงานทุกคน:

- Employee ID
- Staff name
- LINE User ID
- Active
- เวลาทำงานปกติ
- ค่าแรง
- Grace minutes
- Deduct late
- Deduct early
- Can submit expense

เจ้าของร้านต้องเป็นผู้ยืนยันข้อมูลนี้ เพราะ Codex ห้ามเดากติกาค่าแรง

### วิธีส่งข้อมูลให้ตรวจ

ส่งภาพ Header และแถวพนักงาน โดยปิดบังข้อมูลที่ไม่ต้องการเปิดเผยได้ แต่ต้องเห็นค่ากติกาที่ต้องตรวจ

### ก่อน Production ต้องยืนยันเป็นข้อความ

```text
ยืนยันว่า HR_STAFF_CONFIG เป็นข้อมูลจริงของพนักงานและอนุญาตให้นำไปใช้คำนวณค่าแรง Production
```

---

## งานที่ 7 — ทำ UAT จริง

### Attendance: อย่างน้อย 50 รูป

แบ่งให้ครอบคลุม:

- iPhone และ Android
- ระยะใกล้/กลาง/ไกล
- แสงหลายช่วง
- ภาพถูกต้อง
- GPS หาย
- อยู่นอกรัศมี
- Timestamp เก่า
- รูปซ้ำ
- IN/OUT
- missing punch

เก็บผลเป็นตาราง:

| Case | Expected | Actual | Pass/Fail | Note |
|---|---|---|---|---|

### Expense

อย่างน้อย:

- ข้อความ Quick Save 10 เคส
- ข้อความแก้ก่อน Save 10 เคส
- Bank slip KBank/SCB/เป๋าตัง อย่างละหลายภาพ
- สลิปซ้ำ
- สลิปไม่สำเร็จ
- Undo
- Receipt/online order

### สิ่งที่เจ้าของตรวจทุกวันใน UAT

- LINE ตอบถูกหรือไม่
- D1 มี Event หรือไม่
- R2 มี Evidence หรือไม่
- `V52_*` มีข้อมูลหรือไม่
- `รายวัน` ลงเฉพาะรายการที่ยืนยันแล้วหรือไม่
- ค่าแรงรวมสมเหตุสมผลหรือไม่
- มีรายการซ้ำหรือหายหรือไม่

### ส่งผลให้ ChatGPT

- ตาราง Pass/Fail
- ภาพเคสที่ Fail
- Message ID หรือเวลาที่เกิดเหตุ โดยไม่ส่ง Secret

---

## งานที่ 8 — อนุมัติ Production

เมื่อผ่าน UAT ให้ตอบเป็นข้อความชัดเจน:

```text
อนุมัติ Deploy Production สำหรับ commit <SHA>
UAT ผ่านตามเอกสาร
อนุญาตเปลี่ยน RUNTIME_MODE เป็น production
อนุญาตเปิด LINE output ตามแผน
```

หากมี Migration ต้องอนุมัติแยก:

```text
อนุมัติ apply remote D1 migration <ชื่อ migration> หลัง Backup และตรวจ rollback/forward-fix plan แล้ว
```

ห้ามใช้คำกว้าง ๆ เช่น “จัดการได้เลย” สำหรับ Production change ที่เกี่ยวกับเงินหรือข้อมูลพนักงาน ต้องระบุขอบเขตให้ชัด

---

## งานประจำหลัง Production

### ทุกวัน

ใช้เวลา 5–10 นาที ตรวจ:

- Attendance คนละกี่รายการ
- Missing punch
- Expense totals
- Failed jobs
- LINE ตอบซ้ำหรือไม่

### ทุกสัปดาห์

- เทียบ Weekly Payroll กับเวลาจริง
- ตรวจ OpenAI usage
- ตรวจ Queue/DLQ
- ตรวจ Sheets reconcile
- ตรวจ R2 growth

### ทุกเดือน

- ทบทวน Staff config
- ทบทวน Wallet/category mapping
- ทบทวน Secret/permission
- ทบทวนค่าใช้บริการ Cloudflare/OpenAI
- ทบทวน retention ของรูปหลักฐาน

---

## ประโยคสั่งงานที่ใช้กับ ChatGPT

### แจ้งบั๊ก

```text
ตรวจบั๊กใน malipang-shop: <อาการ>
เกิดวันที่/เวลา: <เวลา>
ผู้ใช้/พนักงาน: <ชื่อหรือ Employee ID>
Expected: <ควรเป็นอย่างไร>
Actual: <เกิดอะไร>
ช่วยสร้าง Issue และวาง Acceptance Criteria ให้ Codex แก้ โดยยังไม่ Deploy Production
```

### ขอเพิ่มฟีเจอร์

```text
ออกแบบฟีเจอร์ <ชื่อฟีเจอร์> สำหรับ malipang-shop
เป้าหมายหน้างาน: <ผลลัพธ์>
ห้ามกระทบ: <Attendance/Payroll/Expense/Sheets>
ช่วยออกแบบทางเลือก ต้นทุน ความเสี่ยง และสร้าง Issue ให้ Codex
```

### ขอ Review PR

```text
ตรวจ PR #<เลข> ของ malipang-shop ให้ละเอียด
ตรวจ Logic, duplicate/lost event, payroll, expense, security, migration, Sheets และ rollback
ยังไม่ Merge จนกว่าจะสรุปผล
```

### ขอเตรียม Release

```text
เตรียม Release Gate สำหรับ PR #<เลข>
สรุป UAT ที่ต้องทำ Config/Migration ที่ต้องเปลี่ยน และ Rollback plan
ยังไม่ Deploy Production
```