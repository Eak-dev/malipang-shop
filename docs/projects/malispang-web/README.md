# MalisPang Operations Web — แผนเปิดโครงการ

Version 1.1 • 2026-09-08 • [Epic #175](https://github.com/Eak-dev/malipang-shop/issues/175)

เว็บหลังบ้านมะลิปังสำหรับมือถือ รวมงานจาก OWNER_MASTER, STOCK_MASTER, StockCheck_TEAM และ LINE OA หลังบ้าน เพื่อให้พนักงานทำงานง่ายขึ้นและ Owner ตรวจข้อมูลได้จากระบบเดียว ปลายทางไม่ต้องใช้ Sheets เป็นหน้าทำงานหรือตัวคำนวณ แต่เก็บประวัติที่จำเป็นตามนโยบายเดิม

**สถานะ: แผนสำหรับ review และเปิดโครงการ ไม่ใช่ implementation/release approval.** เงื่อนไข #58 ยังต้องผ่านก่อนเริ่ม V2 implementation; การตั้งชื่อโครงการใหม่ไม่ได้ยกเลิกเงื่อนไขนี้

**เริ่มด้วย [คำสั่งหลักจนเว็บใช้งานจริง](14_EXECUTION_MANDATE.md)** ให้ Codex ตรวจ [ซอฟต์แวร์/บัญชี/อุปกรณ์และ Owner actions](15_READINESS_AND_OWNER_ACTIONS.md) เอง และเก็บ [checkpoint](16_EXECUTION_STATE.md) เพื่อทำต่อภายใต้ program mandate โดยไม่ต้องเขียน prompt ใหม่ทุก Issue. รอบนี้อัปเดตคำสั่งและแผนเท่านั้น ยังไม่ dispatch runtime work

## อ่านตามหน้าที่

| ผู้อ่าน | เริ่มที่ | ผลลัพธ์ |
|---|---|---|
| Owner | [Charter](01_CHARTER.md), [หน้าจอ](04_MOBILE_UX.md), [Roadmap](09_ROADMAP.md), [Decision register](10_DECISIONS_RISKS_COST.md) | เห็นขอบเขต รุ่นแรก ลำดับลงทุน และจุดตัดสินใจ |
| PO/PM | [Project Control](PROJECT_CONTROL.md), [หลักฐาน](02_BASELINE_AND_INVENTORY.md), [Backlog](tasks/README.md) | จัดคิวโดยไม่ชนงานเดิม |
| Developer | [Kickoff](11_CODEX_KICKOFF.md), control, Issue ที่ได้รับมอบหมาย, [สถาปัตยกรรม](05_ARCHITECTURE.md) | เริ่มหนึ่งงานด้วย baseline และ DoD ชัด |
| Reviewer | [สิทธิ์](03_PERMISSIONS.md), [Data/API](06_DATA_AND_API.md), [UAT](08_VALIDATION_OPERATIONS.md) | ตรวจความถูกต้องและกรณีผิดพลาด |
| ผู้ย้ายระบบ | [Migration](07_MIGRATION_CUTOVER.md), source inventory, UAT | ย้ายทีละหมวดพร้อมหลักฐานและ rollback |

## เอกสารและสถานะการพิสูจน์

- แผนออกแบบและ work packages อยู่ใน GitHub; ยังไม่มีเว็บหรือฐานข้อมูลใหม่ถูกเปิดใช้งาน
- [Validation report](12_PLAN_VALIDATION.md) แยกการตรวจเอกสารออกจากการทดสอบ runtime
- [Requirement traceability](13_REQUIREMENT_TRACEABILITY.md) เชื่อมทุกข้อกำหนดกับงานและหลักฐานรับงาน
- จำนวน 139 แท็บเป็นข้อมูลจากการสำรวจในบทสนทนาก่อนหน้า ไม่ใช่ผลตรวจสดครบทุกเซลล์ของรอบนี้
- ไม่มีการคัดลอกข้อมูลร้านจริงหรือภาพหลักฐานส่วนตัวมาลง repository สาธารณะ
- ใช้ชื่อแสดงผลภาษาไทย “มะลิปัง” และชื่อโครงการ MalisPang Operations Web; ไม่ rename infrastructure เดิม

## สิ่งที่ต้องไม่เข้าใจผิด

1. D1 มี Attendance/Payroll/Expense อยู่แล้ว แต่ไม่ได้แปลว่า Stock/สูตร/รายงาน Owner ทุกส่วนย้ายเข้า D1 แล้ว
2. การย้ายหน้าจอไม่อนุมัติการเปลี่ยนหลักฐานลงเวลา สูตรค่าแรง หรือการเปิดเผยข้อมูลเพิ่ม
3. “ขายได้” ที่คำนวณจากจำนวนสินค้าไม่ใช่ยอดรับเงินจริง; รายงานต้องแยก actual/derived/plan/unknown
4. LINE และเว็บเป็นช่องทางเข้าถึงบริการร่วมกัน ไม่ใช่สองบัญชีธุรกรรม
5. #45 ปิดแล้วแต่ไม่ได้พิสูจน์ว่า Board ถูกสร้าง; ต้องตรวจ code/evidence และ replan

เริ่มงานถัดไปด้วย W00 ตรวจ gate และ W01 ทำ inventory แบบอ่านอย่างเดียว; งานเขียนโปรแกรมทุกตัวรอ control transition ที่มีหลักฐาน
