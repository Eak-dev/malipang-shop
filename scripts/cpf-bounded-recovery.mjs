import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CPF_DOCUMENT_NUMBER = "169AQP287497";
export const CPF_FINAL_PAID_SATANG = 112800;
export const CPF_GROSS_SATANG = 142500;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function parseStoredDocument(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Retained document has no normalized JSON");
  try {
    return object(JSON.parse(value), "normalized document");
  } catch (error) {
    throw new Error(`Retained normalized document is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cpfVendor(value) {
  return /(?:^|\b)cpf(?:\b|$)/i.test(String(value || ""));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function statement(sql, params = []) {
  return { sql, params };
}

export function buildRecoveryPlan(snapshot, runtime, ids = {}) {
  const documentRow = object(snapshot.document, "document row");
  const document = parseStoredDocument(documentRow.normalized_json);
  const itemStats = object(snapshot.itemStats, "item stats");
  const caseStats = object(snapshot.caseStats, "case stats");
  const existing = object(snapshot.existing, "existing state");

  assertEqual(String(documentRow.document_number || ""), CPF_DOCUMENT_NUMBER, "document number");
  if (!["RECEIPT", "TAX_INVOICE", "RECEIPT_TAX_INVOICE"].includes(String(documentRow.document_type || ""))) {
    throw new Error("Retained target is not an approved single-issuer receipt or tax invoice");
  }
  assertEqual(String(documentRow.status || ""), "WAITING_REVIEW", "retained document status");
  if (documentRow.expense_id != null) throw new Error("Retained document already has an Expense link");
  assertEqual(integer(documentRow.final_paid_satang, "final_paid_satang"), CPF_FINAL_PAID_SATANG, "final paid amount");
  assertEqual(integer(documentRow.gross_amount_satang, "gross_amount_satang"), CPF_GROSS_SATANG, "gross amount");
  if (!cpfVendor(documentRow.legal_vendor_name) && !cpfVendor(documentRow.vendor_name)) throw new Error("Retained vendor is not CPF");
  if (!String(documentRow.message_id || "").trim() || !String(documentRow.line_user_id || "").trim()) throw new Error("Retained document identity is incomplete");

  assertEqual(String(document.documentNumber || ""), CPF_DOCUMENT_NUMBER, "normalized document number");
  if (!cpfVendor(document.legalVendorName) && !cpfVendor(document.vendor)) throw new Error("Normalized vendor is not CPF");
  assertEqual(runtime.toSatang(document.finalPaidAmountBaht), CPF_FINAL_PAID_SATANG, "normalized final paid amount");
  assertEqual(runtime.toSatang(document.grossAmountBaht), CPF_GROSS_SATANG, "normalized gross amount");

  const items = Array.isArray(document.items) ? document.items : [];
  assertEqual(integer(itemStats.item_count, "item_count"), 2, "retained item count");
  assertEqual(items.length, 2, "normalized item count");
  assertEqual(integer(itemStats.item_total_satang, "item_total_satang"), CPF_GROSS_SATANG, "retained item total");
  assertEqual(integer(itemStats.linked_item_count, "linked_item_count"), 0, "pre-linked item count");
  if (integer(caseStats.case_count, "case_count") < 1) throw new Error("Retained seller cases are missing");
  assertEqual(integer(caseStats.confirmed_case_count, "confirmed_case_count"), 0, "confirmed seller case count");
  assertEqual(integer(caseStats.linked_case_count, "linked_case_count"), 0, "pre-linked seller case count");
  assertEqual(integer(existing.expense_count, "expense_count"), 0, "existing Expense count");
  assertEqual(integer(existing.amount_date_candidate_count, "amount_date_candidate_count"), 0, "same-date amount candidate count");
  assertEqual(integer(existing.link_count, "link_count"), 0, "existing document link count");
  assertEqual(integer(existing.linked_case_count, "linked_case_count"), 0, "pre-linked seller case count");
  assertEqual(integer(existing.sync_count, "sync_count"), 0, "existing Sheet sync count");

  const draft = runtime.purchaseExpenseDraft(document);
  if (!draft) throw new Error("Updated release code still cannot derive an Expense draft from the retained document");
  assertEqual(draft.amountSatang, CPF_FINAL_PAID_SATANG, "derived Expense amount");
  const sellerCases = runtime.sellerDocumentCases(document);
  assertEqual(sellerCases.length, 1, "canonical seller case count");
  const sellerCase = sellerCases[0];
  if (!cpfVendor(sellerCase.sellerKey) || !cpfVendor(sellerCase.vendorName)) throw new Error("Canonical seller case is not CPF");
  assertEqual(sellerCase.grossSatang, CPF_GROSS_SATANG, "canonical seller gross");
  assertEqual(sellerCase.finalPaidSatang, CPF_FINAL_PAID_SATANG, "canonical seller final paid");

  const reviewState = runtime.purchaseReviewState(document, draft);
  const normalizedJson = JSON.stringify(runtime.documentWithReviewState(document, reviewState));
  const now = ids.now || new Date().toISOString();
  const uuid = ids.uuid || (() => crypto.randomUUID());
  const expenseId = ids.expenseId || `exp_${uuid()}`;
  const caseId = ids.caseId || `seller_case_${uuid()}`;
  const linkId = ids.linkId || `doc_link_${uuid()}`;
  const auditId = ids.auditId || `exp_audit_${uuid()}`;
  const traceId = ids.traceId || `cpf_recovery_${uuid()}`;
  const documentId = String(documentRow.document_id);
  const issuer = String(sellerCase.sellerKey);
  const reviewNote = [...new Set(["Bounded recovery after CPF single-issuer routing fix", ...draft.reviewReasons])].join("; ");
  const actorEmployeeId = documentRow.submitted_by_employee_id == null ? null : String(documentRow.submitted_by_employee_id);
  const branchId = documentRow.branch_id == null ? null : String(documentRow.branch_id);

  const statements = [
    statement(
      `INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,submitted_by_employee_id,branch_id) SELECT ?,?,?,?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?,? WHERE EXISTS(SELECT 1 FROM expense_documents WHERE document_id=? AND document_number=? AND final_paid_satang=? AND status='WAITING_REVIEW' AND expense_id IS NULL) AND NOT EXISTS(SELECT 1 FROM expense_events WHERE message_id=? OR (amount_satang=? AND transaction_date IN (?,?)))`,
      [expenseId, String(documentRow.message_id), String(documentRow.line_user_id), draft.description, draft.amountSatang, draft.paymentKey, draft.sourceWallet, draft.category, draft.transactionDate, traceId, now, actorEmployeeId, branchId, documentId, CPF_DOCUMENT_NUMBER, CPF_FINAL_PAID_SATANG, String(documentRow.message_id), CPF_FINAL_PAID_SATANG, String(documentRow.payment_date || ""), String(documentRow.document_date || "")]
    ),
    statement(
      `UPDATE expense_documents SET status='WAITING_CONFIRM',expense_id=?,normalized_json=?,review_note=?,updated_at=? WHERE document_id=? AND document_number=? AND final_paid_satang=? AND status='WAITING_REVIEW' AND expense_id IS NULL`,
      [expenseId, normalizedJson, reviewNote, now, documentId, CPF_DOCUMENT_NUMBER, CPF_FINAL_PAID_SATANG]
    ),
    statement(
      `UPDATE expense_document_items SET expense_id=?,seller_key=?,updated_at=? WHERE document_id=? AND expense_id IS NULL`,
      [expenseId, issuer, now, documentId]
    ),
    statement(
      `UPDATE expense_document_cases SET status='CANCELLED',updated_at=? WHERE document_id=? AND expense_id IS NULL AND status='WAITING_REVIEW'`,
      [now, documentId]
    ),
    statement(
      `INSERT INTO expense_document_cases(case_id,document_id,seller_key,vendor_name,gross_satang,final_paid_satang,status,expense_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'WAITING_CONFIRM',?,?,?) ON CONFLICT(document_id,seller_key) DO UPDATE SET vendor_name=excluded.vendor_name,gross_satang=excluded.gross_satang,final_paid_satang=excluded.final_paid_satang,status='WAITING_CONFIRM',expense_id=excluded.expense_id,updated_at=excluded.updated_at`,
      [caseId, documentId, issuer, String(sellerCase.vendorName), sellerCase.grossSatang, sellerCase.finalPaidSatang, expenseId, now, now]
    ),
    statement(
      `INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,linked_by_employee_id,reason,created_at) VALUES(?,?,?,'PRIMARY_PURCHASE_DOCUMENT','MANUAL',?,'Bounded recovery after verified CPF single-issuer fix',?)`,
      [linkId, expenseId, documentId, actorEmployeeId, now]
    ),
    statement(
      `INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,'CREATE_DRAFT',?,?,?,'Bounded recovery after verified CPF single-issuer fix',?,?,?)`,
      [auditId, actorEmployeeId, expenseId, documentId, branchId, JSON.stringify({ status: "WAITING_REVIEW", multiSellerMisclassification: true }), JSON.stringify({ status: "WAITING_CONFIRM", sellerCaseCount: 1, finalPaidSatang: CPF_FINAL_PAID_SATANG }), now]
    )
  ];

  return {
    documentId,
    expenseId,
    issuer,
    draft,
    reviewState,
    statements,
    summary: {
      document_number: CPF_DOCUMENT_NUMBER,
      vendor_family: "CPF",
      gross_satang: CPF_GROSS_SATANG,
      final_paid_satang: CPF_FINAL_PAID_SATANG,
      item_count: 2,
      canonical_seller_case_count: 1,
      recovered_status: "WAITING_CONFIRM",
      unresolved_fields: runtime.unresolvedReviewFields(reviewState),
      auto_finalized: false,
      sheets_sync_created: false,
      next_action: "RESEND_ORIGINAL_IMAGE_TO_RESUME_CONFIRMATION"
    }
  };
}

function cloudflareClient(env = process.env) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  const databaseId = required(env.MALIPANG_D1_DATABASE_ID, "MALIPANG_D1_DATABASE_ID");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function request(body) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const code = payload?.errors?.[0]?.code || response.status;
      throw new Error(`Cloudflare D1 request failed (${code})`);
    }
    return Array.isArray(payload.result) ? payload.result : [];
  }

  return {
    async query(sql, params = []) {
      const result = await request({ sql, params });
      const first = result[0];
      if (!first?.success) throw new Error("Cloudflare D1 query did not succeed");
      return Array.isArray(first.results) ? first.results : [];
    },
    async batch(statements) {
      const result = await request({ batch: statements });
      if (result.length !== statements.length || result.some(item => !item?.success)) throw new Error("Cloudflare D1 atomic batch did not fully succeed");
      return result;
    }
  };
}

async function snapshot(client) {
  const documents = await client.query(
    `SELECT document_id,message_id,line_user_id,document_type,status,expense_id,vendor_name,legal_vendor_name,document_number,document_date,payment_date,final_paid_satang,gross_amount_satang,normalized_json,submitted_by_employee_id,branch_id,trace_id FROM expense_documents WHERE document_number=?`,
    [CPF_DOCUMENT_NUMBER]
  );
  if (documents.length !== 1) throw new Error(`Bounded target count must be exactly 1; found ${documents.length}`);
  const document = documents[0];
  const documentId = String(document.document_id);
  const [itemRows, caseRows, existingRows] = await Promise.all([
    client.query(`SELECT COUNT(*) AS item_count,COALESCE(SUM(line_total_satang),0) AS item_total_satang,SUM(CASE WHEN expense_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_item_count FROM expense_document_items WHERE document_id=?`, [documentId]),
    client.query(`SELECT COUNT(*) AS case_count,SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed_case_count,SUM(CASE WHEN expense_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_case_count FROM expense_document_cases WHERE document_id=?`, [documentId]),
    client.query(`SELECT (SELECT COUNT(*) FROM expense_events WHERE message_id=?) AS expense_count,(SELECT COUNT(*) FROM expense_events WHERE amount_satang=? AND transaction_date IN (?,?)) AS amount_date_candidate_count,(SELECT COUNT(*) FROM expense_document_links WHERE document_id=?) AS link_count,(SELECT COUNT(*) FROM expense_document_cases WHERE document_id=? AND expense_id IS NOT NULL) AS linked_case_count,(SELECT COUNT(*) FROM sync_jobs s JOIN expense_events e ON e.expense_id=s.entity_key WHERE s.entity_type='EXPENSE' AND e.message_id=?) AS sync_count`, [String(document.message_id), CPF_FINAL_PAID_SATANG, String(document.payment_date || ""), String(document.document_date || ""), documentId, documentId, String(document.message_id)])
  ]);
  return { document, itemStats: itemRows[0] || {}, caseStats: caseRows[0] || {}, existing: existingRows[0] || {} };
}

async function loadRuntime(releaseDir) {
  const require = createRequire(import.meta.url);
  const document = require(path.join(releaseDir, "dist/expense/document.js"));
  const review = require(path.join(releaseDir, "dist/expense/review-state.js"));
  return { ...document, ...review };
}

async function verifyApplied(client, plan) {
  const rows = await client.query(
    `SELECT d.status AS document_status,d.expense_id,e.status AS expense_status,e.amount_satang,e.message_id,(SELECT COUNT(*) FROM expense_document_items i WHERE i.document_id=d.document_id AND i.expense_id=e.expense_id AND i.seller_key=?) AS canonical_item_count,(SELECT COUNT(*) FROM expense_document_cases c WHERE c.document_id=d.document_id AND c.expense_id=e.expense_id AND c.status='WAITING_CONFIRM') AS active_case_count,(SELECT COUNT(*) FROM expense_document_cases c WHERE c.document_id=d.document_id AND c.status='CANCELLED') AS cancelled_case_count,(SELECT COUNT(*) FROM expense_document_links l WHERE l.document_id=d.document_id AND l.expense_id=e.expense_id) AS link_count,(SELECT COUNT(*) FROM expense_audit_log a WHERE a.document_id=d.document_id AND a.expense_id=e.expense_id AND a.action='CREATE_DRAFT') AS recovery_audit_count,(SELECT COUNT(*) FROM sync_jobs s WHERE s.entity_type='EXPENSE' AND s.entity_key=e.expense_id) AS sync_count FROM expense_documents d JOIN expense_events e ON e.expense_id=d.expense_id WHERE d.document_id=? AND e.expense_id=?`,
    [plan.issuer, plan.documentId, plan.expenseId]
  );
  if (rows.length !== 1) throw new Error("Recovered Expense verification row is missing");
  const row = rows[0];
  assertEqual(String(row.document_status), "WAITING_CONFIRM", "recovered document status");
  assertEqual(String(row.expense_status), "WAITING_CONFIRM", "recovered Expense status");
  assertEqual(integer(row.amount_satang, "amount_satang"), CPF_FINAL_PAID_SATANG, "recovered amount");
  assertEqual(integer(row.canonical_item_count, "canonical_item_count"), 2, "canonical item count");
  assertEqual(integer(row.active_case_count, "active_case_count"), 1, "active seller case count");
  assertEqual(integer(row.link_count, "link_count"), 1, "document link count");
  assertEqual(integer(row.recovery_audit_count, "recovery_audit_count"), 1, "recovery audit count");
  assertEqual(integer(row.sync_count, "sync_count"), 0, "pre-confirmation Sheet sync count");
  return {
    ...plan.summary,
    document_status: String(row.document_status),
    expense_status: String(row.expense_status),
    canonical_item_count: integer(row.canonical_item_count, "canonical_item_count"),
    active_case_count: integer(row.active_case_count, "active_case_count"),
    cancelled_case_count: integer(row.cancelled_case_count, "cancelled_case_count"),
    document_link_count: integer(row.link_count, "link_count"),
    recovery_audit_count: integer(row.recovery_audit_count, "recovery_audit_count"),
    sync_count: integer(row.sync_count, "sync_count")
  };
}

async function writeArtifact(artifactDir, name, value) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const releaseArg = process.argv.find(item => item.startsWith("--release-dir="));
  const artifactArg = process.argv.find(item => item.startsWith("--artifact-dir="));
  const releaseDir = path.resolve(releaseArg ? releaseArg.slice("--release-dir=".length) : ".");
  const artifactDir = path.resolve(artifactArg ? artifactArg.slice("--artifact-dir=".length) : "release-artifacts");
  const client = cloudflareClient();
  const runtime = await loadRuntime(releaseDir);
  const plan = buildRecoveryPlan(await snapshot(client), runtime);
  await writeArtifact(artifactDir, apply ? "cpf-recovery-pre-apply.json" : "cpf-recovery-inspection.json", { ...plan.summary, operation: apply ? "APPLY_PREFLIGHT" : "INSPECT_ONLY" });
  if (!apply) return;
  await client.batch(plan.statements);
  await writeArtifact(artifactDir, "cpf-recovery-result.json", { ...(await verifyApplied(client, plan)), operation: "APPLIED" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`CPF bounded recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
