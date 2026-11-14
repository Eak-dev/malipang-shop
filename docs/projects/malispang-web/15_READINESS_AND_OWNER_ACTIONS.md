# Readiness — Codex ตรวจเองและเสนอเฉพาะสิ่งที่ Owner ต้องทำ

Owner ไม่ต้องจัดรายการซอฟต์แวร์/ฮาร์ดแวร์หรือเช็กบัญชีทั้งหมดเอง. W00 เป็นเจ้าของ readiness register; W01 ตรวจข้อมูล/LINE flows; W02 ตัดสิน technical design และจัด Owner packet; W13 พิสูจน์ TEST/operations; W15/W16 ตรวจ deployment/retirement readiness ใหม่ก่อนใช้จริง

## Status model

VERIFIED = ทดสอบความสามารถที่ต้องใช้จริงใน environment นี้แล้ว; MISSING = พิสูจน์ว่าไม่มี; INACCESSIBLE = มีหรืออาจมีแต่สิทธิ์/การเชื่อมไม่พอ; UNKNOWN = ยังไม่มีหลักฐาน; NOT_REQUIRED = ไม่จำเป็นต่อ scope พร้อมเหตุผล. มีชื่อ dependency ใน package.json ไม่เท่ากับติดตั้งแล้ว; มี connector ไม่เท่ากับอ่านไฟล์เป้าหมายได้; มี secret name ไม่เท่ากับ credential valid

## สิ่งที่ตรวจได้จริงในรอบออกแบบคำสั่ง — 2026-09-08

| Item | Observation | Status/limit |
|---|---|---|
| Local Node | v24.19.0; repo engine >=22 | VERIFIED version constraint; lockfile/build compatibility ใช้ CI/local test แยก |
| Local npm / Git | 11.9.0 / 2.51.1 | VERIFIED available; npm warns about existing http-proxy env config, ไม่ใช่หลักฐานว่าต้อง upgrade |
| GitHub repo/PR/issues | อ่าน main/#58/#175/#193 และ related tasks ได้ | VERIFIED read; previous planning round proved docs/Issue writes; no cloud deploy authority inferred |
| Current main / planning head | main 597b8d0f…; pre-update docs a934ae47… | VERIFIED source snapshot, not current Production |
| TS / Wrangler | repo pins 5.8.3 / 4.28.1 | VERIFIED declaration only; do not upgrade automatically |
| Browser executables in shell PATH | playwright/chromium/google-chrome not found by command discovery | NOT_FOUND_IN_PATH; browser tools/service or package-local installation still UNKNOWN |
| Google connector | callable tools advertised | access to exact three files NOT_TESTED in this prompt-authoring round |
| #58 | OPEN on GitHub | VERIFIED implementation gate remains |
| Cloudflare/LINE account, TEST resources, billing | not inspected authenticated environment | UNKNOWN; no claim of readiness/missing hardware |
| Physical phones/camera/shop network | no live device test this turn | UNKNOWN; user screenshots do not prove end-to-end UAT |

## Complete checklist for execution

