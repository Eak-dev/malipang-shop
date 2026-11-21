# Issue #248 — ข้อยกเว้น G7 source revision สำหรับ hotfix นี้เท่านั้น

สถานะ: เตรียมตรวจทานเท่านั้น ยังไม่ merge หรือ deploy ไม่ใช่หลักฐานว่า G7 ผ่านซ้ำ

## ปัญหา
G7 receipt (zero-item) บันทึก `source_revision=67` แต่ `stable_source_revision` เป็นตัวนับระดับ global ที่ trigger เพิ่มทีละ 1 ทุกครั้งที่เขียน expense/document/link/item ใดก็ได้ (`migrations/0021_stable_workbook_claim.sql:77-97`) หลัง sync กลับมาทำงาน revision จึงไปถึง 86 การตรวจแบบเดิม (`epoch.source_revision === receipt.source_revision`) จึงบล็อก release ทุกครั้ง แม้ canary เองอาจไม่ได้เปลี่ยน

## สิ่งที่เปลี่ยน (เปิดเฉพาะ release workflow ของ hotfix นี้ และเฉพาะ B_POST)
- ค่าเริ่มต้นยังเป็น strict equality สำหรับทุก caller (G8, terminal hotfix เดิม, CLI ของ stage guard)
- ต้องมีทั้ง input `g7_revision_exception` ที่ owner พิมพ์ตรงตัว และ flag ที่ snapshot ส่งให้ zero-proof เฉพาะ mode `B_POST`; stage guard ปฏิเสธ option นี้ใน mode อื่น (`CANARY_EXCEPTION_SCOPE`)
- ผูกกับ receipt ประวัติ `source_revision=67` เท่านั้น; ไม่แก้หรือเขียนทับ receipt/intent
- ผ่านเมื่อ: revision ของการอ่าน canary = revision ของ epoch query, revision ≥ 67, digest ปัจจุบัน = digest ใน G7 ซึ่งผูกกับ DAILY/RAW journal ที่ VERIFIED, items/documents/links = 0 และ invariant เดิมทั้งหมดยังบังคับ (`journal_total=2`, `detail_any=0`, trigger 27 ตัว, epoch immutable, GH/R2 provenance)

## การอ่าน canary โดยไม่ดึง PII ออกจาก D1
- ใช้ **คำสั่งอ่านอย่างเดียวคำสั่งเดียว** (`scripts/issue248-canary-source-digest.mjs`) คำนวณ digest ภายใน D1 ตามสูตร `src/sheets/stable-expense-source.ts` (`sha256(JSON.stringify({expense,links,documents,items}))`) ผลที่ออกจาก provider มีเพียง 7 คอลัมน์: `rev, expense_rows, links, documents, items, selftest, digest` ไม่มีคอลัมน์ของรายการ (LINE user ID, message ID, รหัสพนักงาน, คำอธิบาย) ทั้งใน stdout, ไฟล์ชั่วคราว และ error (stderr ของ wrangler ถูกทิ้งและแสดงเพียงรหัส)
- ข้อยกเว้นรับเฉพาะ canary ที่ไม่มี links/documents/items จึง hash `{"expense":<row>,"links":[],"documents":[],"items":[]}` โดย `<row>` เป็น `json_object` ตามลำดับคอลัมน์ของตาราง (เท่ากับ `SELECT e.*` ที่ตัด `__stable_revision`) ถ้ามี link/document/item ใดจะไม่มี digest และหยุด (`SHAPE`)
- SHA-256 เขียนด้วย SQL (recursive CTE บน hex ของ UTF-8) ทดสอบเทียบ node crypto และเทียบ `readStableExpenseSource` ที่ compile จริงด้วยข้อมูลสังเคราะห์
- **Provider self-test**: แถวสังเคราะห์คงที่ (เครื่องหมายคำพูด, backslash, control character, ภาษาไทย, emoji, U+2028/2029, NULL, 2^53-1) ผ่าน JSON/SHA-256 SQL ชุดเดียวกัน ต้องได้ digest เท่ากับที่คำนวณใน Node ถ้า D1 มี semantics ต่างจะหยุด (`PROVIDER_SELFTEST`) แทนการผ่านผิด
- ถ้าตาราง `expense_events` มีจำนวนคอลัมน์เปลี่ยน คำสั่งจะ compile ไม่ผ่าน (UNION ALL กับค่าคงที่ 18 ค่า) จึงไม่ข้ามคอลัมน์ใหม่แบบเงียบ ลำดับคอลัมน์อิง migrations 0001+0013; หากลำดับใน Production ต่าง digest จะไม่ตรงและหยุด
- envelope ต้องมีหนึ่งรายการ อ่านอย่างเดียว (`changed_db=false`, `rows_written=0`) และคอลัมน์ตรงลำดับ ถ้ารูปแบบ provider ไม่ตรงจะหยุด (`EVIDENCE`)

