-- An owner attests to a period only for the exact, expiring correction draft.
-- This is not a global declaration that an accounting period is open.
CREATE TABLE IF NOT EXISTS expense_owner_correction_period_decisions(
  correction_id TEXT NOT NULL REFERENCES expense_owner_corrections(correction_id),
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(period,1,4) AS INTEGER)>=2000 AND CAST(substr(period,6,2) AS INTEGER) BETWEEN 1 AND 12),
  header_digest TEXT NOT NULL CHECK(length(header_digest)=64 AND header_digest NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL CHECK(decision IN ('OPEN','HOLD')),
  actor_employee_id TEXT NOT NULL REFERENCES employees(employee_id),
  created_at TEXT NOT NULL,
  -- A later HOLD can only make this draft safer; it never erases an OPEN.
  PRIMARY KEY(correction_id,period,header_digest,decision)
);
CREATE INDEX IF NOT EXISTS idx_owner_correction_period_actor ON expense_owner_correction_period_decisions(actor_employee_id,created_at);
