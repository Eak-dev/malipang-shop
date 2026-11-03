-- Unwired discovery foundation only: PENDING does not authorize a Sheets write.
-- Source version/revision zero means that source evidence was missing, REVIEW.
CREATE TABLE IF NOT EXISTS personal_projection_generation_observations (
  spreadsheet_id TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version>=0),
  source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('PENDING','REVIEW')),
  reason TEXT,
  discovery_run_id TEXT NOT NULL,
  discovery_order INTEGER NOT NULL CHECK(discovery_order>0),
  discovered_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,cutover_generation,personal_use_id,source_version,source_revision),
  CHECK(state<>'REVIEW' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_projection_discovery_run_order ON personal_projection_generation_observations(discovery_run_id,discovery_order);
CREATE INDEX IF NOT EXISTS idx_personal_projection_observations_revision ON personal_projection_generation_observations(spreadsheet_id,personal_use_id,source_revision);
CREATE TABLE IF NOT EXISTS personal_projection_discovery_cursors (
  spreadsheet_id TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  last_personal_use_id TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,cutover_generation)
);
