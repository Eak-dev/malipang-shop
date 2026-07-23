# สถานะ Legacy Apps Script — MaliPang

อัปเดต: 23 กรกฎาคม 2026

## สรุปผู้บริหาร

สถานะที่ยืนยันได้ในปัจจุบันมีดังนี้:

1. Backend V5.2 ใน repository นี้ใช้ Cloudflare Workers, D1, Queue, Durable Object, R2 และ Google Sheets Direct API เป็น runtime หลัก
2. ไม่พบไฟล์ `.gs`, `appsscript.json` หรือการเรียก Apps Script API ใน repository ปัจจุบัน
3. ระบบ Apps Script เดิมเคยทำงานจริงและมีหลักฐานบันทึกข้อมูลใน Google Sheets ถึงวันที่ 21 กรกฎาคม 2026
4. ระบบ V5.2 มีหลักฐานเขียนข้อมูลเข้าแท็บ `V52_*` ในวันที่ 22–23 กรกฎาคม 2026
5. ยังยืนยันไม่ได้ว่า Apps Script เดิมถูกปิดทุก Web App deployment, installable trigger และ time-driven trigger แล้ว

ดังนั้นสถานะที่ถูกต้องคือ:

> V5.2 ไม่ใช้ Apps Script เป็น core runtime แต่ Legacy Apps Script อาจยังติดตั้งอยู่ภายนอก repository และต้องตรวจ deployment/trigger ก่อนปิดหรือลบ

## งานที่ Legacy Apps Script เคยรับผิดชอบ

จากโครงสร้างและข้อมูลใน `MaliPang_OWNER_MASTER` ระบบเดิมทำหน้าที่อย่างน้อยดังนี้

### 1. รับและจัดเส้นทางข้อความจาก LINE OA

แท็บที่เกี่ยวข้อง:

- `Logs`
- `HR_LINE_RAW`

หน้าที่ที่พบ:

- รับข้อความและรูปจาก LINE
- บันทึก LINE User ID, Message ID และ Webhook Event ID
- แยกเส้นทางเป็นลงเวลา, ลงทะเบียนพนักงาน หรือค่าใช้จ่าย
- เก็บข้อมูลค่าใช้จ่ายแบบข้อความ

### 2. Image Router

แท็บที่เกี่ยวข้อง:

- `SYS_IMAGE_PENDING`
- `SYS_IMAGE_ROUTER_LOG`

หน้าที่ที่พบ:

- รับรูปจาก LINE
- บันทึกรูปไว้ใน Google Drive
- ป้องกันรูปซ้ำด้วย image hash
- ให้ผู้ใช้เลือกประเภทภาพ
- ส่งต่อไป Attendance, Bank Slip หรือ Purchase Receipt
- บันทึกสถานะและเวลาประมวลผล

### 3. Attendance

แท็บที่เกี่ยวข้อง:

- `HR_ATTENDANCE_RAW`
- `HR_ATTENDANCE_PAY`
- `HR_REVIEW_QUEUE`
- `HR_DAILY_PAYROLL`
- `HR_WEEKLY_PAYROLL`
- `HR_MONTHLY_PAYROLL`
- `HR_DAILY_SUMMARY`
- `HR_MONTHLY_SUMMARY`

หน้าที่ที่พบ:

- อ่านรูปนาฬิกาหรือ Timestamp + GPS ผ่าน OpenAI
- ตรวจวัน เวลา พิกัด และระยะจากร้าน
- จัดลำดับเข้างาน/ออกงาน
- ส่งรายการผิดปกติเข้าคิวตรวจ
- สร้างข้อมูลประกอบการคำนวณค่าแรง

### 4. Expense และเอกสารซื้อของ

แท็บที่เกี่ยวข้อง:

- `SYS_EXPENSE_CASES`
- `SYS_EXPENSE_ITEMS`
- `SYS_EXPENSE_EVIDENCE`
- `EXPENSE_CATEGORY_MASTER`
- `EXPENSE_WALLET_MASTER`
- `EXPENSE_ITEM_RULES`
- `EXPENSE_SYSTEM_CONFIG`
- `Config`
- `รายวัน`

หน้าที่ที่พบ:

- อ่านสลิปธนาคารและใบเสร็จซื้อของ
- แยกประเภท BANK_EXPENSE และ PURCHASE_RECEIPT
- อ่านร้านค้า วันที่ เลขอ้างอิง รายการสินค้า และยอดจ่าย
- กำหนดวิธีจ่ายและแหล่งเงิน
- ให้ผู้ใช้ยืนยันก่อน Save
- เขียนรายการที่ยืนยันแล้วลงชีทบัญชีรายวัน
- เก็บหลักฐานและข้อมูลดิบสำหรับตรวจย้อนหลัง

