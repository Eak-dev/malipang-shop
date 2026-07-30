-- V1.2 Expense Document Foundation.  Existing expense rows and raw evidence
-- remain untouched; new fields/tables provide V2-ready ownership and audit.
ALTER TABLE expense_events ADD COLUMN submitted_by_employee_id TEXT;
ALTER TABLE expense_events ADD COLUMN branch_id TEXT;
ALTER TABLE expense_events ADD COLUMN reviewed_by_employee_id TEXT;
ALTER TABLE expense_events ADD COLUMN approved_at TEXT;
ALTER TABLE expense_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE expense_documents ADD COLUMN vendor_name TEXT;
ALTER TABLE expense_documents ADD COLUMN legal_vendor_name TEXT;
ALTER TABLE expense_documents ADD COLUMN document_number TEXT;
ALTER TABLE expense_documents ADD COLUMN order_id TEXT;
ALTER TABLE expense_documents ADD COLUMN document_date TEXT;
ALTER TABLE expense_documents ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
ALTER TABLE expense_documents ADD COLUMN subtotal_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN shipping_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN subsidy_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN vat_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN final_paid_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN normalized_json TEXT;
ALTER TABLE expense_documents ADD COLUMN submitted_by_employee_id TEXT;
ALTER TABLE expense_documents ADD COLUMN branch_id TEXT;

CREATE TABLE IF NOT EXISTS expense_document_items(
  item_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  expense_id TEXT,
  seller_key TEXT,
  product_code TEXT,
  description TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  unit_price_satang INTEGER,
  discount_satang INTEGER,
  line_total_satang INTEGER,
  vat_satang INTEGER,
  confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id),
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_document_items_document ON expense_document_items(document_id);
CREATE INDEX IF NOT EXISTS idx_expense_document_items_expense ON expense_document_items(expense_id);

CREATE TABLE IF NOT EXISTS expense_document_cases(
  case_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  seller_key TEXT NOT NULL,
  vendor_name TEXT NOT NULL DEFAULT '',
  gross_satang INTEGER,
  final_paid_satang INTEGER,
  status TEXT NOT NULL CHECK(status IN ('WAITING_CONFIRM','WAITING_REVIEW','CONFIRMED','CANCELLED')),
  expense_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id,seller_key),
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id),
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_document_cases_expense ON expense_document_cases(expense_id);

CREATE TABLE IF NOT EXISTS expense_document_links(
  link_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('PRIMARY_PURCHASE_DOCUMENT','PAYMENT_EVIDENCE','SUPPORTING_DOCUMENT')),
  match_method TEXT NOT NULL CHECK(match_method IN ('EXACT_IDENTIFIER','MANUAL','REVIEW_CANDIDATE')),
  linked_by_employee_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(expense_id,document_id),
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id),
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_document_links_document ON expense_document_links(document_id);

CREATE TABLE IF NOT EXISTS expense_audit_log(
  audit_id TEXT PRIMARY KEY,
  actor_employee_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('CREATE_DRAFT','EXTRACT','MATCH','CONFIRM','EDIT','CANCEL','UNDO','REVIEW_APPROVE','REVIEW_REJECT','DOCUMENT_LINK','DOCUMENT_UNLINK')),
  expense_id TEXT,
  document_id TEXT,
  branch_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id),
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_audit_expense ON expense_audit_log(expense_id,created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_document_invoice_duplicate
ON expense_documents(legal_vendor_name,document_number)
WHERE legal_vendor_name IS NOT NULL AND legal_vendor_name<>'' AND document_number IS NOT NULL AND document_number<>'';
-- Order IDs identify a business purchase, not one immutable image. A tax
-- invoice, delivery note and payment evidence may all legitimately share it.
-- Final-expense idempotency is enforced by service/link logic instead.
CREATE INDEX IF NOT EXISTS idx_expense_document_order_seller
ON expense_documents(order_id,vendor_name) WHERE order_id IS NOT NULL AND order_id<>'' AND vendor_name IS NOT NULL AND vendor_name<>'';
CREATE INDEX IF NOT EXISTS idx_expense_events_owner_branch ON expense_events(submitted_by_employee_id,branch_id,created_at);

-- A short-lived mutex prevents two Queue consumers from inserting rows before
-- the same monthly total simultaneously.  The lock is always released by the
-- writer; an expired lock can be safely reclaimed after a Worker interruption.
CREATE TABLE IF NOT EXISTS daily_sheet_capacity_locks(
  sheet_name TEXT NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  locked_at TEXT NOT NULL,
  PRIMARY KEY(sheet_name,month)
);

CREATE TABLE IF NOT EXISTS daily_sheet_capacity_expansions(
  sheet_name TEXT NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  anchor_total_row INTEGER NOT NULL,
  marker TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','MAPPED','COMPLETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(sheet_name,month)
);
