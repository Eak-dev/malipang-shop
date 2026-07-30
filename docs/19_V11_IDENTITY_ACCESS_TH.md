# V1.1 Identity & Access Foundation

สถานะ: ใช้กับ Worker V5.2 โดย D1 เป็นแหล่งข้อมูลสิทธิ์เชิงธุรกิจ (business authorization) เพียงแห่งเดียว ส่วน Google Sheets `HR_STAFF_CONFIG` เป็นช่องทางนำเข้าข้อมูลพนักงาน ไม่ใช่แหล่งสิทธิ์หลัก

## โครงสร้างองค์กร

| ระดับ | ID | ชื่อ | สถานะ |
|---|---|---|---|
| Organization | MaliPang | MaliPang | ACTIVE |
| Branch | B001 | Yingcharoen | ACTIVE |

ตาราง `employees` ยังคงเป็นตัวตนหลักของพนักงานเพื่อรักษา Attendance, Payroll, ค่าแรง และกะเดิมไว้ครบถ้วน V1.1 เพิ่มตาราง `branches`, `staff_roles`, `line_identity_bindings`, `identity_link_requests`, `access_audit_log` และ `employee_change_requests` แบบ additive เท่านั้น ส่วน Issue #100 เพิ่ม `staff_identity_aliases` เพื่อ resolve literal ของรหัสเก่าในหลักฐาน immutable โดยไม่ทำให้ alias กลับมาเป็น Staff ID ใช้งานได้

## บทบาทและขอบเขต

| Role | Scope | สิทธิ์หลัก | ข้อห้ามสำคัญ |
|---|---|---|---|
| OWNER | ทุกสาขา | จัดการพนักงาน/บทบาท, ค่าแรง, Payroll preview/apply, อนุมัติ LINE identity | ไม่มีสิทธิ์ infrastructure ผ่าน business RBAC |
| BRANCH_MANAGER | สาขาตนเอง | อ่าน/ตรวจ Attendance, จัดกะ, อ่าน Payroll, งาน Expense ของสาขา | เปลี่ยนค่าแรง, Payroll Apply, แต่งตั้ง Owner, ข้ามสาขา |
| ASSISTANT_MANAGER | สาขาตนเอง | อ่านงานปฏิบัติการ Attendance/Shift/Expense | ค่าแรง, Payroll Apply, เปลี่ยน role/manager, ข้ามสาขา |
| EMPLOYEE | ตัวเอง/สาขาตนเอง | ลงเวลา, อ่าน Attendance/Payroll/Shift ของตน, Expense เมื่อ `can_submit_expense=1`, ส่งคำขอแก้ไข | แก้ Payroll/Attendance ที่สรุปแล้วโดยตรง, อ่านข้อมูลผู้อื่น, เปลี่ยน role/branch/identity |

Staff ID เป็นเพียงรหัสอ่านง่าย ห้ามตัดสินสิทธิ์จาก prefix เช่น `OWN001` หรือ `EMP001` เด็ดขาด ระบบใช้ `staff_roles.role` + `scope` + `branch_id` เท่านั้น

V1.1 บังคับหนึ่ง role ที่ active ต่อพนักงาน, Manager active ได้หนึ่งคนต่อสาขา และ Assistant Manager active ได้ไม่เกินหนึ่งคนต่อสาขา ผู้ที่ inactive จะไม่เป็น operational actor แม้ LINE binding จะยังเก็บไว้เพื่อรักษาประวัติ

## Permission matrix

| Action | OWNER | Branch manager | Assistant | Employee |
|---|---:|---:|---:|---:|
| ลงเวลา/อ่านของตน | ✓ | ✓ | ✓ | ✓ |
| อ่าน Attendance/Payroll ของสาขา | ✓ ทุกสาขา | ✓ สาขาตน | Attendance ✓ / Payroll ไม่ใช่ branch view | ✗ |
| แก้ Attendance สาขา | ✓ | ✓ สาขาตน | ✗ | ส่ง request เท่านั้น |
| จัดกะสาขา | ✓ | ✓ สาขาตน | อ่าน | อ่านตน |
| ค่าแรง / Payroll Apply | ✓ | ✗ | ✗ | ✗ |
| Expense | ✓ | ✓ สาขาตน | ✓ สาขาตน | ส่งของตนเมื่ออนุญาต |
| แต่งตั้งบทบาท / Owner | ✓ | ✗ | ✗ | ✗ |
| อนุมัติ/ยกเลิก LINE identity | ✓ | ✗ | ✗ | ✗ |

`ADMIN_TOKEN` ยังคงเป็น authentication ของ developer/system administration สำหรับ route เดิม เช่น reconcile, recovery, Sheets import และ production operations ไม่ใช่บัญชีพนักงาน และ V1.1 ไม่ทำให้ automation เดิมต้องมี LINE identity

## HR registration บน LINE OA

1. ผู้ใช้ส่ง `HR` ไปที่ LINE OA
2. หาก LINE เชื่อมกับพนักงานแล้ว ระบบตอบ HR profile ที่ไม่แสดง raw LINE User ID
3. หากยังไม่เชื่อม ระบบสร้าง request `PENDING_STAFF_ID` แล้วตอบให้พิมพ์ Staff ID
4. ผู้ใช้พิมพ์ Staff ID ระบบตรวจว่า staff มีจริง, active, LINE นี้ยังไม่เชื่อมกับใคร และ staff นั้นยังไม่มี active LINE binding
5. ระบบสร้าง `PENDING_OWNER_APPROVAL` เท่านั้น — ความรู้ Staff ID เพียงอย่างเดียวไม่เคยสร้าง binding
6. Owner ตรวจรายการผ่าน admin API แล้ว approve หรือ reject
7. เมื่อ approve จะสร้าง `VERIFIED` binding, อัปเดตค่า legacy ที่จำเป็นต่อ compatibility, และเขียน append-only audit

