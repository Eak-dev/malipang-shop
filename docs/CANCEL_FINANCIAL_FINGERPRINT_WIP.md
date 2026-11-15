# Cancellation financial fingerprint — local prototype only

This branch is not deployed. An opt-in prototype connects normal/REVIEW
source readers to REVOKE intent insertion, but both its configuration flag and
separate D1 activation are off by default. It does not enable PUBLISH, REVOKE,
FINAL, cutover, or the REVIEW worker.

An additional local-only bridge selects a retained REVOKE's digest protocol
from the immutable `financial_journal_revision` column rather than from the
current feature flag; the flag controls new admissions. A mismatched DB
activation and flag refuses new cancellation work. These checks are not a
provider fence and do not make activation reversible. In particular, an older
Worker lacking this bridge cannot process new REVOKEs after DB activation.
Any future rollout must deploy a compatible bridge first and prove the old
generation is drained; rollback must retain dual-protocol readers until all
references have been handled. Do not delete the activation row to bypass it.

Synthetic coverage includes a lost provider acknowledgement followed by
turning the admission flag off and positive-only recovery of that one REVOKE,
and legacy-intent selection after activation. It does not cover the full
notice/FINAL lifecycle, mixed-generation rollout, real D1 or provider behavior.
The prototype adds D1 reads to the budget, which have not been validated across
the worst-case invocation. Keep every production gate closed.

The prototype snapshots a cancelled expense and its previous-version VERIFIED
projection/preimage manifest, with a separate monotonic journal revision. A
PUBLISHED marker must name exactly DAILY, RAW, and its `detailCount` DETAIL
records. A STAGED marker may have a partial manifest; that is not evidence
that any provider write is absent. Once separately activated, the SQL migration
fences changes to a cancelled source's projection manifest only when it has a
publication marker in that workbook, including after the REVOKE claim ends.
Cancelled historical sources without a marker are not frozen. Its intent insert
compares the captured journal revision atomically; other expense journals still
work. Revision triggers are inactive before activation and ignore PERSONAL_USE.
The global source revision CAS is retained and can still cause retries or
starvation when unrelated sources change. Positive recovery must re-read the
provider's exact postimage and the same financial fingerprint at a current
revision. Old/third-state/unavailable provider results cannot authorize a new
POST. None of this fences an old provider request already in flight or a
non-cooperating editor.

Tests use synthetic SQLite and a mocked Sheets provider only. They cover supporting-document independence,
financial and projection drift, missing preimage, wrong identity/version,
PUBLISHED completeness, pre-intent journal-revision drift and continued fence
after claim removal. One mocked REVOKE path tests a single provider transition,
lost acknowledgement followed by positive recovery, and a third state that
stays unresolved without another provider POST. A source-revision change during
a successful mock POST causes the normal path to hold; the standalone positive
recovery helper can confirm the exact postimage without a second POST. Automatic
recovery and the later notice/claim lifecycle are not wired. These tests do not
prove real D1, Sheets, queue, or LINE behavior.

Before any integration: audit all journal and preimage readers and writers;
review the new expense, manifest and journal-revision transactional snapshot
and CAS; enforce schema/trigger integrity throughout; verify the same
fingerprint in normal, REVIEW and every handoff/final recovery path; handle legacy
and partially written STAGED cases without inferring absence; preserve the
fingerprint across every cancel stage; implement a bounded automatic positive
recovery and owner failure notice; and prove legacy-writer drain, provider
postimage, reports, target permissions and production behavior. The existing
0052 document/link freeze still rejects linked evidence during REVOKE and was
not changed. A change there needs an atomic/positive recovery design. The
global revision and inherited notice protocols still race. REVIEW close admits
PUBLICATION only in HANDOFF mode; REVIEW-mode publication recovery has no path
to close the notice, release the claim and resume. Existing legacy sources with
a publication marker must be inventoried before activation: the cancelled
manifest fence may prevent a needed reconciliation. Migration 0055
adds a column and must be applied only once by the migration framework; it is
not a free-standing idempotent script. Migration ordering/numbers conflict with
other branches and must be reconciled before integration. Do not cherry-pick
or turn on activation until these are resolved.
