# Invocation binding budget — local prototype only

The PUBLISH runtime gate remains closed. This local-only prototype wraps D1
and queue bindings for an expense message when publication is enabled and
either it is the only message, or valid pacing selects it from a workbook-only
batch whose other messages were parked successfully. The latter conservatively
charges three D1 calls for target lookup, fairness and parking before the wrap.
LINE-containing, malformed, invalid-pacing and failed-park batches cannot use
that proof. The PUBLISH adapter requires all three bindings
to be wrappers of the same invocation tracker, then reserves a provisional
150 D1 calls and 2 queue calls for verification and a separate 20 D1 calls and
2 queue calls for error handling before creating its intent. It enters the
verification scope only after the provider POST returns. This is not a
deployment plan or evidence that these provisional limits cover all paths.

Focused tests exercise the actual queue handler with one synthetic expense,
a ten-expense paced batch, expense/attendance fairness and a failed park,
plus a grouped PUBLISH adapter with sufficient and
insufficient capacity, a lost provider reply, and postimage verification
failure. They use a local SQLite fixture and mocked provider. Exhaustion or
uncertain provider results remain held; these tests do not authorize retry.
The mocked 500-detail verifier groups 501 preimage checks into one D1 batch;
this is not a measurement of the complete invocation, provider latency, CPU,
or the actual number of D1 calls on every failure path. A synthetic exhausted
post budget still leaves separate quota for the real claim's REVIEW transition
and a mocked queue error-notification path.

`InvocationBindingBudget` provides a shared counter for D1 and Queue binding
calls. One `db.batch()` counts as one D1 invocation query, consistent with
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
A separate token reserves some calls for the post-write path; unrelated work
cannot consume those slots. Unrecognized binding and statement methods fail
closed, rather than being incorrectly considered metered. The caller chooses
limits; the prototype does not claim a provider limit or capacity is available.

The candidate queue processes at most one workbook writer per batch when
pacing is configured, and prioritizes batches containing LINE or alert work.
It can still spend D1 and queue calls elsewhere in the same invocation.
`max_batch_size=1` would simplify isolation but affects the shared queue's
LINE/HR throughput and does not itself account for D1 operations within the
single message. A separate queue would need routing, ownership and recovery.

Before this prototype could support PUBLISH, independently verify that every
actual D1 and queue call for that invocation uses the same wrapped environment,
including captured references, error handling and all callbacks. Mixed LINE
batches deliberately have no such proof; no PUBLISH gate has been opened.
Sustained LINE-prioritized traffic can still delay expense jobs, even though
the workbook-only mixed case no longer requires a singleton. Establish actual worst-case
reservations and whether failure-reporting work can complete after a quota
error. Sessions, R2, HTTP, Durable Objects, Workers limits, wall time,
retry/error branches, scheduled and separate notice-worker invocations each
need explicit scope and proof. A post-write reservation is not a promise that
Sheets, D1 or the queue will respond. Tests are synthetic and do not establish
live quotas, end-to-end recovery, binding compatibility or provider behavior.
