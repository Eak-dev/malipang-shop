# Invocation binding budget — local prototype only

The PUBLISH runtime gate remains closed. This standalone prototype is not
wired into any Worker, queue, D1 or Sheets call and is not a deployment plan.

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

Before this prototype could support PUBLISH, integration must ensure that all
actual D1 and queue calls for the entire invocation use the same counter,
reserve before any potentially ambiguous provider write, and pass the
privileged post-write wrapper to every verification/handoff path. Existing
closures retain `env`, so merely constructing the wrapper does not accomplish
that. Raw binding references, sessions, R2, HTTP, Durable Objects, Workers
limits, wall time, retry/error branches, scheduled and separate notice-worker
invocations each need explicit scope and proof. A post-write reservation is
not a promise that Sheets, D1 or the queue will respond successfully. Tests
are synthetic and do not establish paid-plan status, live quotas, end-to-end
recovery, supported D1 binding compatibility or provider behavior.
