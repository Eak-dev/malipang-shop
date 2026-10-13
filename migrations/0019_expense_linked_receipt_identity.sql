-- Preserve the existing unique invoice constraint for all primary and legacy
-- documents. Only newly linked, non-payable evidence with an exact order owner
-- uses the scoped receipt:linked:v1: key. Its order/type claim and reference_key
-- remain unique. No evidence fields, business rows or amounts are rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_document_invoice_identity_v2
ON expense_documents(legal_vendor_name,document_number)
WHERE legal_vendor_name IS NOT NULL AND legal_vendor_name<>''
  AND document_number IS NOT NULL AND document_number<>''
  AND NOT (expense_id IS NULL
    AND COALESCE(reference_key,'') GLOB 'receipt:linked:v1:*'
    AND order_id IS NOT NULL AND trim(order_id)<>'');

DROP INDEX IF EXISTS idx_expense_document_invoice_duplicate;
