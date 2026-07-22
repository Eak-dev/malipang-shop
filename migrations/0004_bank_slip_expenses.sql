ALTER TABLE expense_documents ADD COLUMN channel TEXT;
ALTER TABLE expense_documents ADD COLUMN institution TEXT;
ALTER TABLE expense_documents ADD COLUMN transaction_type TEXT;
ALTER TABLE expense_documents ADD COLUMN transaction_status TEXT;
ALTER TABLE expense_documents ADD COLUMN payment_date TEXT;
ALTER TABLE expense_documents ADD COLUMN payment_time TEXT;
ALTER TABLE expense_documents ADD COLUMN reference_id TEXT;
ALTER TABLE expense_documents ADD COLUMN reference_key TEXT;
ALTER TABLE expense_documents ADD COLUMN sender TEXT;
ALTER TABLE expense_documents ADD COLUMN sender_account_masked TEXT;
ALTER TABLE expense_documents ADD COLUMN recipient TEXT;
ALTER TABLE expense_documents ADD COLUMN recipient_account_masked TEXT;
ALTER TABLE expense_documents ADD COLUMN merchant TEXT;
ALTER TABLE expense_documents ADD COLUMN gross_amount_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN discount_amount_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN paid_amount_satang INTEGER;
ALTER TABLE expense_documents ADD COLUMN suggested_description TEXT;
ALTER TABLE expense_documents ADD COLUMN suggested_category TEXT;
ALTER TABLE expense_documents ADD COLUMN confidence REAL;
ALTER TABLE expense_documents ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 1;
ALTER TABLE expense_documents ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE expense_documents ADD COLUMN image_hash TEXT;
ALTER TABLE expense_documents ADD COLUMN expense_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_documents_reference_key
ON expense_documents(reference_key)
WHERE reference_key IS NOT NULL AND reference_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_documents_image_hash
ON expense_documents(image_hash)
WHERE image_hash IS NOT NULL AND image_hash <> '';

CREATE INDEX IF NOT EXISTS idx_expense_documents_expense_id
ON expense_documents(expense_id);
