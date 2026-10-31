# MPW backlog และลิงก์ Issue

สถานะทุกงานเป็น BACKLOG; การสร้าง Issue ไม่ใช่ dispatch หรือ release permission. ใช้ [Project Control](../PROJECT_CONTROL.md) ก่อนเริ่มเสมอ

| Task | GitHub | Dependencies | Risk | Effort assumption |
|---|---|---|---|---|
| [W00 — ยืนยัน control, baseline และเงื่อนไขเริ่มโครงการ](W00.md) | [#176](https://github.com/Eak-dev/malipang-shop/issues/176) | none | High governance | 1–2 |
| [W01 — ทำ source/field/LINE inventory และสิทธิ์ข้อมูลเดิม](W01.md) | [#177](https://github.com/Eak-dev/malipang-shop/issues/177) | W00 | High data/privacy | 3–6 |
| [W02 — อนุมัติ architecture, permission และ data/API contracts](W02.md) | [#178](https://github.com/Eak-dev/malipang-shop/issues/178) | W01 | High architecture/security/money | 3–5 |
| [W03 — สร้าง web authentication, sessions และ scoped authorization](W03.md) | [#179](https://github.com/Eak-dev/malipang-shop/issues/179) | W02 | High identity/security | 4–7 |
| [W04 — สร้าง mobile shell และ read-only views ตามสิทธิ์](W04.md) | [#180](https://github.com/Eak-dev/malipang-shop/issues/180) | W03 | Medium UI / High data exposure | 4–7 |
| [W05 — ย้ายงาน Team stock count และข้อมูลสินค้ารายวัน](W05.md) | [#181](https://github.com/Eak-dev/malipang-shop/issues/181) | W04, W13 | High stock integrity | 5–8 |
| [W06 — ย้ายลงเวลาและคำขอแก้ไขจาก LINE มาเว็บ](W06.md) | [#182](https://github.com/Eak-dev/malipang-shop/issues/182) | W04, W13 | High attendance/payroll | 4–7 |
| [W07 — สร้างข้อมูลร้าน ประกาศ และคำขอของพนักงาน](W07.md) | [#183](https://github.com/Eak-dev/malipang-shop/issues/183) | W04, W13 | Medium content/privacy | 2–4 |
| [W08 — สร้าง stock ledger, units และ recipe versions](W08.md) | [#184](https://github.com/Eak-dev/malipang-shop/issues/184) | W05 | High inventory/cost | 5–9 |
| [W09 — สร้างแผนผลิต แผนซื้อ ใบสั่งซื้อและรับจริง](W09.md) | [#185](https://github.com/Eak-dev/malipang-shop/issues/185) | W08 | High quantities/purchasing | 5–9 |
| [W10 — ย้าย expense และ personal ledger เข้าเว็บ](W10.md) | [#186](https://github.com/Eak-dev/malipang-shop/issues/186) | W04, W13 | High accounting/concurrency | 5–9 |
| [W11 — ย้าย HR กะ ค่าแรง และ payroll review/apply](W11.md) | [#187](https://github.com/Eak-dev/malipang-shop/issues/187) | W06, W13 | High money/identity | 5–9 |
| [W12 — ย้ายรายงาน Owner ต้นทุน เงินสด และปิดเดือน](W12.md) | [#188](https://github.com/Eak-dev/malipang-shop/issues/188) | W09, W10, W11 | High financial reporting | 5–9 |
| [W13 — สร้าง operation receipts, audit, recovery และ TEST isolation](W13.md) | [#189](https://github.com/Eak-dev/malipang-shop/issues/189) | W03 | High reliability/security | 4–7 |
| [W14 — ซ้อม migration และพิสูจน์ reconciliation รายหมวด](W14.md) | [#190](https://github.com/Eak-dev/malipang-shop/issues/190) | W05, W06, W13 | High migration/data | 4–8 |
| [W15 — ทำ UAT และเตรียม controlled rollout รายรุ่น](W15.md) | [#191](https://github.com/Eak-dev/malipang-shop/issues/191) | W14 | High release/business | 3–6 active + observation |
| [W16 — ถอน Sheets และ LINE intake ที่ถูกแทนแล้ว](W16.md) | [#192](https://github.com/Eak-dev/malipang-shop/issues/192) | W15, W07, W09, W10, W11, W12 | High retirement/irreversibility | 2–5 active + period observation |

W00–W02 อนุญาตเฉพาะ read-only planning หลังได้รับ task assignment. W03–W16 ยังมี #58 hard gate และ control transition. W15/W16 ไม่อนุญาต release ด้วยการสร้าง Issue. Read the issue's latest body/comments before execution; linked file is versioned planning baseline, not a substitute for later Owner approval.
