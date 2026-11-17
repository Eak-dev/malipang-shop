# Expense outbox source guard — WIP, default off

The option `EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED=true` conditionally prevents a
queue hint, regular producer or mixed-batch parked writer from recreating an
expense sync job after its source is gone. The source-existence predicate is
inside the insert, not a separate pre-check. Forced reconciliation already
holds every expense job in the integrated baseline; this patch preserves that
behavior. Other entity types and the default-off path retain existing routing.
Stale expense sync hints with neither source nor exact-version job are ACKed;
existing REVIEW jobs are retained. Failure/DLQ inserts use one D1 batch to
record the event only while a source or any corresponding job exists; a
verified absent result avoids a new alert. An uncertain check retries.

This does not perform deletion or establish that deleting a source is safe.
Before any exact-target deletion the operator still needs to settle/drain old
workers, provider outcomes and all source/object references, then atomically
remove the approved records; this guard neither fences a previously running
Worker nor prevents a delayed alert already read before deletion. A prior
LINE webhook can be redelivered after deleting inbound idempotency records and
recreate an expense or R2 object; this opt-in cannot prevent that without
retaining a deduplication record, which the owner explicitly declined. The producer checks source presence in the same D1 batch and skips a hint when
the source is already absent. Deletion after that batch may still race the
queue send; the consumer ACKs it if both source and job remain absent. This
prototype must remain off until integration review and real rollout proofs.
