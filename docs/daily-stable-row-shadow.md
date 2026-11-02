# Daily stable-row identity: UAT prototype only

**Not production-ready.** The existing production worker is unchanged. The
prototype can run only in `shadow` with its flag enabled, an explicitly
allowlisted non-production spreadsheet, a distinct configured production
spreadsheet ID, a separately provisioned UAT database marker, an attested
exclusive editing window, and one synthetic, independently verified new
expense ID. The marker table is deliberately not in the migration; create it
only in an isolated synthetic UAT database. Configuration comparisons and an
attestation are not a technical proof that no human or older worker can write.

New entries carry an expense key in column X and a unique numeric metadata ID
attached to the row. D1 stores that metadata ID, never a row number. A D1
`IN_FLIGHT` intent is inserted before the atomic Sheets batch and never
expires by elapsed time. A missing ID or metadata after an uncertain outcome
must be reviewed; deleting a row deletes its metadata, so fixed metadata IDs do
not make blind retries safe. Existing rows without independently established
identity are held; name, date and amount equality alone is not identity. For
newly enrolled rows the journal retains the exact trusted input preimage and
projected version, so a later version can be checked before updating through
the stable metadata ID. A same-version replay is verified without a write.

For a blank row, the prototype selects the first blank after the last occupied
business row in the current month and writes only owned cells and missing
verified helper formulas. When full, one Sheets batch inserts a row immediately
above the current subtotal, writes inputs/key/helper formulas, extends 15
preflighted subtotal formulas and creates metadata. Only the exact documented
SUMIF subtotal and helper patterns are supported; other layouts are held.
Raw/purchase/personal/payroll mirrors still have their own index-based paths.

Google Sheets QA on a synthetic fixture demonstrated that whole-row sort and
row insertion move metadata with the row, partial-range sort can separate the
business fields from the key, inserting before the subtotal does not
automatically expand SUMIF, and reusing the same metadata ID rejects a repeat
batch while metadata remains. Deleting the row removes metadata and permits a
later same-ID batch again. These are not proof that partial sorts of identical
transactions are detectable or that writes are safe with concurrent editors.
The `values:batchUpdateByDataFilter` transport has not been tested against the
real Google API with this service account. Local SQLite and Google API mocks are
not production UAT. Cloudflare D1 synthetic creation returned
`INVALID_ARGUMENT` and is not counted as a passed cloud D1 test.

The prototype is not connected to the runtime queue. The admin-only endpoint
`POST /admin/uat/daily-stable-row` accepts no expense ID from the request; it
uses only the configured synthetic ID and applies all UAT guards before any
Google write. It returns 404 outside shadow/when disabled and never exposes
identity or spreadsheet contents in its response. The UAT marker table must
only be provisioned in the dedicated synthetic D1; it is not created by the
migration. Queue durable hold, operator alert and recovery must be implemented
and proven before any queue integration. Retry/DLQ retention alone is not a
durable hold.

Before any rollout, independently prove writer/legacy request cutover, a
Google-side atomicity protocol for human changes, metadata quota/collision and
recovery behavior, all-month formula compatibility, authenticated identity
enrollment for old rows, end-to-end Google and D1 UAT, and rollback/reconcile.
Do not turn on the prototype flag in production. The current conservative
automatic-capacity hold remains in place when the prototype is disabled.
