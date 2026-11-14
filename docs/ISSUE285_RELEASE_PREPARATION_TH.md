# Issue #285 / PR #286 — เตรียมปล่อยบั๊กฟิกวิธีชำระเงิน

สถานะ: **NO-GO** เอกสารเตรียมตรวจ ไม่ใช่คำสั่งปล่อยหรือสิทธิ์ข้าม gate

## ขอบเขตและหลักฐานที่มี

- PR #286 แก้ LINE Expense เลือก payment/source และบันทึก review/audit; ไม่มี migration หรือเจตนาเปลี่ยน Queue, Cron, bindings, ค่า config, Sheets หรือกฎบัญชี
- ตัวอย่าง SHA ที่เตรียม package: `e7550eccea751ee1b3bc69804b5cbe05f987a176` ต้องตรวจ PR head, CI และ canonical main สดก่อนใช้; หากเปลี่ยน SHA ต้องสร้าง package และตรวจใหม่
- เมื่อ 14 พ.ย. 2026 จาก Cloudflare Worker version `a205bba7-c754-4e0d-b1aa-736189650f28` รับ traffic 100%. นี่เป็น snapshot ไม่ใช่สถานะสด
- ตรวจ GET Queue list/detail แล้ว `settings.delivery_paused` ไม่ปรากฏ; API ระบุ field นี้เป็น optional. Guard ปัจจุบันต้องได้รับ boolean `false` ชัดเจน จึงยังไม่ผ่าน ห้ามแปลงค่าที่หายเป็น `false` หรือใช้ backlog 0 เป็นหลักฐานแทน
- Runtime audit [43551219814](https://github.com/Eak-dev/malipang-shop/actions/runs/43551219814) อ่าน authenticated readiness ได้ 200 ทุก check ผ่าน แต่ workflow รวมล้มหลัง status 200 ก่อนบันทึกผลที่ผ่าน sanitizer. สาเหตุ sanitizer ยังไม่ยืนยัน
- Build แบบ `wrangler deploy --dry-run --outdir` ในเครื่องจาก reviewed runtime SHA `2680c515b39a082038fdde707c236e4216290039` และ PR SHA ข้างต้นสำเร็จ. SHA-256 ของ `index.js` ตามลำดับ: `75f01957bbdc15c9e84c55bbe2a8ee55736932f036804a0e68b58fdc4c0fd4cc`, `fcb7c3425cad8c8774d521312378c6583d15c7a3cce45f855767ab51a3cf04b5`. เป็นหลักฐาน build ในเครื่องเท่านั้น ไม่ใช่ artifact สำหรับ deploy หรือหลักฐานว่าสร้างซ้ำได้จาก CI
- `wrangler versions upload --dry-run` ชี้ API base ไป localhost และไม่ตั้ง Cloudflare token/account ใน environment สร้าง module SHA เดียวกับ PR build ข้างต้น; ไม่ได้อัปโหลดและไม่พิสูจน์ side effects ของ upload จริง. `wrangler queues info` ไม่แสดงสถานะ pause เช่นกัน
- เนื้อหา Worker ที่ provider ส่งจาก content/v2 มี SHA-256 `02339831afa87ce1a15012e483439c44b2e69b1cc40f75756c39324fd02457e7` เมื่อ hash เฉพาะ module `index.js`; ไม่ตรงกับ local baseline build ข้างต้น. ยังไม่ทราบเหตุผลและห้ามถือว่า reviewed SHA กับ bundle ที่ใช้งานมี byte เหมือนกัน

## แนวทางที่ต้องพิสูจน์ก่อนเขียน release control

1. ขอหลักฐาน read-only จาก Cloudflare ที่แสดง Queue เดิมและ `delivery_paused=false` ชัดเจน ผูก account/queue/time ปัจจุบัน; หากหาไม่ได้ให้หยุด ห้าม pause/resume/PATCH เพื่อสร้างหลักฐาน และห้ามผ่อน guard
2. ผูก release กับ PR head หรือ merge SHA ที่ผ่าน CI จริง พร้อม artifact digest และยืนยันเนื้อหาที่จะปล่อยเทียบ Worker ปัจจุบัน รวมทั้งพิสูจน์ความต่างของ baseline bundle ก่อน ไม่อ้างเพียง Git ancestry
3. ตรวจ writer/recovery operation และ baseline ของ version, Queue, Cron, Durable Object migration tag, bindings และ config แบบไม่เปิด secret; ยืนยันไม่มีงานอื่นที่อาจชน ณ เวลาปล่อย
4. แนวทางที่อาจใช้คือแยก upload version และ create deployment ผ่าน API ของ Cloudflare แต่ **ยังไม่ยืนยัน** ว่า endpoint และ binding inheritance รักษาทุก setting/secret/trigger ที่ระบบนี้ใช้ หรือปลอดผลกระทบต่อ Queue. Script-version API ที่สืบทอด `latest` อาจเลือก version ที่อัปโหลดล่าสุดแทน version ที่รับ traffic; ห้ามใช้โดยไม่พิสูจน์. หากพิจารณา Workers API ที่รองรับ inherit จาก version ID ต้องทดสอบ contract และ side effects ในสภาพแวดล้อมแยกก่อน
5. ทดสอบ release control กับ mock provider ทั้ง success, missing/true/null pause, config drift, concurrent change, failed/lost ACK, retry และ rollback decision. ตรวจเส้นทาง HTTP ทั้งหมดว่าไม่มี mutation ไป Queue/Cron/config. Mock ยืนยันพฤติกรรม client เท่านั้น ไม่พิสูจน์ side effects ภายใน provider
6. ก่อน release จริงต้องมี fresh private backup และทดสอบ restore, authenticated readiness และ status ล่าสุด, UAT ที่ได้รับอนุมัติ, เงื่อนไขหยุด, แผน rollback ที่ตรวจ writer/claim/journal ก่อน และหลักฐานตรวจหลังปล่อย. อย่า retry, replay หรือ rollback อัตโนมัติเมื่อผลไม่ชัดเจน

## แหล่งอ้างอิง

- [Cloudflare Get Queue API](https://developers.cloudflare.com/api/resources/queues/methods/get/)
- [Cloudflare deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)
- [Cloudflare pause delivery](https://developers.cloudflare.com/queues/configuration/pause-purge/)
- Guard ปัจจุบัน: `scripts/pr247-stage-guard.mjs` และ `scripts/issue248-queue-proof.mjs`

ไม่เปลี่ยน `docs/PROJECT_CONTEXT_TH.md`: เอกสารนี้บันทึกหลักฐานและข้อเสนอที่ยังไม่เปิดใช้ ไม่เปลี่ยนฟีเจอร์หรือขั้นตอน Production
