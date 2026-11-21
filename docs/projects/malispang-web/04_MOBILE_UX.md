# Mobile UX และ LINE replacement map

Design specification เท่านั้น ไม่มี frontend ถูกสร้างจากเอกสารนี้. โลโก้/ภาพแนบใช้เป็น brand reference; ไม่ใช้ราคา/โปรจากภาพเป็น current business config

## Design system

พื้นครีม สีข้อความน้ำตาลเข้ม และ accent สีขนมปัง; ใช้สีสถานะร่วมกับข้อความ/ไอคอน ไม่ใช้สีอย่างเดียว. Base font 16px, touch target อย่างน้อย 44×44 CSS px เป็น design target, Thai labels, ตัวเลขและหน่วยชิดกัน, sticky primary action ที่ไม่ทับแป้นพิมพ์. รองรับ 360–430px และ tablet/desktop; ตารางกว้างเปลี่ยนเป็น cards/detail/filter. ทดสอบ contrast, zoom 200%, screen-reader labels และ keyboard navigation

## Sitemap and screen contracts

| ID / Route proposed | ผู้ใช้/วัตถุประสงค์ | Content/action | Empty/error/pending |
|---|---|---|---|
| U01 /login | ทุกคน เข้าระบบ | LINE login; pending status; help | cancel/expired/reopen Safari flow ไม่มี redirect loop |
| U02 /today | Team/Owner เริ่มงาน | own attendance, assigned daily tasks, audience announcements | บอกข้อมูลถึงเมื่อไร; ไม่มี task ไม่แปลว่าร้านปิด |
| U03 /stock/counts | Team นับสินค้า | category/search, quantities, units, count session | blank ≠ 0; invalid field inline; conflict reload/compare |
| U04 /stock/daily | Team กรอกรายวัน | approved received/remaining/waste fields; formula results readonly | incomplete inputs ไม่แสดง derived total เป็นศูนย์ |
| U05 /attendance | self ลงเวลา | current state, upload required evidence, submit, receipt | RECEIVED/PROCESSING/ACCEPTED/REJECTED; no false success |
| U06 /history | Team ตรวจของตน/งานทีม | date/module/status filters, detail, own correction request | permission-aware results; pagination end/completeness |
| U07 /calendar | Team ดูตาราง | approved schedule/holiday audience | hidden personal leave reasons; old policy banner for Owner only |
| U08 /me | self profile | minimal profile, session logout, requests | pending/revoked status; no access-management controls |
| U09 /owner | Owner ภาพรวม | counts completeness, exceptions, stock/purchase/cash summary by module | actual/estimated/stale/unknown แยกชัด |
| U10 /owner/purchases | Owner ซื้อ/รับ | recommendation→order→partial receipt→complete | outstanding qty, overreceipt blocked/review, price variance |
| U11 /owner/finance | Owner เงิน | expense/personal drafts, bank identity, reports, period status | unknown historical bank; closed period rejects stale action |
| U12 /owner/people | Owner บุคลากร | members, role scope, shifts, wage effective dates, payroll preview | no silent retroactive apply; approval version required |
| U13 /owner/settings | Owner ตั้งค่า | approved config/recipe versions, permissions, announcements | show impact/before-after; audit and concurrent edit conflict |
| U14 /owner/operations | Owner งานค้าง | business receipt vs side-effect status, data freshness | failure ไม่เท่ากับ failed business commit; no raw admin secrets |
| U15 /team/bills | ผู้มีสิทธิ์แบบบิลเดิม | approved fields only, preview | PII exposure gate; not checkout/POS/payment status inference |

Team bottom navigation: วันนี้ / สต๊อก / ประวัติ / บัญชีฉัน. Calendar และแบบบิลเข้าจากงานวันนี้เมื่อมี grant. Owner ใช้หมวดงานและ switch view โดยไม่จำลอง actor คนอื่น

## Critical user journeys

### ลงเวลา

