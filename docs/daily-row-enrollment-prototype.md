# Daily expense identity enrollment: prototype protocol

This document describes missing integration, not a procedure that has run. No
production approval key, approval record, fence enforcement, enrollment write,
or authenticated manifest source is supplied by this prototype. A signature
proves who signed bytes, not that a human reviewed them or that the underlying
mapping is true. Never call this code as a stand-alone write authorization.

1. Assemble a mapping proposal from authenticated D1 expense records and an
   independent, bounded Sheet observation. Include spreadsheet and sheet IDs,
   exact row, expense ID and version, posting date, amount in integer satang,
   payment, source wallet, status, category, description and message ID, a unique proposed metadata ID, complete A:Y literal manifest,
   independently approved formula manifest and header digest. Preserve any
   existing metadata; detect all document-visible row markers and the current
   Google project's project-visible markers. Check proposed metadata IDs using
   direct metadata GET. Check existing D1 mappings and reserve expense IDs,
   row coordinates and metadata IDs with persistent uniqueness constraints.
   Search is not proof about project-visible metadata belonging to other Cloud
   projects; resolve or explicitly exclude that possibility operationally.
2. Resolve ambiguity from independent source records or explicit owner review
   of the specific expense-to-row mapping and full displayed row context. An
   approval of a category change does not itself approve a row mapping. If two
   identical rows cannot be distinguished, hold both; appearance, position,
   matching amounts, or an existing unverified D1 row number cannot decide.
3. During a time-bounded maintenance window, independently block all automated
   Sheet writers and pause human editing. The spreadsheet owner can override
   protected ranges. Snapshot original protections, provision strict temporary
   protection of exactly the input cells, and verify it by a fresh API read;
   do not require permanent whole-sheet protection. Other writers, triggers,
   imports, scripts and administrator edits also need exclusion. If any cannot
   be excluded, abort. These measures require real integrations not present here.
4. A trusted approval service, separate from the Worker that verifies it, shows
   the mapping and full manifest to an authorized reviewer, records consent and
   signs the canonical approval using a private Ed25519 key unavailable to the
   Worker. The verifier receives a pinned public key from protected deployment
   configuration bound to that reviewer, freshly authenticated D1 records, the live maintenance lease
   and time from trusted services, never request-supplied values. It must consume
   the approval ID transactionally exactly once; the prototype verifier does
   not provide persistent replay protection, key management, revocation or UI.
   Here the signed approval is lease-specific and expires within 15 minutes.
5. While maintaining the exclusive fence, re-read and compare the exact target
   row, the full metadata search, sheet identity, formula manifest, headers and
   input protections to the signed proposal immediately before enrollment. This
   pre-enrollment observation is not implemented: the existing observer needs
   a marker that does not exist yet. Abort for any mismatch or missing evidence.
   Create document-visible row metadata only for the individually approved
   rows using a unique proposed ID; do not overwrite cells. An uncertain or
   timed-out create requires a fresh full read and reconciliation, not blind
   retry. The external no-human-edit interval must cover the entire operation.
6. Re-read every marker by ID and by complete document-visible search, verify
   uniqueness and the same signed row values with `observeExistingDailyRow`,
   then atomically persist the exact mapping, approval ID, snapshot digest and
   audit events in D1 under the still-current lease. D1 and Sheets do not share
   a transaction; crash recovery must retain the fence and resolve intermediate
   states rather than assuming success or rolling back blindly. Record whether
   the metadata was preexisting and never delete another actor's marker.
7. Before the separately authorized expense correction, revalidate the fence,
   D1 version, marker, protections and signed preimage. Update only approved
   input cells, then read back the separately authorized postimage. Restore the
   exact original protections and verify restoration before ending maintenance.
   Resolve any interrupted restoration before allowing ordinary work to resume.

