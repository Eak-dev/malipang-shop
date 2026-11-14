# Charter และขอบเขตผลิตภัณฑ์

## เป้าหมายทางธุรกิจ

ลดการกรอกซ้ำ การเปิดหลายไฟล์ และการตามผลในแชต โดยรักษาความถูกต้องของสต๊อก เวลา ค่าแรง และเงิน. ผู้ใช้ทำงานบนมือถือได้ด้วยบัญชีรายคน Owner เห็นภาพรวมและตรวจย้อนหลังได้ พนักงานเห็นเฉพาะข้อมูลที่จำเป็น

## ทางเลือกและข้อเสนอ

| ทางเลือก | ต้นทุน/ข้อดี | ข้อเสียและความเสี่ยง | ข้อเสนอ |
|---|---|---|---|
| เว็บครอบ Sheets | ทำหน้าจอได้เร็ว | ยังมีสูตร/row drift/หลาย writer/การพึ่งไฟล์ | ใช้เพียง read adapter ช่วงย้าย |
| เว็บและฐานข้อมูลร่วม backend เดิม | รักษาประวัติและ business service, ย้ายเป็นหมวด | ต้องทำ contracts และ migration รอบคอบ | เลือกเป็น planning baseline |
| Rewrite ทุกอย่างพร้อมกัน | ออกแบบใหม่ได้หมด | ตรวจยอดผิดยาก ค่าใช้จ่ายและ rollback สูง | ไม่เลือก |

โครงการใหม่เป็น product workstream ใน repository เดิม เพื่อไม่แยกเจ้าของ schema/business logic. เสนอ frontend package แยกจาก backend ใน repo เดียวและ deploy surface แยก โดย API/business service ยังเป็นของ backend เดิม. จะเปลี่ยน repo topology ภายหลังได้เมื่อมี ADR และผู้รับผิดชอบ migration ชัด; รอบนี้ไม่สร้าง repo/hosting ใหม่

## Scope ตามรุ่น

| รุ่น | งานที่ได้รับ | สิ่งที่ต้องพิสูจน์ก่อน |
|---|---|---|
| R0 — planning/discovery | control, source/field mapping, policy differences, design, task queue | evidence completeness; ไม่ต้องเปิด Production |
| R1 — mobile read-only | login, pending membership, Team stock/history/calendar, own attendance, Owner dashboard แบบข้อมูลครบ/ไม่ครบ | security matrix, read parity, #58 gate |
| R2 — Team work | stock count/daily counts, attendance upload, own correction requests, announcements | duplicate/concurrency/offline failure และ attendance parity |
| R3 — stock operations | versioned units/recipes, production, purchase recommendations/order/receipt | approved inputs, unit/recipe policy, ledger parity |
| R4 — Owner administration | expense/personal ledger, HR/shift/wage/payroll actions, accounting reports/month close | upstream hardening และ approved money policies |
| R5 — retirement | หมดความจำเป็นต้องกรอก/คำนวณผ่าน Sheets และแชตหลังบ้าน | reader/writer/notification replacement ครบและ rollback |

R1/R2 ไม่ได้บังคับย้ายการเงินทั้งหมดเพื่อให้พนักงานเริ่มได้; แต่ต้องผ่าน hard gate โครงการและ dependencies ของแต่ละงาน

## ไม่รวมในรุ่นแรก

POS เต็มระบบ, checkout ลูกค้า/รับชำระเงินจริง, loyalty/marketing automation, bank API, CCTV/AI ประเมินพนักงาน, face recognition, native mobile apps, offline multi-device sync, การเปลี่ยนสูตรหรือกฎค่าแรง, สาขาใหม่ที่เปิดใช้งานจริง. เก็บ branch scope รองรับอนาคต แต่ไม่สร้างสาขา/สมาชิกจริงเอง

## Success metrics — เป้าหมายเสนอ ต้องวัด baseline ก่อนเปรียบเทียบ

| Metric | เกณฑ์รับงาน |
|---|---|
| Lost/duplicate finalized transactions | 0 unexplained ใน test/UAT/reconcile ที่ระบุช่วงและ coverage |
| Unauthorized field/record exposure | 0 ใน negative API/UI/export/evidence tests |
| Financial parity | ยอดรายรายการและผลรวมตรงหน่วยสตางค์; ไม่มี delta ที่อธิบายไม่ได้ |
| Stock parity | ตรง approved unit precision; variance ทุกตัวมีที่มา/ผู้ตัดสิน |
| Usability | approved tester แต่ละบทบาททำ happy path และ recovery ได้ตาม script โดยไม่ต้องเปิดชีต/ถาม Dev |
| Routine effort | วัดเวลางานและจำนวนกรอกซ้ำก่อน/หลัง; เป้าหมายลดเวลางานซ้ำอย่างน้อย 30% เป็นสมมติฐาน ไม่ใช่ผลที่พิสูจน์แล้ว |
| Completeness | ทุก source row/range/flow ถูกจัด imported/replaced/archived/excluded พร้อมเหตุผล ไม่ใช้จำนวนแท็บเป็นจำนวนหน้าจอ |

## Responsibility

Owner ตัดสินนโยบาย ธุรกิจ งบ UAT และ release. PO/PM ดู scope/dependency/acceptance. Dev ทำ implementation ภายใน task authority. Reviewer ตรวจ code/data/security independently ก่อน release ตาม gate เดิม. พนักงานที่ Owner เลือกทำ UAT; ไม่ใช้บัญชีพนักงานจริงใน test โดยพลการ