เปิดหน้า → ตรวจ session/employee status → เลือกส่งหลักฐานตาม flow เดิม → อัปโหลด → ได้ submission receipt → ตรวจภาพด้วย validation เดิม → เห็น accepted official time หรือ rejection reason. ปุ่มเข้า/ออกเป็นเจตนาผู้ใช้; coordinator ยังตรวจลำดับเดิม ไม่ให้ client บังคับ punch type ข้ามกฎ. ขอแก้ไขสร้าง request แยก ไม่แก้ accepted event

### นับสต๊อก

เลือกวัน/จุดนับ → เห็นรายการและหน่วย → กรอก/พักร่าง → ตรวจช่องที่ขาด → ส่งรอบนับ → server validates version → ได้ receipt/version. หลัง submit ต้อง correction มีเหตุผล. ไม่ส่งทีละ keypress เป็น stock movement; count observation ต้องแยกจาก reconciliation adjustment

### ค่าใช้จ่ายและบัญชีส่วนตัว

เลือกงานอย่างชัดเจน → ส่งข้อความ/หลักฐาน → ตรวจรายการที่ยังขาด → confirmed/cancelled ตาม approved service contract. ห้ามสร้างกฎ “ต้องกดยืนยันทุกครั้ง” ทับ quick-save/last-field semantics ที่อนุมัติแล้วโดยไม่ review. ยอด/แหล่งเงิน/period ต้อง validate server-side และ UI แสดง action ที่ทำได้ตาม version ปัจจุบัน

### ซื้อของ

ดู recommendation (ไม่ใช่สั่งซื้อ) → Owner ยืนยัน order → รับจริงทีละ shipment → บันทึก variance/lot/unit → stock movement เฉพาะที่รับจริง. จ่ายเงินเป็นอีกเหตุการณ์ ไม่ mark paid เพราะ received; no supplier messages sent automatically

## LINE command → web coverage

| Current source route/flow | Web destination | สิ่งที่รักษา | จะถอนเมื่อไร |
|---|---|---|---|
| HR onboarding / pending / approval | U01/U12 | canonical identity + actual approver audit | verified web registration/recovery complete |
| Attendance image | U05/U06 | timestamp+GPS overlay/radius/photo age/IN-OUT | cross-channel dedupe+parity passed |
| CORRECT request | U06/U12 | request-only; approved correction policy | request/approval UAT |
| Owner OT commands | U12 | wage/OT policy และ effective dates | same approved calculations/UAT |
| Expense text/image/postback | U11 หรือ permitted self flow | confirmation, duplicate slip, evidence ownership | financial hardening and parity |
| PERSONAL_USE/PERSONAL_RETURN actions | U11 | separate ledger; account unknown; CAS/period checks | #163–#169 relevant contracts accepted |
| Saved/rejected/result messages | receipt detail/U14 | commit independent of notification | visible pending/failure recovery exists |
| Announcements/shop data | U02/U13 | audience/version/publish rights | actual settings inventory W01 complete |
| Unknown LINE menus/auto-replies | W01 unresolved rows | no route silently dropped | map every discovered action |

## Network and interaction rules

Offline แสดง “ยังไม่ได้ส่ง”; รุ่นแรกไม่มี background submission หรือ offline attendance acceptance. ร่าง non-sensitive stock inputs เก็บชั่วคราวได้หลัง privacy review แต่ financial/evidence tokens ไม่ค้างเครื่อง. หาก response หายให้ query receipt ด้วย operation identity; อย่าสร้างรายการใหม่. Double-click disables UI และ backend idempotency ยังบังคับ

รายการที่ commit แล้วแต่ LINE/Sheets ส่งไม่สำเร็จแสดง “บันทึกแล้ว — การแจ้งผล/สำเนารอส่ง” พร้อม receipt. คำว่า “กำลังตรวจ” ใช้เมื่อยังไม่ finalized. Apple/Android camera upload และ HEIC compatibility ต้องทดสอบจริง; ไม่รับประกัน camera control ป้องกันภาพเก่าหรือ spoof ได้
