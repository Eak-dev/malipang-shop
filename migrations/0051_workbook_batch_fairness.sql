-- A bounded alternating preference only for mixed expense/non-expense batches.
-- It is not a lease, a provider-write fence, or a change to the queue cap.
CREATE TABLE IF NOT EXISTS workbook_batch_fairness (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 expense_turn INTEGER NOT NULL CHECK(expense_turn IN (0,1))
);
