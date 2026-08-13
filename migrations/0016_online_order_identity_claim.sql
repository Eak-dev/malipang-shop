-- Exact Online Order IDs are business idempotency keys.  The claim is
-- inserted in the same D1 batch as a new document/Expense, so its primary-key
-- constraint is the concurrency boundary rather than a read-before-write
-- check.  Existing document and Expense rows are preserved unchanged.
CREATE TABLE IF NOT EXISTS expense_online_order_claims(
  order_id TEXT PRIMARY KEY CHECK(order_id<>'' AND order_id=trim(order_id)),
  document_id TEXT,
  expense_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('REVIEW_ONLY','EXPENSE_OWNED','AMBIGUOUS')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (state='REVIEW_ONLY' AND document_id IS NOT NULL AND expense_id IS NULL) OR
    (state='EXPENSE_OWNED' AND document_id IS NOT NULL AND expense_id IS NOT NULL) OR
    (state='AMBIGUOUS' AND document_id IS NULL AND expense_id IS NULL)
  ),
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id),
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_online_order_claim_expense
ON expense_online_order_claims(expense_id) WHERE expense_id IS NOT NULL;

-- Backfill without choosing the newest document or upgrading review-only
-- evidence.  A single linked/direct Expense owns the identity; no Expense is
-- REVIEW_ONLY; more than one is explicitly AMBIGUOUS and must fail closed.
WITH resolved AS (
  SELECT
    trim(d.order_id) AS order_id,
    d.document_id,
    COALESCE(d.expense_id,l.expense_id) AS expense_id,
    d.created_at
  FROM expense_documents d
  LEFT JOIN expense_document_links l ON l.document_id=d.document_id
  WHERE d.document_type='ONLINE_ORDER'
    AND d.order_id IS NOT NULL
    AND trim(d.order_id)<>''
), summary AS (
  SELECT
    order_id,
    COUNT(DISTINCT expense_id) AS expense_count,
    MIN(expense_id) AS one_expense_id,
    MIN(created_at) AS first_created_at
  FROM resolved
  GROUP BY order_id
)
INSERT OR IGNORE INTO expense_online_order_claims(
  order_id,document_id,expense_id,state,created_at,updated_at
)
SELECT
  s.order_id,
  CASE
    WHEN s.expense_count>1 THEN NULL
    WHEN s.expense_count=1 THEN (
      SELECT r.document_id FROM resolved r
      WHERE r.order_id=s.order_id AND r.expense_id=s.one_expense_id
      ORDER BY r.created_at,r.document_id LIMIT 1
    )
    ELSE (
      SELECT r.document_id FROM resolved r
      WHERE r.order_id=s.order_id
      ORDER BY r.created_at,r.document_id LIMIT 1
    )
  END,
  CASE WHEN s.expense_count=1 THEN s.one_expense_id ELSE NULL END,
  CASE WHEN s.expense_count=0 THEN 'REVIEW_ONLY'
       WHEN s.expense_count=1 THEN 'EXPENSE_OWNED'
       ELSE 'AMBIGUOUS' END,
  s.first_created_at,
  s.first_created_at
FROM summary s;
