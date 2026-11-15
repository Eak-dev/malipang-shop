# Cancellation financial fingerprint — local prototype only

This branch is not deployed, is not wired into the active source readers,
and does not enable PUBLISH, REVOKE, FINAL, cutover, or REVIEW recovery.

The prototype snapshots a cancelled expense and its previous-version VERIFIED
projection/preimage manifest, with a separate monotonic journal revision. A
PUBLISHED marker must name exactly DAILY, RAW, and its `detailCount` DETAIL
records. A STAGED marker may have a partial manifest; that is not evidence
that any provider write is absent. The SQL migration fences modifications to
the cancelled source's projection manifest from cancellation until the source
is removed, including after the REVOKE claim ends. Its intent insert compares
the captured journal revision atomically; other expense journals still work.
The global source revision CAS is retained and can still cause retries or
starvation when unrelated sources change. Positive recovery must re-read the
provider's exact postimage and the same financial fingerprint at a current
revision. Old/third-state/unavailable provider results cannot authorize a new
POST. None of this fences an old provider request already in flight or a
non-cooperating editor.

Tests use synthetic SQLite only. They cover supporting-document independence,
financial and projection drift, missing preimage, wrong identity/version,
PUBLISHED completeness, pre-intent journal-revision drift and continued fence
after claim removal. They do not prove real D1, Sheets, queue, or LINE behavior.

Before any integration: audit all journal and preimage readers and writers;
wire the expense, manifest and journal revision into one D1 transaction and
pass its revision to intent INSERT; enforce schema/trigger integrity; use the
same fingerprint in normal, REVIEW and handoff/final recovery; handle legacy
and partially written STAGED cases without inferring absence; preserve the
fingerprint across every cancel stage; implement a bounded automatic positive
recovery and owner failure notice; and prove legacy-writer drain, provider
postimage, reports, target permissions and production behavior. The existing
0052 document/link freeze still rejects linked evidence during REVOKE and was
not changed. A change there needs an atomic/positive recovery design. The
global revision and inherited notice protocols still race. Migration 0055
adds a column and must be applied only once by the migration framework; it is
not a free-standing idempotent script. Migration ordering/numbers conflict with
other branches and must be reconciled before integration. Do not cherry-pick
or turn on activation until these are resolved.