## หลักฐานการเปลี่ยนผ่าน

### Legacy Apps Script

พบข้อมูลในระบบเดิมวันที่ 21 กรกฎาคม 2026:

- `HR_LINE_RAW` มีข้อความภาพลงเวลา
- `SYS_IMAGE_ROUTER_LOG` มี `IMAGE_RECEIVED` และ `USER_SELECTED_ATTENDANCE`
- `HR_ATTENDANCE_RAW` มีผลตรวจ Timestamp + GPS และบันทึก Attendance

ไม่พบข้อมูลวันที่ 22–23 กรกฎาคม 2026 ในตาราง Log หลักของระบบเดิมที่ตรวจ

### Backend V5.2

พบข้อมูลใน `V52_ATTENDANCE_RAW`:

- วันที่ทำงาน 22 กรกฎาคม 2026
- วันที่ทำงาน 23 กรกฎาคม 2026
- มี R2 evidence key และผล NORMAL/REVIEW

จึงสรุปได้ว่าระบบใหม่รับงานจริงแล้ว แต่ยังไม่สามารถสรุปว่าระบบเดิมถูกถอนการติดตั้งทั้งหมด

## สิ่งที่ยังตรวจจาก repository หรือ Drive API ไม่ได้

ต้องตรวจด้วยบัญชีเจ้าของระบบในหน้า Google Apps Script และ LINE Developers:

1. Bound Apps Script project ของ `MaliPang_OWNER_MASTER` ยังมีอยู่หรือไม่
2. เมนู Triggers มี `doPost`, time-driven, onEdit หรือ installable trigger ใดเปิดอยู่
3. เมนู Deploy > Manage deployments ยังมี Web App deployment ที่ Active หรือไม่
4. LINE Developers ตั้ง Webhook URL ไปที่ Cloudflare Worker เพียง URL เดียวหรือไม่
5. LINE OA Auto-reply ถูกปิดเพื่อไม่ตอบซ้ำหรือไม่
6. มี Apps Script project อื่นที่ผูกกับ `MaliPang_HR_ATTENDANCE` หรือไฟล์เก่าหรือไม่

## นโยบายระหว่างที่ยังตรวจไม่ครบ

- ห้ามลบแท็บ Legacy
- ห้ามปิด Trigger หรือ Deployment โดยเดา
- ห้ามให้ Codex แก้ Legacy Apps Script
- ห้ามย้ายข้อมูลย้อนหลังจนกว่าจะมี Backup
- ห้ามเปิด LINE webhook สองระบบพร้อมกัน
- ใช้ D1 เป็น source of truth สำหรับ V5.2
- ใช้แท็บ `V52_*` เพื่อตรวจการทำงานของ V5.2
- เก็บแท็บ Legacy เป็น Read-only history ระหว่าง UAT

## Checklist สำหรับเจ้าของร้าน

### Google Sheets / Apps Script

1. เปิด `MaliPang_OWNER_MASTER`
2. ไปที่ `Extensions > Apps Script`
3. ถ้าเปิดโปรเจกต์ได้ ให้จดชื่อ Project และ Script ID
4. เปิดเมนู `Triggers` รูปนาฬิกา
5. จด Trigger ทุกตัว: function, event source, event type และ last run
6. เปิด `Deploy > Manage deployments`
7. จด Deployment ID, type, URL และสถานะ
8. ยังไม่กด Delete หรือ Disable จนกว่าจะตรวจ LINE webhook และ Backup

### LINE Developers

1. เปิด Channel ที่ใช้งานจริง
2. ไปที่ Messaging API
3. ตรวจ Webhook URL
4. URL ที่ควรใช้งานคือ Cloudflare Worker V5.2
5. กด Verify และบันทึกผล
6. ตรวจว่าไม่มีระบบอื่นตอบ LINE ซ้ำ

## เกณฑ์ก่อนปิด Legacy Apps Script

ปิดระบบเดิมได้เมื่อผ่านครบ:

- LINE webhook ชี้ไป Worker V5.2 เท่านั้น
- V5.2 รับ IN/OUT และ Expense ต่อเนื่องอย่างน้อย 7 วัน
- Lost event = 0
- Duplicate attendance/payroll = 0
- Google Sheets sync และ reconcile ผ่าน
- ตรวจ Trigger และ Deployment เดิมครบ
- Export/Backup Apps Script source และ Legacy sheets แล้ว
- เจ้าของร้านอนุมัติ Cutover

หลังผ่านเกณฑ์ ให้ปิด Trigger ก่อน โดยยังไม่ลบ source code และเฝ้าดูอย่างน้อย 7 วันก่อนลบ Deployment หรือ Archive ระบบเดิม
