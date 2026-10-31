# Data model และ API contract proposal

เอกสารนี้ระบุ conceptual entities/contracts ไม่ใช่ executable migrations หรือ API ที่มีแล้ว. W02 ตรวจ schema ล่าสุดและ reuse ก่อนเพิ่มชื่อใหม่ ห้าม migrate จากเอกสารโดยตรง

## Entities and invariants

| Entity group | Identity/important fields | Constraint / lifecycle |
|---|---|---|
| Existing employee/role/binding | canonical employeeId, role, scope, effective status | ไม่ duplicate person; binding verified and unique |
| Web session/module grant | session hash, actorId, expiry, revokedAt, permissionVersion | server-only secret; immediate revocation checks |
| Existing attendance/payroll/wage | event/period IDs, policy snapshots, effective dates | preserve official time, ordering, finalized amounts/history |
| Existing expense/document/items | caseId, submittedBy, branch, evidence links, version | pending ≠ confirmed; case links ไม่ OCR ซ้ำ |
| Existing personal ledger | transactionId, amount, date, wallet class, account identity | unknown historical account retained; not P&L expense |
| Catalog/unit conversion | itemId, baseUnit, countUnit, purchaseUnit, scale, version | no conversion across dimensions; effective/versioned |
| Recipe/version | recipeId, version, inputs, yield, effectiveFrom, status | frozen used versions; authorized readers only |
| Stock count session/line | countId, branch/location, businessDate, itemId, quantity, version | UNIQUE countId+itemId; blank not zero; DRAFT→SUBMITTED→review/correction |
| Stock movement | movementId, item/location, qtyBase, kind, sourceType/sourceId/sourceLine | unique source effect; append reversal, no destructive edit |
| Stock lot/opening balance | source batch, lotId, opening date/qty, expiry if known | unknown expiry not invented; seed once per migration batch |
| Production plan/batch | planId, round/date, recipeVersion, target vs actual yield | plans do not consume; approved actual completion does |
| Purchase recommendation/order/receipt | orderId, lineId, unit snapshot, receiptId, received qty | suggestion≠order≠receipt≠payment; partial receipt/return explicit |
| Daily product observations | date/item/location, opening/incoming/remaining/waste/etc | approved complete fields only; derived sales separately labeled |
| Announcement | id, audience, version, effective/expiry, state | DRAFT→PUBLISHED→ARCHIVED; edit history and sanitization |
| Correction/approval | requestId, target/version, requested value, reason, decision | pending has no financial effect; stale target conflicts |
| Report snapshot/period | periodId, cutoff, policyVersion, completeness, source versions | close uses consistent approved inputs; stale writes fail |
| Operation receipt/audit/intent | operationId, actor, hash, result, before/after, traceId | durable result; append-only audit; independent delivery state |

Quantities ใช้ integer-scaled base units หรือ exact decimals ตาม approved precision; ห้าม float drift และห้ามปัดทุก ingredient ก่อนรวมโดยไม่มีกฎ. Money ใช้ integer satang. Dates: event instant เก็บ UTC; businessDate/cycle/period boundaries ใช้ Asia/Bangkok พร้อม explicit cutoffs. Overnight shift ใช้ approved business-date rule ไม่แยกที่เที่ยงคืนเอง

## Proposed REST surface

Prefix `/api/web/v1`. ทุก endpoint ต้อง schema validate, authorized projection, bounded pagination และ documented error/result semantics. ไม่มี generic SQL/admin proxy API

