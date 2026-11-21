-- Additive diagnostics for a retained workbook claim. A claim moved to REVIEW
-- records the lifecycle phase that failed and a short sanitized cause, so an
-- operator can tell a failed read before any provider write from an uncertain
-- write. No provider bodies, identifiers or free-form messages are stored.
-- Existing rows keep NULL values; older Worker versions never read or write
-- these columns, so the migration is safe to apply before deploying the code.
ALTER TABLE stable_workbook_claims ADD COLUMN phase TEXT;
ALTER TABLE stable_workbook_claims ADD COLUMN review_reason TEXT;