คำสั่ง correction แบบปลอดภัยของพนักงานคือ `CORRECT <เหตุผล>` เช่น `CORRECT missing OUT 2026-07-29` ระบบสร้าง request เพื่อให้ Manager/Owner พิจารณาเท่านั้น ไม่แก้ Attendance หรือ Payroll โดยตรง

### Owner approval through verified LINE

การอนุมัติไม่ใช้ header ที่ผู้เรียกอ้างว่าเป็น Owner. Owner ต้องเป็น LINE account ที่มี `VERIFIED` binding อยู่แล้ว และส่งคำสั่งต่อไปนี้:

```text
HR PENDING
HR APPROVE <requestId>
HR REJECT <requestId> <reason>
```

จึงยืนยัน actor จาก `event.source.userId` ที่ผูกกับ Owner จริงก่อน approve/reject และ audit จะบันทึก Owner คนที่ส่งคำสั่งจริง. `ADMIN_TOKEN` ยังคงใช้กับ developer/system routes เดิมเท่านั้น ไม่ใช่หลักฐานว่าผู้เรียกเป็น Owner.

## HR_STAFF_CONFIG

คอลัมน์เดิมยังใช้ได้ทั้งหมด `LINE_User_ID` กลายเป็น optional สำหรับการเพิ่มพนักงานใหม่ เพราะ LINE ต้องผูกผ่าน HR flow ไม่ใช่กรอกเองใน Sheets. คอลัมน์ที่ V1.1 รองรับเพิ่มแบบ optional คือ:

```text
Role, Branch_ID
```

ค่าเริ่มต้นเมื่อเพิ่มพนักงานใหม่ที่ไม่กำหนด role คือ `EMPLOYEE / B001`. การเปลี่ยน LINE User ID ของพนักงานที่มีอยู่ผ่าน import จะถูกปฏิเสธและต้องใช้ HR approval flow เสมอ. Import จะ audit การสร้าง/เปลี่ยน role ที่กำหนดผ่าน sheet.

## Canonical staff และ migration history

| Staff | Role | Scope | Branch | สถานะ |
|---|---|---|---|---|
| Eak (`OWN001`) | OWNER | ORGANIZATION | ทุกสาขา | ACTIVE / existing verified LINE binding |
| Nea (`OWN002`) | OWNER | ORGANIZATION | ทุกสาขา | ACTIVE / LINE รอ HR registration + Owner approval |
| Win (`EMP001`) | EMPLOYEE | BRANCH | B001 | ACTIVE |
| Tualek (`EMP002`) | EMPLOYEE | BRANCH | B001 | ACTIVE |
| Laws non (`EMP003`) | EMPLOYEE | BRANCH | B001 | ACTIVE |

Issue #100 เปลี่ยน primary identity ของ Eak จาก `EMP_TEST` เป็น `OWN001` ด้วย atomic identity-preserving replacement ที่ D1 รองรับ: สร้าง canonical parent ชั่วคราว, re-key ความสัมพันธ์ที่แก้ไขได้ (Attendance, Payroll, wage, shift, role, verified LINE binding และ request) แล้วลบ legacy parent เมื่อไม่มี reference เหลือ. จึงไม่มี Eak ซ้ำและไม่มีประวัติถูกลบ. `EMP_TEST` ไม่อยู่ใน `employees` จึงใช้สมัคร HR หรือเป็น operational actor ไม่ได้. Raw webhook/evidence JSON และ before/after JSON ของ audit ที่เป็น immutable อาจมี literal เดิมได้ แต่ alias จะชี้กลับไป `OWN001`; relational audit actor/target ถูก canonicalize แล้ว.

## Nea second owner

V1.1 จะไม่ bind LINE account จาก display name, คำว่า `HR`, เวลา หรือ event ใกล้เคียงกัน. `OWN002 / Nea` ถูก provision เป็น ACTIVE OWNER แล้ว แต่ไม่มี verified LINE binding จนกว่าจะผ่าน flow ปกติ จึงมีสถานะ `NEA_STAFF_READY_LINE_PENDING`.

การเพิ่มพนักงานในอนาคตให้เพิ่มแถวใน `MaliPang_OWNER_MASTER > HR_STAFF_CONFIG` แล้วเรียก controlled Staff Import ผ่าน admin route. Import validate Staff ID, Status, Role, Branch และห้ามเปลี่ยน LINE binding โดยตรง; `Role=OWNER` ต้องไม่กำหนด `Branch_ID`, ส่วน non-owner ที่ไม่ระบุ branch จะใช้ `B001`. จากนั้นพนักงานส่ง `HR` → Staff ID → Owner approve. สำหรับ Nea ให้ส่ง `HR`, ตามด้วย `OWN002`; Eak ส่ง `HR PENDING` แล้ว `HR APPROVE <requestId>`. Import role และ approval มี audit ทุกครั้ง.

## สัญญาสำหรับ V2 (ยังไม่มี UI)

V2 Board ต้อง authenticate human session ก่อน map เป็น `StaffActor`; หลังจากนั้นสามารถใช้ permission engine เดียวกันกับ contract ต่อไปนี้ได้:

```text
GET /me
GET /me/attendance
GET /me/payroll
GET /me/shift
GET /me/requests
```

ทุก resource ต้องเรียก `authorize(actor, capability, resourceScope)` ที่ backend โดยส่ง branch/employee scope จริง ห้ามใช้ UI hiding หรือ Staff ID prefix เป็นการอนุญาต. V1.1 ไม่สร้าง frontend, session system หรือ V2 route เหล่านี้.