## หลักฐาน attendance REVIEW และ expired writer โดยไม่ดึงค่าของงาน
- คำสั่ง review/writers ของ release สร้างจาก `scripts/issue248-nonfinancial-release-guard.mjs` (`sql-review`, `sql-writers`) ที่ pin ไว้ ไม่มี SQL inline ใน workflow
- entity_key (payroll เก็บรหัสพนักงาน|วันที่), job ID, trace, lease token และ last_error ของงานใดก็ตาม ถูก hash และเทียบกับ pin **ภายใน D1** (`scripts/issue248-provider-sha256.mjs`); runner ได้เฉพาะจำนวน: `review_total, candidates, known_job_rows, known_exact` และ `claims, inflight, active_or_unbounded_leases, staff_processing, expired_processing, expired_known, expired_known_state`
- เงื่อนไข guard เดิมครบ: known attendance ต้องมีหนึ่งรายการ ทุก field ตรง (สถานะ REVIEW, version 1, attempt 1, error, lease หมดอายุ, ไม่มี failed job เปิด, timestamp และ hash ทั้งสี่) และเป็น REVIEW เดียว; candidate เกิน 20 ไม่เชื่อถือ; expired writer ยกเว้นได้เฉพาะหนึ่งรายการที่ hash ตรง pin และสถานะ terminal/source/journal ตรง พร้อมคำยอมรับของ owner
- error ของ provider ถูกทิ้งและแสดงเพียงรหัส (`HOTFIX_REVIEW_READ_UNKNOWN`, `HOTFIX_WRITERS_READ_UNKNOWN`)
- ถ้ารายการ terminal ที่ pin ไว้ถูกยกเลิก/นำออกก่อน release, expired exception จะไม่ตรงและ precheck จะหยุดเอง ต้องจัดลำดับกับงานนำรายการออก

## Workflow summary
ขั้น summary (`if: always()`) อ้าง "VERIFIED" เฉพาะขั้นที่ outcome เป็น `success` (precheck, deploy, postcheck); ถ้าขั้นใด fail, ถูกข้าม, ถูกยกเลิก หรือไม่ได้รัน จะพิมพ์ NOT VERIFIED/NOT CONFIRMED โดยไม่อ้างสถานะ canary, attendance หรือ writer และระบุ ABA กับ itemized DETAIL เป็น UNKNOWN ทุกครั้ง

## สิ่งที่พิสูจน์ไม่ได้ (owner ยอมรับความเสี่ยงแล้ว)
- **ไม่เทียบเท่า guard เดิม** การตรวจนี้พิสูจน์ว่า source ของ canary *ตอนตรวจ* เท่ากับตอน G7 เท่านั้น
- **Historical integrity ตั้งแต่ G7 = UNKNOWN**: ถ้ามีการแก้แล้วคืนค่าเดิม (change-and-revert/ABA) ระหว่าง G7 ถึงตอนตรวจ จะตรวจไม่พบ digest ปัจจุบันจึงไม่ใช่หลักฐานว่าไม่มี ABA
- **Itemized DETAIL = UNKNOWN**: canary G7 ไม่มีสินค้า จึงไม่พิสูจน์ DETAIL ของรายการที่มี item
- **Race หลังการอ่าน**: source write หลังการอ่านไม่ถูกกันไว้ ทุกขั้นถัดไป (recheck ก่อน deploy และ snapshot หลัง deploy สองรอบ) คำนวณใหม่ ถ้าพบหลัง deploy เป็นสัญญาณ incident ไม่มี rollback อัตโนมัติ
- **Provider behavior = UNKNOWN จนกว่าจะรัน preflight จริง**: ทดสอบด้วย SQLite ของ Node เท่านั้น; ถ้า D1/wrangler ให้ผลต่าง (syntax, self-test, รูปแบบ envelope) จะ fail closed ก่อน deploy ไม่ใช่ผ่านผิด
- สมมติว่า trigger ยังอยู่ (ตรวจ 27 ตัวใน epoch query); ไม่พิสูจน์ writer ภายนอกหยุด, 429 หรือ accounting parity

ห้ามใช้ข้อยกเว้นนี้กับ G8, G7 รอบอื่น หรือ workflow อื่น ห้าม replay DLQ และ attendance REVIEW ที่ pin ไว้ต้องคงอยู่