| Method/path | Permission/scope | Result / write rule |
|---|---|---|
| GET /me | verified session | profile minimum, explicit allowed modules/actions |
| GET /me/attendance, /me/requests | self | cursor results + asOf + completeness |
| GET /team/stock, /team/calendar | approved web grant + branch | only approved team fields; never include cost hidden in JSON |
| POST /uploads | owning domain permission | expiring upload grant and uploadId; not business acceptance |
| POST /attendance/submissions | self write | operation receipt; existing evidence/ordering checks |
| GET /operations/{id} | owner of operation/authorized Owner | durable status/result; no sensitive request replay |
| POST /attendance/correction-requests | self Q | request-only, target/date/reason, no punch apply |
| POST /stock/counts | branch + create | draft identity, catalog/unit version snapshot |
| PATCH /stock/counts/{id} | owning scope + writable status | If-Match required; mismatch 409, no overwrite |
| POST /stock/counts/{id}/submit | submit scope | atomic validate+freeze; replay returns same result |
| POST /stock/adjustments | explicit correction/approval | reason + source count + prior version; new movement |
| GET/POST /owner/recipes, /owner/purchases | domain grant + scope | versioned recipe/order; receipt is separate command |
| GET/POST /expense-cases | actor ownership/branch + canSubmitExpense | reuse domain parser/review rules; no client authority |
| POST /expense-cases/{id}/actions | actor/action + case version | confirm/cancel/undo according to approved contract |
| GET/POST /owner/personal-transactions | Owner + ledger grant | preserve #163–#169 approved contracts |
| POST /owner/payroll/preview, /apply | Owner + approved policy | preview read-only must be proven; apply checks preview digest/current inputs |
| POST /owner/periods/{id}/close | Owner + reauth + version | atomic period/ledger version checks; no concurrent late Confirm |
| GET /owner/reports | specific report grant | amounts, asOf, completeness, policyVersion, provenance |
| POST /owner/announcements/{id}/publish | manage + audience | versioned publish; no automatic external message |
| POST /owner/members/{id}/grants | Owner + reauth | before-after approval, audit, revoke affected sessions |

Read-only phase implements GET subset only. Planned POST paths do not imply permission to run them. New endpoints must not call a nominal preview that actually writes jobs/financial records without explicit semantics and permission

## Common request/response

Writes require `Idempotency-Key` scoped to actor+operation and normalized payload hash. Same key+same payload returns original receipt; same key+different payload returns 409. `If-Match`/expectedVersion protects mutable drafts/config. Mandatory business uniqueness remains effective after operation-key expiry. Idempotency retention duration is a reviewed config, not guessed from LINE limits

Synthetic receipt example:

```json
{
  "operationId": "op_example",
  "state": "PROCESSING",
  "businessCommitted": false,
  "recordId": null,
  "version": null,
  "asOf": "2026-09-08T01:00:00Z",
  "sideEffects": [],
  "traceId": "trace_example"
}
```

202 means accepted for processing, not finalized. A later terminal result contains authoritative record/version. 200 replay does not execute domain effect again. GET may return `complete:false` and reason for incomplete reports; it must not convert UNKNOWN to zero

| Status | Code example | Behavior |
|---|---|---|
| 401 | SESSION_REQUIRED/EXPIRED | no write; log in, recover operation result |
| 403/404 | FORBIDDEN/NOT_FOUND | consistent non-enumerating resource policy |
| 409 | VERSION_CONFLICT/IDEMPOTENCY_MISMATCH/PERIOD_CHANGED | no side effect; fetch current permitted record |
| 413/415 | UPLOAD_TOO_LARGE/UNSUPPORTED_MEDIA | no business commit |
| 422 | VALIDATION_FAILED/EVIDENCE_REJECTED | localized safe field/reason codes |
| 429 | RATE_LIMITED | bounded client retry guidance; retain operation identity |
| 503 | TEMPORARILY_UNAVAILABLE | do not say failed if commit outcome unknown; query receipt |

## Atomicity and concurrency proof obligations

- Count submit/correction: version+status CAS with audited effect in one atomic boundary; no movement if CAS changes zero rows
- Expense/ledger: Confirm/Undo/close share period/status/version constraints; service and SQL proof required, not frontend check-then-write
- Payroll apply: preview references exact input/policy versions; changed wage/attendance/period invalidates preview; duplicate apply cannot pay twice
- Purchase receive: per source receipt-line uniqueness and cumulative received checks under concurrency; no double stock or automatic payment
- Reconcile/projection rebuild: no new business transaction or audit pretending a second user action
- Pagination totals: deterministic ordering/tie-breaker plus cutoff/version snapshot; no silent missing rows while paging changing datasets

## Calculation boundaries

Stock closing balance = approved opening + signed committed movements. Physical count is an observation; variance=count−ledger snapshot, adjustment is separate approved movement. Production actual use and theoretical recipe use remain separate to avoid double consumption. Estimated procurement uses confirmed usable stock, allocated use, outstanding orders, lead time, pack rounding and approved buffer; missing input returns incomplete recommendation

Derived sold quantity uses only approved mapped inputs (opening + incoming − closing − waste ± returns/transfers as applicable). Never assume absent columns mean zero. Actual revenue/cash uses verified prices/promotions/payment records; no default 39 THB from an old image. Valuation, tax, payroll deduction, waste accounting and period reversal rules come from approved policy before financial rollout
