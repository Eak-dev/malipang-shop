-- Evidence candidates only. No row-index assignment or REVIEW release may
-- depend on this table. Source preimages and signatures are not stored here.
CREATE TABLE IF NOT EXISTS daily_identity_candidates(
  approval_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
  row_number INTEGER NOT NULL CHECK(row_number>=6),
  metadata_id INTEGER NOT NULL CHECK(metadata_id>0),
  -- No foreign key: retaining a candidate must not change business-record
  -- deletion behavior. Source existence is checked at candidate insertion.
  expense_id TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  reviewer_id TEXT NOT NULL,
  approval_digest TEXT NOT NULL CHECK(length(approval_digest)=64),
  signature_digest TEXT NOT NULL CHECK(length(signature_digest)=64),
  reviewer_key_digest TEXT NOT NULL CHECK(length(reviewer_key_digest)=64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>observed_at_ms),
  state TEXT NOT NULL CHECK(state IN ('CANDIDATE_ONLY','EXPIRED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS daily_identity_candidate_active_expense ON daily_identity_candidates(expense_id) WHERE state='CANDIDATE_ONLY';
CREATE UNIQUE INDEX IF NOT EXISTS daily_identity_candidate_active_row ON daily_identity_candidates(spreadsheet_id,sheet_id,row_number) WHERE state='CANDIDATE_ONLY';
CREATE UNIQUE INDEX IF NOT EXISTS daily_identity_candidate_active_metadata ON daily_identity_candidates(spreadsheet_id,metadata_id) WHERE state='CANDIDATE_ONLY';
