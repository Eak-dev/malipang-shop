-- Shadow experiment: durable identity and dispatch intent, never a row number.
-- Activation and legacy enrollment are deliberately not provided here.
CREATE TABLE IF NOT EXISTS ledger_stable_identity_journal (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('EXPENSE','PERSONAL_USE','PURCHASE_DETAILS')),
  -- CORE excludes RAW document/submitter fields; ITEM covers one detail.
  -- Neither scope implies all projections or a whole RAW row are verified.
  scope TEXT NOT NULL CHECK(scope IN ('CORE','ITEM')),
  entity_key TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('VERIFIED','IN_FLIGHT','REVIEW')),
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  projected_version INTEGER CHECK(projected_version > 0),
  baseline_json TEXT,
  intent_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,kind,entity_key,scope),
  UNIQUE(spreadsheet_id,metadata_id),
  CHECK((kind='PURCHASE_DETAILS' AND scope='ITEM') OR (kind IN ('EXPENSE','PERSONAL_USE') AND scope='CORE')),
  CHECK(state <> 'VERIFIED' OR (projected_version IS NOT NULL AND baseline_json IS NOT NULL AND intent_token IS NULL)),
  CHECK(state <> 'IN_FLIGHT' OR intent_token IS NOT NULL)
);
