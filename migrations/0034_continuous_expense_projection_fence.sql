-- Once the continuous cutover is active, a stale Worker may not reserve a
-- new expense projection against legacy sheets. Existing historical rows are
-- immutable and remain readable. Other workbooks and PERSONAL_USE are intact.
CREATE TRIGGER IF NOT EXISTS continuous_expense_projection_target_fence
BEFORE INSERT ON stable_projection_writes
WHEN NEW.entity_type='EXPENSE' AND EXISTS(
 SELECT 1 FROM continuous_daily_cutovers c
 WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state='ACTIVE' AND (
  NEW.projection='DAILY' AND (NEW.sheet_id IS NOT c.continuous_sheet_id OR NEW.sheet_name IS NOT c.continuous_sheet_name)
  OR NEW.projection='EXPENSE_RAW' AND (NEW.sheet_id IS NOT c.raw_sheet_id OR NEW.sheet_name IS NOT c.raw_sheet_name)
  OR NEW.projection='DETAIL' AND (NEW.sheet_id IS NOT c.detail_sheet_id OR NEW.sheet_name IS NOT c.detail_sheet_name)
  OR NEW.projection NOT IN ('DAILY','EXPENSE_RAW','DETAIL')
 )
)
BEGIN SELECT RAISE(ABORT,'continuous expense projection target rejected'); END;

-- Legacy direct writers acquire an expense lease before a Sheets request.
-- Activation must serialize against every such lease, including expired ones:
-- expiry does not prove that an already-sent request stopped at Google.
CREATE TRIGGER IF NOT EXISTS continuous_expense_cutover_no_processing
BEFORE UPDATE OF state ON continuous_daily_cutovers
WHEN NEW.state='ACTIVE' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.status='PROCESSING')
BEGIN SELECT RAISE(ABORT,'continuous expense cutover processing'); END;