The signed approval verifier currently checks only the signature, payload shape,
in-batch uniqueness, freshness, exact lease values, and the signed transaction identity,
CONFIRMED status, category, description, payment, wallet, message ID and other selected fresh D1
fields and approved accounting period. The caller is responsible for trusted clock and data sources, global
uniqueness, one-time consumption, reviewer authority, actual row observation,
protection and fence lifecycle, metadata creation, recovery and audit. In
particular, there is no Google Sheets compare-and-swap: double reads and range
protections alone cannot guarantee owner-edit exclusion.

### Read-only authenticated inspector

`inspectSignedExistingRow` combines the Ed25519 approval verifier with direct D1 reads before and after two authenticated Sheets observations. It independently compares the observed date, description, resolved payment column, amount, empty alternative payment columns, category and wallet to that D1 record. It pins the reviewer public key, reviewer identifier, spreadsheet, sheet ID and approved month to worker-side configuration. It processes a single entry per call and returns only `CONSISTENT_READ_ONLY` or `HELD`. Tests use a mocked D1 and Google transport and do not establish that a production identity key was provisioned or that a live human reviewer validated the row. A successful result **must never authorize a write**: the lease attributes are only signed data, there is no live lease authority or approval consumption, and nothing prevents owner edits, ABA changes, unversioned or in-flight mutations. Pinning a public key is meaningful only after independently authenticated registration of the private key holder, which this code does not provide. Existing rows lack independently established metadata and manifests; this code does not create or attest them. There is no current safe integration with a real writer.

The authenticated admin `POST /admin/sheets/daily-row-inspection` exposes the
same **observation only**. It is disabled unless `DAILY_ROW_INSPECTOR_ENABLED`
is exactly `true`; an absent, invalid, or mismatched reviewer key, reviewer ID,
sheet ID, approved period, approval, or evidence produces `HELD`. The caller
submits `{approval, signature}` with a canonical base64 Ed25519 signature. A
bounded request is limited to 32 KiB, and every enabled response contains
`releasePermitted: false` and `Cache-Control: no-store`. Neither response
contains signed input, personal data, IDs, or source values. This route performs
no D1 mutation, metadata enrollment, queue send, or Sheet write. Disable it
after a controlled review. Do not enable or provision a reviewer key in
production until key registration, protection, identity and writer-exclusion
steps above have been reviewed and a controlled test environment exists.

### Provisional candidate staging (not enrollment)

The separately gated `POST /admin/sheets/daily-identity-candidate` adds a
`CANDIDATE_ONLY` evidence record after the signed observation; both inspector
and staging flags must be explicitly enabled. It checks the live D1 sheet fence
before observing, and atomically rechecks fence ownership, unexpired signed
approval, the complete expense snapshot, REVIEW status, no active sync and
index conflicts before staging. Unique indexes prevent active candidate
collisions; a retained approval ID prevents replay after expiry. The D1 row
stores hashes rather than signed payload, signature or message ID. It does not
store a verifiable reviewer archive: an independent private approval service
and registered keyholder are still needed. No active mapping, metadata write,
queue message, or REVIEW release is created.

If the staging response is lost or says `HELD` after a possible database
commit, send the same signed payload to the read-only
`POST /admin/sheets/daily-identity-candidate-status`. It compares the exact
approval, signature and pinned-key digests and returns only `CANDIDATE_ONLY`,
`EXPIRED`, `NOT_OBSERVED` or `UNAVAILABLE`, always with
`releasePermitted:false`. A negative or unavailable read is not proof that a
possibly in-flight commit failed; do not blindly repeat a mutation. The route
does not re-observe Sheets or assert the candidate remains accurate.

This is deliberately not an identity registry or recovery authorization.
Sheet reads are not atomic with D1; an ABA edit or old writer may change the
Sheet without participating in the fence. The lease version in the signed
payload has no independent version source. A provisional candidate therefore
cannot be used to write, release a hold, or prove a historical row identity.
Keep both gates off in production until writer exclusion, approval issuance,
key registration, controlled shadow tests and recovery have been reviewed.
To roll back a future deployment, disable both flags or revert code; the
additive candidate table can remain as private audit evidence. Do not delete
or change candidate records to resolve business data. Reconcile any in-flight
work separately. Migration `0022` has not been applied to production.
