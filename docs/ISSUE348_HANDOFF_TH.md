# ส่งต่องาน Issue #348 — ร่างในเครื่อง

## คำสั่งและอำนาจจากเจ้าของ

ทำ [#348](https://github.com/Eak-dev/malipang-shop/issues/348) ให้ครบ: หลักฐาน D1 ต้องตอบได้ว่า B ยืนยันหรือไม่ ขาดอะไร C ได้สิทธิ์หรือยัง และทำอะไรต่อ; แยกผลจบรอบจากผลสำเร็จรายรายการ. ผลเขียนไม่ชัดต้องรักษา claim/หลักฐาน ไม่ส่งซ้ำหรือให้สิทธิ์ต่อโดยไม่มี proof. ทดสอบ runner ถูกตัด การแข่งจอง ข้ามเดือน/Worker และหลาย DETAIL; ตรวจอิสระและปรับ flow/published views ตามโค้ด. อำนาจ #348 จำกัดพัฒนา ทดสอบในเครื่อง และ dry-run เท่านั้น; deploy หรือเขียน Google/D1 จริงต้องมี authority และ gate แยกของ #296. ห้ามถือ merge หรือ local test เป็น Production สำเร็จ. เจ้าของสั่ง commit งานร่างไว้บน branch ปัจจุบันและทำ handoff นี้ ภายหลังเจ้าของให้รวมงานจาก branch รูปเข้า branch #348 ในเครื่องตามประวัติด้านล่าง.

## ฐานและจุดรับช่วง

Repository `Eak-dev/malipang-shop`, branch `codex/issue348-serial-handover`, base canonical main `d95608e43aad2b0f835c660577ad6318ccef93c8` ที่ fetch เมื่อเริ่มงาน. Commit ที่บรรจุไฟล์นี้คือจุดรับช่วง; ตรวจ `git status`, HEAD, remote main, Issue/PR สด และงานแชตอื่นก่อนทำต่อ อย่าสมมติว่า SHA หรือสถานะ Production ยังตรง. Checkout หลัก `malipang-shop` นอก workspace เคยมีงาน #296 ค้าง ห้ามสลับหรือทับโดยไม่ประสาน. ปฏิบัติตาม AGENTS และ canonical main gate/branch lifecycle ก่อนเริ่มงานใหม่.

อ่าน `docs/system-flow/README.md`, system-map หน้า 3–7 และ `serial-sequence.md` ข้อ 3–5 แล้วจาก base ข้างต้น; อัปเดตหน้า 8, sequence 6, SVG และ PDF สำหรับร่าง local. ดู [acceptance audit](ISSUE348_ACCEPTANCE_AUDIT_TH.md), [design draft](ISSUE348_DESIGN_DRAFT_TH.md), [คู่มือ](ISSUE296_NORMAL_QUEUE_PILOT_TH.md), และ [flow](system-flow/README.md) ก่อนทำต่อ. ข้อมูลสถานะสดให้ตรวจใหม่.

### จุดเริ่มและลำดับงานใน Git

- ใน workspace นี้ใช้ checkout `repositories/issue348-work/` และแผน `workspace-documents/ISSUE348_IMPLEMENTATION_PLAN_TH.md`. ผู้ประสานงานตรวจ Issue/PR ฐานและ checkout แล้วรวมหลักฐาน ผู้พัฒนาดูโค้ดและทดสอบคิว ผู้ตรวจอิสระทบทวนกรณีผิดพลาดและภาพตามขอบเขตใน acceptance audit. สำหรับการมอบหมายครั้งถัดไป เจ้าของให้เริ่มผู้ประสานงานด้วย GPT-6.2 Sol และพิจารณา GPT-6.2 Astra สำหรับงานคิว/กู้และตรวจอิสระที่ซับซ้อน เลือกจากรุ่นที่มีจริงและบันทึกรุ่นที่ใช้ตามแผน
- `6d0c286` รวมร่างคิว การทดสอบ migration คู่มือและภาพของ #348. งานทดสอบภาพจาก `codex/require-live-test-inputs` ที่ `3981015` เข้ามาด้วย cherry-pick เป็น `6ebbe7b`. ผลตรวจหลังรวมอ้าง revision `f28329a` ส่วน `1646bc0`, `f104f12` และ `c8435c7` ปรับบันทึกผลและเกณฑ์รูป
- เมื่อตรวจวันที่ 23 พ.ย. 2569 ก่อนแก้บันทึกครั้งนี้ checkout สะอาดที่ `c8435c7`, remote main อยู่ที่ `d95608e`, Issue #348 เปิดอยู่ และไม่พบ branch ชื่อนี้หรือ PR ที่ใช้ชื่อนี้เป็น head บน origin. Branch งานและรูปส่วนตัวอยู่คนละตำแหน่งบนเครื่องนี้

## ผลงานและผลตรวจ

ร่างมี round snapshot/result, proof v2, hold/recovery, read-only historical, local identity, mock attested handoff/continuation, diagnostics และ migration 0068–0079 พร้อม barriers ปิด. Local mock ทดสอบ B พัก→C ผ่าน DAILY/RAW/สอง DETAIL/FINAL และปิดผล รวมสี่หมวด, response loss, reservation race และ runner SIGKILL. Worker code กับ local D1/provider model ทดสอบ SIGKILL หลัง DAILY/RAW/DETAIL และ Worker รุ่นเดิม/ใหม่ 6/6 โดยคง claim/intent เมื่อไม่แน่ชัด. ทั้งหมดเป็น fixture/mock ตาม audit ไม่พิสูจน์ระบบภายนอก.

เริ่มไล่เส้นทางจาก [ตัวรัน RUN_SERIAL](../scripts/prod-normal-queue-pilot.mjs) ไปที่ [การพัก B](../src/admin/serial-pilot-hold.ts), [การส่งสิทธิ์ C](../src/admin/serial-attested-handoff.ts) และ [การเก็บผลรอบ](../src/admin/serial-round-store.ts). ตอนรับช่วงเริ่มด้วย READ/LIST_RECENT เพื่อระบุรอบ งาน และรุ่น ถ้ารอบยัง OPEN ให้กระทบยอดหลักฐาน ถ้า CLOSED ให้อ่านผลเดิมด้วย READ_ROUND. ดูเงื่อนไข PARKED, VERIFIED, NOT_STARTED และ RECONCILE ตลอดจนข้อจำกัดของแต่ละการทดสอบใน [ตารางเกณฑ์รับงาน](ISSUE348_ACCEPTANCE_AUDIT_TH.md)

ผลบนร่าง #348 ก่อนนำ commit งานรูปเข้ามา (ผลหลังรวมอยู่ในหัวข้องานทดสอบภาพ): `npm run check` exit 0: 2,603 tests, 2,597 pass, 0 fail, 6 skip; `npx wrangler deploy --dry-run` exit 0; `git diff --check` ผ่าน. ผู้ตรวจอิสระตรวจ flow/code ตามขอบเขตใน audit และ PDF หน้าที่เปลี่ยน; ไม่ได้ตรวจทุกหน้าแบบ pixel comparison. ไม่มี Production mutation.

## ปัญหาและงานค้าง — ยังไม่พร้อมรับงาน

- การส่ง C และปิดรอบครบใช้ injected coordinator, oracle, provider/notice และ external fence จำลอง; CLI ปกติไม่มี coordinator/store และ fail closed. Barrier ทุกตัวต้องคงปิด. ต้องออกแบบ/พิสูจน์ trusted oracle และ external-writer fence ตาม #296 รวม old Worker, มนุษย์ และ request ที่ยัง in-flight ก่อนใช้งานจริง.
- Restart รอบ OPEN หรือคำตอบไม่ชัดต้องอ่านหลักฐานและหยุด RECONCILE ไม่ส่ง RECORD/ADVANCE/CLOSE ซ้ำ. Local identity พึ่ง directory เดิมและ filesystem/same UID ที่เชื่อถือได้; ไม่ครอบการลบ/เปลี่ยน store, หลายเครื่องหรือ direct endpoint.
- ยังไม่ได้ทดสอบ external provider process ตอบช้าหลัง kill, production Worker isolate, migration บนสำเนา production-shaped, guard body ภายใต้ privileged DDL, โหลดหลาย DETAIL/latency/quota จริง หรือ version/migration drift ครบเส้นทาง. การหาแถวไม่พบครั้งเดียวและ lease หมดไม่ใช่ proof ว่าคำขอเก่าจบ.
- อ่านย้อนหลังข้ามเดือน/รุ่นเป็น read-only; legacy ที่หลักฐานไม่ครบต้อง RECONCILE. ไม่ให้สิทธิ์เขียนข้ามรุ่นโดยเดา.
- ตรวจ Issue และ PR สด, review diff/migrations และผลทดสอบบน HEAD ใหม่; ปิดช่อง local ที่ทำได้, อัปเดต audit/flow และรัน `npm run check` กับ `npx wrangler deploy --dry-run` ซ้ำหลังแก้โค้ด. เตรียม UAT/rollback/forward-fix และ migration rehearsal ตาม gate; การทดสอบหรือปล่อยจริงอยู่ภายใต้ #296 แยก. อย่าปิด Issue หรืออ้าง production fixed จนเกณฑ์และ authority ครบ.

## งานทดสอบภาพเพิ่มเติม

เจ้าของให้รวมงาน test gate และการเก็บรูปลงเวลาเจ็ดรูปใน branch นี้แล้ว ดู [handoff งานทดสอบภาพ](LIVE_TEST_INPUTS_HANDOFF_TH.md). รูปจริงเก็บส่วนตัวนอก Git; การทดสอบ live ทั้งหกไม่ถูกข้ามอีก แต่จะล้มเมื่อ prerequisite ขาด และยังไม่ได้พิสูจน์ผลภาพจริง.

### เงื่อนไขรูปลงเวลาและขั้นตอนรับช่วง

- เจ้าของยืนยันรูปลงเวลาเจ็ดรูป: `photo-01`–`photo-05` เป็นภาพต่างกันที่คาดว่าต้องผ่าน ส่วน `photo-06`–`photo-07` เป็นภาพต่างกันที่คาดว่าต้องไม่ผ่าน ทั้งสองรูปหลังมีนาฬิกาและที่อยู่ แต่ไม่มีวันเวลาและพิกัด GPS สีขาวที่ซ้อนบนภาพ. วันเวลาในภาพซ้อนและเวลาบนนาฬิกาเป็นหลักฐานคนละส่วน อย่าใช้เวลาบนนาฬิกาแทนวันเวลาในภาพซ้อน. ผลที่เจ้าของคาดเป็นเกณฑ์ทดสอบ ไม่ใช่ผลที่ระบบพิสูจน์แล้ว.
- รูปอยู่ที่ workspace `private-test-fixtures/clock-20261123/` นอก repository พร้อม README ส่วนตัว; ห้าม commit หรือเผยแพร่รูปและข้อมูลส่วนตัว. เจ้าของอนุญาตใช้รูปและข้อมูลจริงเพื่อทดสอบ รวมถึงใช้ OpenAI ที่มีอยู่ แต่ต้องตรวจปลายทาง ผลข้างเคียง และ authority แยกก่อนเรียกบริการจริงหรือเขียน Google/D1 ตามข้อจำกัด #296.
- รูปใหม่ **ยังไม่ได้ผูกเข้ากับ** `tests/fixtures/clock-photos/cases.json` ชุดเดิม ซึ่งมี expected ของภาพเก่า. จัด fixture/manifest และ expected เฉพาะภาพใหม่อย่างเป็นส่วนตัว ใช้ `receivedAt` จำลองใกล้เวลาถ่ายย้อนหลัง ตรวจรัศมีร้าน และทดสอบแต่ละภาพแยกกัน. อย่าปรับ expected ให้ตามผลที่ระบบตอบ หรือใช้รูปเดียวแทนหลายกรณี.
- ตรวจและปรับ contract/assertion ใน `tests/clock-photo-fixtures.test.mjs` ให้รองรับกรณีไม่มี timestamp/GPS ตามหลักฐานจริง: ของเดิมบังคับ `photoDate`, `photoTime`, overlay และ validation code ในรูปแบบที่อาจไม่ตรงรูปใหม่. ตรวจลำดับ validation ก่อนกำหนดรหัสข้อผิดพลาด; ห้ามเดาว่าทั้งสองรูปต้องเป็น `GPS_MISSING` เพราะอาจหยุดที่ timestamp ก่อน. หลีกเลี่ยงการบันทึกพิกัดหรือข้อมูลส่วนตัวลง log.
- หกกรณีที่เคยข้ามประกอบด้วยสลิป 1, รูปลงเวลา 1, ค่าใช้จ่าย 1 และคำสั่งซื้อออนไลน์ 3; เจ็ดรูปเป็นข้อมูลย่อยของกรณีลงเวลา ไม่ได้แทนข้อมูลที่ขาดของอีกห้ากรณี. หลังรวมงาน `npm run check` ได้ 2,597 ผ่าน, 6 ล้ม, 0 ข้าม จาก 2,603 เพราะขาด vision URL สองกรณี, expense URL หนึ่งกรณี และ private order manifest สามกรณี. ยังไม่มีผล live ของรูป. เตรียม prerequisites และตัวอย่างที่เหลือ แล้วรันทั้งหกและ full check รายงานผลจริง; ดูรายละเอียดและข้อจำกัดใน handoff งานทดสอบภาพ.

### หกกรณีที่เคยข้ามและข้อมูลที่ต้องเตรียม

| กรณี | เงื่อนไขเดิมที่ทำให้ข้าม | สิ่งที่คนรับช่วงต้องใช้ |
| --- | --- | --- |
| สลิป 1 | ขาด vision URL, ไฟล์ admin token หรือรายการไฟล์ภาพไม่ครบ | สลิป KBank, เป๋าตัง และ SCB ที่เจ้าของส่ง พร้อม expected ที่ตรงภาพ และ `MALIPANG_BANK_SLIP_IMAGE_MAP` |
| ลงเวลา 1 | ขาด vision URL, ไฟล์ admin token หรือโหลดรูปได้ไม่ครบ | JPEG เจ็ดไฟล์ที่เก็บไว้แล้วและ manifest ชุดใหม่ตามหัวข้อข้างต้น ให้ระบบทดสอบตัดสินแต่ละรูป |
| ข้อความค่าใช้จ่าย 1 | ขาด `MALIPANG_EXPENSE_BASE_URL` หรือไฟล์ admin token | บริการทดสอบค่าใช้จ่ายและ token สำหรับบริการนั้น กรณีนี้ใช้ข้อความ |
| คำสั่งซื้อ 3 | ขาด `ONLINE_ORDER_PRIVATE_FIXTURES` | manifest ส่วนตัวที่เก็บผลอ่านภาพแบบตัดข้อมูลระบุตัวตนและตรวจ hash สำหรับสามตัวอย่าง ชุดทดสอบอ่าน manifest แล้วตรวจขั้นตอนยืนยันและรับข้อความซ้ำในเครื่อง |

สองกรณีแรกใช้ `MALIPANG_VISION_BASE_URL` และ `MALIPANG_ADMIN_TOKEN_FILE`. สลิปทั้งสามและภาพคำสั่งซื้อหนึ่งภาพมาจากไฟล์แนบชั่วคราว ส่วนรูปลงเวลาที่ส่งเป็นตัวอย่างครั้งแรกอยู่คนละชุดกับห้ารูปผ่านและสองรูปไม่ผ่านที่เจ้าของยืนยันภายหลัง. สำหรับคำสั่งซื้อ ให้ตรวจตัวอย่างอีกสองรายการและ expected ของทั้งสามก่อนรัน ดูชื่อไฟล์ทดสอบและข้อจำกัดของสคริปต์ชั่วคราวใน [บันทึกการทดสอบภาพ](LIVE_TEST_INPUTS_HANDOFF_TH.md)

เมื่อผูกชุดข้อมูลจริงครบ ให้รันผ่านระบบทดสอบ MaliPang ด้วยสิทธิ์ OpenAI เดิมที่เจ้าของอนุญาต เก็บผลรายรูปด้วยรหัสภาพและเหตุผล แล้วรัน `npm run check` ทั้งชุดและ `npx wrangler deploy --dry-run`. รอบล่าสุดล้มตั้งแต่ตรวจข้อมูลตั้งต้น ดูตัวเลขหลังรวมด้านบน ก่อนอ้างผลรูปให้ตรวจว่าทั้งเจ็ดรูปถูกประมวลผลจริงและเทียบกับเกณฑ์ของเจ้าของแล้ว
