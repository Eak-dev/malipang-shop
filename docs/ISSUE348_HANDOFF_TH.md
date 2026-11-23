# ส่งต่องาน Issue #348 — ร่างในเครื่อง

## คำสั่งและอำนาจจากเจ้าของ

ทำ [#348](https://github.com/Eak-dev/malipang-shop/issues/348) ให้ครบ: หลักฐาน D1 ต้องตอบได้ว่า B ยืนยันหรือไม่ ขาดอะไร C ได้สิทธิ์หรือยัง และทำอะไรต่อ; แยกผลจบรอบจากผลสำเร็จรายรายการ. ผลเขียนไม่ชัดต้องรักษา claim/หลักฐาน ไม่ส่งซ้ำหรือให้สิทธิ์ต่อโดยไม่มี proof. ทดสอบ runner ถูกตัด การแข่งจอง ข้ามเดือน/Worker และหลาย DETAIL; ตรวจอิสระและปรับ flow/published views ตามโค้ด. อำนาจ #348 จำกัดพัฒนา ทดสอบในเครื่อง และ dry-run เท่านั้น; deploy หรือเขียน Google/D1 จริงต้องมี authority และ gate แยกของ #296. ห้ามถือ merge หรือ local test เป็น Production สำเร็จ. เจ้าของสั่ง commit งานร่างไว้บน branch ปัจจุบันและทำ handoff นี้ ไม่ได้สั่ง push, merge หรือ deploy.

## ฐานและจุดรับช่วง

Repository `Eak-dev/malipang-shop`, branch `codex/issue348-serial-handover`, base canonical main `d95608e43aad2b0f835c660577ad6318ccef93c8` ที่ fetch เมื่อเริ่มงาน. Commit ที่บรรจุไฟล์นี้คือจุดรับช่วง; ตรวจ `git status`, HEAD, remote main, Issue/PR สด และงานแชตอื่นก่อนทำต่อ อย่าสมมติว่า SHA หรือสถานะ Production ยังตรง. Checkout หลัก `malipang-shop` นอก workspace เคยมีงาน #296 ค้าง ห้ามสลับหรือทับโดยไม่ประสาน. ปฏิบัติตาม AGENTS และ canonical main gate/branch lifecycle ก่อนเริ่มงานใหม่.

อ่าน `docs/system-flow/README.md`, system-map หน้า 3–7 และ `serial-sequence.md` ข้อ 3–5 แล้วจาก base ข้างต้น; อัปเดตหน้า 8, sequence 6, SVG และ PDF สำหรับร่าง local. ดู [acceptance audit](ISSUE348_ACCEPTANCE_AUDIT_TH.md), [design draft](ISSUE348_DESIGN_DRAFT_TH.md), [คู่มือ](ISSUE296_NORMAL_QUEUE_PILOT_TH.md), และ [flow](system-flow/README.md) ก่อนทำต่อ. ข้อมูลสถานะสดให้ตรวจใหม่.

## ผลงานและผลตรวจ

ร่างมี round snapshot/result, proof v2, hold/recovery, read-only historical, local identity, mock attested handoff/continuation, diagnostics และ migration 0068–0079 พร้อม barriers ปิด. Local mock ทดสอบ B พัก→C ผ่าน DAILY/RAW/สอง DETAIL/FINAL และปิดผล รวมสี่หมวด, response loss, reservation race และ runner SIGKILL. Worker code กับ local D1/provider model ทดสอบ SIGKILL หลัง DAILY/RAW/DETAIL และ Worker รุ่นเดิม/ใหม่ 6/6 โดยคง claim/intent เมื่อไม่แน่ชัด. ทั้งหมดเป็น fixture/mock ตาม audit ไม่พิสูจน์ระบบภายนอก.

บนโค้ดก่อนแก้ข้อความ handoff/audit: `npm run check` exit 0: 2,603 tests, 2,597 pass, 0 fail, 6 skip; `npx wrangler deploy --dry-run` exit 0; `git diff --check` ผ่าน. ผู้ตรวจอิสระตรวจ flow/code ตามขอบเขตใน audit และ PDF หน้าที่เปลี่ยน; ไม่ได้ตรวจทุกหน้าแบบ pixel comparison. ไม่มี Production mutation.

## ปัญหาและงานค้าง — ยังไม่พร้อมรับงาน

- การส่ง C และปิดรอบครบใช้ injected coordinator, oracle, provider/notice และ external fence จำลอง; CLI ปกติไม่มี coordinator/store และ fail closed. Barrier ทุกตัวต้องคงปิด. ต้องออกแบบ/พิสูจน์ trusted oracle และ external-writer fence ตาม #296 รวม old Worker, มนุษย์ และ request ที่ยัง in-flight ก่อนใช้งานจริง.
- Restart รอบ OPEN หรือคำตอบไม่ชัดต้องอ่านหลักฐานและหยุด RECONCILE ไม่ส่ง RECORD/ADVANCE/CLOSE ซ้ำ. Local identity พึ่ง directory เดิมและ filesystem/same UID ที่เชื่อถือได้; ไม่ครอบการลบ/เปลี่ยน store, หลายเครื่องหรือ direct endpoint.
- ยังไม่ได้ทดสอบ external provider process ตอบช้าหลัง kill, production Worker isolate, migration บนสำเนา production-shaped, guard body ภายใต้ privileged DDL, โหลดหลาย DETAIL/latency/quota จริง หรือ version/migration drift ครบเส้นทาง. การหาแถวไม่พบครั้งเดียวและ lease หมดไม่ใช่ proof ว่าคำขอเก่าจบ.
- อ่านย้อนหลังข้ามเดือน/รุ่นเป็น read-only; legacy ที่หลักฐานไม่ครบต้อง RECONCILE. ไม่ให้สิทธิ์เขียนข้ามรุ่นโดยเดา.
- ตรวจ Issue และ PR สด, review diff/migrations และผลทดสอบบน HEAD ใหม่; ปิดช่อง local ที่ทำได้, อัปเดต audit/flow และรัน `npm run check` กับ `npx wrangler deploy --dry-run` ซ้ำหลังแก้โค้ด. เตรียม UAT/rollback/forward-fix และ migration rehearsal ตาม gate; การทดสอบหรือปล่อยจริงอยู่ภายใต้ #296 แยก. อย่าปิด Issue หรืออ้าง production fixed จนเกณฑ์และ authority ครบ.

## งานทดสอบภาพเพิ่มเติม

เจ้าของให้รวมงาน test gate และการเก็บรูปลงเวลาเจ็ดรูปใน branch นี้แล้ว ดู [handoff งานทดสอบภาพ](LIVE_TEST_INPUTS_HANDOFF_TH.md). รูปจริงเก็บส่วนตัวนอก Git; การทดสอบ live ทั้งหกไม่ถูกข้ามอีก แต่จะล้มเมื่อ prerequisite ขาด และยังไม่ได้พิสูจน์ผลภาพจริง.
