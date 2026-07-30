# V1.2 Expense Document / V2 Contract

V1.2 ไม่สร้าง V2 UI แต่สร้าง domain เดียวที่ LINE และ V2 ใช้ร่วมกัน: `expense_events` เป็น Expense business case, `expense_documents` เป็นหลักฐาน, `expense_document_items` เป็น line items, `expense_document_cases` เป็น seller case, `expense_document_links` เป็นความสัมพันธ์หลักฐาน และ `expense_audit_log` เป็นประวัติ append-only.

ทุก Expense ใหม่มี `submitted_by_employee_id` และ `branch_id`. การอ่าน V2 ต้องใช้ `authorize(actor, capability, resourceScope)` เดิม: employee เห็นของตน, manager เห็นเฉพาะสาขา, owner เห็นทุกสาขา. ห้ามใช้ Staff ID prefix หรือ Google Sheets เป็น authorization.

สัญญา service ที่ V2 ใช้ต่อได้:

```text
listExpenseCases(actor, branch/date filters)
getExpenseCase(actor, expenseId)
getExpenseDocuments(actor, expenseId/documentId)
reviewExpenseCase(actor, expenseId, edit/confirm/cancel)
```

V2 ต้องไม่ OCR เอกสารเดิมซ้ำเพื่อสร้าง line item ใหม่ และต้องไม่ finalize case ที่ไม่มี payment date, final paid amount หรือ wallet ที่ผู้ใช้ยืนยันแล้ว.
