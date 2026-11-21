# ตรวจสิทธิ์ token แบบอ่านอย่างเดียวสำหรับ #296

Workflow `issue296-token-diagnostic.yml` ใช้ Cloudflare token เดียวกับ protected release workflow เพื่อตรวจ endpoint verify และอ่าน metadata ของ token เฉพาะที่ verify ส่งกลับ โดยใช้ HTTP GET เท่านั้น. ผลแสดงเพียงสถานะ token, การเข้าถึง metadata และว่ารายการ permission group ที่ Cloudflare เรียก `Workers Scripts Write` หรือ `Workers Scripts Edit` และกลุ่ม Workers Admin/Editor ที่เป็นทางเลือกถูกระบุไว้ใน allow/deny หรือไม่; ไม่แสดง token, token ID, ชื่อผู้ใช้หรือ policy ดิบ

การพบ permission group ไม่ยืนยันสิทธิ์ที่ใช้ได้จริงกับ account หรือ Worker เนื่องจากยังไม่ประเมินขอบเขตและเงื่อนไขของ policy. หาก metadata อ่านไม่ได้ให้รายงานตามนั้น ไม่อนุมานว่า token มีหรือไม่มีสิทธิ์. ผลนี้ไม่บอกผลของคำสั่งอัปโหลดก่อนหน้าที่ UNKNOWN และไม่ใช่เหตุให้ส่งอัปโหลดนั้นซ้ำ

Workflow ต้องรันจาก main SHA ที่ระบุ ผ่าน production environment และ concurrency เดียวกับ release. ไม่มีคำสั่ง POST, upload, migrate, deploy หรือแก้ token ในขั้นตรวจนี้