| ID | Requirement and phase | How Codex verifies | Remedy/Owner-only action |
|---|---|---|---|
| SW01 | Git/canonical repo and write scope, W00 | read repo/branches, clean worktree, safe remote; authorized docs/PR write proof | repair isolated workspace; Owner connects app only if account consent missing |
| SW02 | Node/npm/TypeScript/Wrangler, W00/W03 | inspect engines/lockfile/scripts, versions, dependency resolution | install pinned local packages within authorized scope; no global upgrades |
| SW03 | Network/package registry, W00 | bounded connectivity/install failure classification without secret output | distinguish network/allowlist/auth; request specific permission only after supported path fails |
| SW04 | Browser execution and screenshots, W04 | discover supported browser tools, start isolated local app and visit | install supported test runtime when allowed; cloud rendering is not physical device proof |
| SW05 | CI/review/merge permissions, W00/W15 | inspect workflows, last runs, app scopes and protected branch capabilities | ordered review/merge packet; no require-admin workaround |
| CL01 | Cloudflare account/resource ownership, W00 | authorized read of worker/D1/R2/queues/config and billing status; sanitize IDs | correct account connection; do not recreate V5.2 resources from old setup guide |
| CL02 | TEST separation, W13 | verify distinct binding IDs, channel/provider config, keys and allowlists without dumping values | prepare exact resource plan; provision only in approved TEST scope/budget |
| CL03 | D1/Queues/R2 compatibility/limits, W02/W13 | current official limits and measured reads/writes/upload sizes/retries | derive min/likely/max need; no purchase until bottleneck proven |
| CL04 | Hosting/HTTPS/routes/domain, W04/W15 | inspect existing hosting; verify TLS, redirect/callback origins, allowed API paths | use approved platform subdomain first if suitable; custom domain optional, paid registration needs consent |
| CL05 | Backup/restore/recovery, W13/W14 | private export/readback/checksum/isolated restore/integrity/FK and timed recovery under authority | prepare secure backup target/retention; no backup in public GitHub |
| ID01 | LINE OA ownership, W01 | inventory actual messaging channel/webhook/rich menus using supported access | Owner login/2FA if necessary; don't change webhook to test access |
| ID02 | LINE Login/LIFF, W02/W03 | channel/provider subject mapping, redirect URLs/scopes, token validation, browser/iOS flows | prepare exact config and owner consent; missing Login channel doesn't mean OA must be replaced |
| ID03 | Owner recovery and employee identities, W03 | canonical bindings/active roles, tested recovery without actual privilege escalation | verified Owner consent only; never infer staff IDs from display names |
| DA01 | Three source files and grants, W01 | exact file metadata/tabs/protections/read ranges using applicable connector | ask to grant read access only to inaccessible source; don't ask owner to retype all contents |
| DA02 | Config/formula/prices/recipes/history, W01 | field mapping/source timestamp/conflict table, private source lineage | one evidence-based decision packet for true unresolved policies |
| DA03 | LINE-only shop work, W01 | code route + menu/settings + existing sanitized flow evidence | ask only about unmapped actual flow; not generic repeat of requirements |
| AI01 | Existing AI configuration and TEST usage, W13 | presence/scope/approved model and billing access without displaying values | use mocks first; follow credential skill before any API calls; consent/budget for TEST live calls |
| HW01 | Employee phones, W04/W15 | supported iOS/Android browser and LINE version, upload/camera/permissions, numeric keyboard, display/zoom | existing phones first; owner/tester taps camera/2FA when required |
| HW02 | Shop Internet, W15 | actual HTTPS/login/upload reliability on shop connection; simulate disconnect/reconnect | test existing hotspot fallback; router purchase only after measured deficit |
| HW03 | Attendance evidence method, W06 | existing timestamp+GPS overlay/photo-age/radius and official-time policy on device | retain present approved process; no new clock/QR scanner mandated by web migration |
| HW04 | Shared counter terminal, optional | only if actual workflow requires one; verify logout/account switch/privacy | tablet/PC optional; do not buy because mobile web exists |
| HW05 | Scales/printers/barcodes, optional | manual approved quantity entry first; integration only if separately scoped | no new Bluetooth scale, receipt printer or barcode scanner required for initial scope |
| HW06 | On-site server/NAS/GPU/CCTV | cloud web design has no continuous local compute dependency | NOT_REQUIRED for MPW baseline; OpsLens/CCTV is another project |
| OP01 | User guides/support/runbooks, W15 | role-specific tasks and error recovery tested with approved testers | Codex prepares screenshots/scripts; asks Owner only to accept actual workflow |
| OP02 | Cost/budget, W02/W15 | current official prices + account usage + pilot measurements | no made-up monthly price; show ceiling and required purchase decision |
| OP03 | Final rollout/retirement, W15/W16 | exact candidate/version/data parity/rollback/observation/dependencies | one concrete GO packet per material release; not broad future authorization |

No new on-site hardware is required by the chosen architecture itself. Actual existing phone/network suitability must still be tested. Development compute is the available Codex environment; do not instruct Owner to buy a new laptop just because a local browser executable is absent

## Agent-maintained readiness row

Record ID, phase/module, requirement, mandatory/optional, observed state/version, environment, checkedAt, evidence reference, status, root cause, remedy already attempted, cheapest adequate option, cost verified/unknown, actor who can fix, deadline/gate, revalidation method and related task. The register is an execution deliverable, not a dummy PASS checklist

## Owner Action Packet

Only after bounded discovery and reversible fixes, send one table per gate:

| ID | Owner action | Why agent cannot do it / evidence | Exact steps prepared | Recommended choice/cost/impact | Success signal | Work that continues meanwhile |
|---|---|---|---|---|---|---|
| example | approve account consent | authenticated API returned required-consent state | connector sign-in link and least required scope | existing account; no new subscription | exact target read succeeds | finish API/mapping design |

Do not put secret values or private account details in public packet. A login/2FA step cannot be performed by pretending the agent owns the account. A paid purchase, financial policy or production GO must be explicit. Existing valid authorization remains usable; only new/materially changed target/scope asks again

## Blocker triage

Detect → reproduce safely → classify permission/network/missing capability/policy/data → use supported authorized alternative → record attempted remedies → complete unaffected allowed work → send specific Owner packet if necessary. Do not evade access controls, use forbidden browser fallbacks, create fake evidence or soften #58/AC to make progress look complete
