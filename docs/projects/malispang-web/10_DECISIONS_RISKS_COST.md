# Decision, risk และต้นทุน

## Decision register

ข้อเสนอด้าน engineering ใช้เป็น baseline ออกแบบได้; business/security decisions ที่กระทบสิทธิ์หรือเงินต้อง review ก่อนเปิดใช้จริง. ไม่ต้องให้ Owner ตัดสินชื่อไฟล์/helper

| ID | Decision / recommendation | Status | Owner / deadline |
|---|---|---|---|
| D01 | เว็บมือถือแทนสามไฟล์และ LINE หลังบ้าน; ย้ายเป็นหมวด | USER_REQUESTED direction | product scope review W02 |
| D02 | เก็บเอกสาร/งานย่อยบน GitHub | AUTHORIZED 2026-09-08 | planning task |
| D03 | repo เดิมแยก frontend package, backend services ร่วม | PROPOSED engineering baseline | W02 |
| D04 | Team stock fields เท่าขอบเขตเดิม + approved self-service; no owner fields | USER_CONSTRAINT; exact field mapping pending | W01/W02 |
| D05 | preserve existing role grants; web exposure separate, payroll web default off | PROPOSED compatibility handling | Owner W02 ก่อน W03/W11 |
| D06 | LINE Login + browser/LIFF; provider mapping and recovery verification | PROPOSED, settings UNKNOWN | W02/W03 |
| D07 | attendance overlay/radius/photo-age/ordering policy เดิม | VERIFIED SOURCE CONTRACT; no change proposed | W06 parity |
| D08 | stock opening balances, unit precision, recipe/yield source | UNKNOWN/CONFLICTS | Owner after W01 evidence, before W08 |
| D09 | buffer/lead time/round schedule/pack rules | APPROVED CURRENT SOURCE REQUIRED | W09 |
| D10 | valuation, recognition/rounding, reversal/period policy | REQUIRED FROM current approved config/#164 | W10/W12 |
| D11 | retention/deletion | PRESERVE EXISTING; new lifecycle pending review | W13/W16 |
| D12 | session 30min idle/12h absolute, 5min sensitive reauth | PROPOSED security/usability | W02/W03 |
| D13 | RPO 0 acknowledged writes / recovery ≤4 operating hours | PROPOSED business targets, not guaranteed | measured evidence W13, Owner before rollout |
| D14 | host/domain/TEST resource IDs/budget | UNKNOWN configuration | W02/W13, exact GO before hosting |
| D15 | #58 implementation gate | EXISTING OWNER DIRECTION, remains | W00 before any implementation |

D08–D10 block only affected calculations/writes, not completion of this planning package. Developer gathers evidence and delivers a single concrete decision packet with current/proposed/delta/risks/recommendation instead of asking Owner to retype all known policies

## Risk register

| Risk | Impact | Mitigation / evidence owner |
|---|---|---|
| Treat UI migration as permission grant | payroll/cost/PII leak | W01 field allowlist + W03 negative projections |
| Role hierarchy conflated with Team label | wrong rights/revocation | keep canonical roles, scoped web grants, audited transition |
| Missing/optional resource scope in authorization | cross-employee/branch access | require DB-resolved scope; T02 |
| Dual writer or repeated import | overwritten/new stock or wages | migration epoch/writer fence and T18 |
| Cross-channel duplicate | attendance/expense doubled | domain identity+receipt+safe ambiguity review |
| Snapshot across sheets changes mid-copy | hidden partial import | cutoff/delta manifest; full reconciliation |
| Blank or fixed stock becomes actual | wrong buying/cost | typed actual/plan/config/unknown classification |
| Old formula/price/policy assumed current | wrong revenue/cost/payroll | provenance/versions/Owner decisions |
| Browser GPS considered proof | false attendance | preserve approved image evidence; no unapproved replacement |
| Audit/outbox not atomic | lost notification or unreconstructable commit | fault-injected transactional proof W13 |
| Existing hardening evolves | incompatible web schema | pinned design baseline + rebase/revalidate contracts |
| Cheap UI scope expands to POS/AI/marketing | delay/cost inflation | explicit exclusions; backlog only |
| Public GitHub contains private data | confidentiality loss | synthetic examples; private detail evidence; pre-push scan |
| Rollback overwrites newer records | irreversible business loss | delta-preserving drill and forward-fix plan |

## Cost model — no unverified vendor price claim

ไม่ใส่ราคาบริการรายเดือนที่ยังไม่ได้ตรวจ billing/usage ของบัญชีจริง. เว็บไม่ได้ฟรีเพียงเพราะใช้ backend เดิม และการเลิก Sheets ไม่ได้ลดต้นทุนทันทีหากยังต้องดูแลสองระบบระหว่างย้าย

Monthly incremental cost = frontend hosting/domain amortization + incremental Worker requests/CPU + D1 reads/writes/storage + R2 storage/operations + queue operations + monitoring/backups + optional LINE outbound + incremental AI image processing

| Driver | Measure in TEST/pilot | Control |
|---|---|---|
| Headcount/usage | approved active users × sessions × actions/day | scoped reads/pagination; avoid polling all reports |
| Stock | count lines/day + actual movements + report queries | batch submissions/indices; no write per keystroke |
| Evidence | uploads/day × mean bytes × retained days | duplicate checks, approved lifecycle, no public image copying |
| AI | classified images × calls/retries × model usage | reuse existing results; form inputs need no AI |
| Queue/integrations | intents/retries/lag and retained jobs | fix root cause; avoid indiscriminate replay |
| Support | minutes/day spent correcting/recovering | receipts/clear status and operator runbook |

Value calculation: labor time saved per month × owner's chosen value/hour + measured reduction in waste/error − incremental recurring costs − implementation cost amortization. Do not count hypothetical sales increases as guaranteed benefit

Budget before rollout: W02 estimate min/likely/max using observed usage and current official rates; Owner sets ceiling; W13 sets observable alerts below that ceiling. Existing provider credentials/AI billing never printed, rotated or reused for new TEST workloads without appropriate authorization

## Model selection

PO/PM architecture/permission/migration review: GPT-6 Astra, Thinking High. Dev critical identity/money/concurrency/migration: GPT-6 Astra, High. Bounded UI/content after accepted contracts: GPT-5.6 Sol, Medium; upgrade to Astra High when contract/risk changes. Availability checked from this session's advertised model options; this is guidance, not a claim that a model switch was performed

ChatGPT/PO-PM, Codex Developer and AI model of LINE bot are three separate settings. No task in this planning package authorizes changing the bot model. Token targets are not billed-cost promises; measure actual work rather than advertise a percentage saving
