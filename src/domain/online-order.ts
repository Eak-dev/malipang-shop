import { isIsoDate } from "../shared/time";
import type { PurchaseDocument, VisionResult } from "../types";

export const onlineOrderAmountReasons = {
  MISSING_TOTAL: "Missing final paid amount",
  INVALID_TOTAL: "Invalid or unsupported final order total evidence",
  CONFLICT: "Amount evidence conflicts: final paid amount does not match accepted order total",
  PAYMENT_UNCONFIRMED: "Order payment is not confirmed"
} as const;

export const onlineOrderAmountFeedback = {
  MISSING_TOTAL: "อ่านยอดรวมที่จ่ายจริงไม่ครบ จึงพักรายการไว้ให้ตรวจสอบ",
  INVALID_TOTAL: "ยังยืนยันยอดจ่ายจริงจากป้ายยอดรวมไม่ได้ จึงพักรายการไว้ให้ตรวจสอบ",
  CONFLICT: "ยอดจ่ายจริงที่อ่านได้ขัดแย้งกับยอดรวมคำสั่งซื้อ จึงพักรายการไว้ ไม่ได้หักส่วนลดซ้ำหรือบันทึกยอดใหม่",
  PAYMENT_UNCONFIRMED: "ยังไม่มีหลักฐานยืนยันว่าชำระเงินแล้ว จึงยังไม่บันทึกรายจ่าย"
} as const;

const finalOrderLabels = ["รวมคำสั่งซื้อ", "ยอดรวมคำสั่งซื้อ", "ยอดชำระ", "total order", "order total", "paid total"];
function labelKey(value:string):string {
  // NFKC treats Thai SARA AM and its compatibility-decomposed form alike.
  // This is formatting normalization, not fuzzy matching or a wider allowlist.
  return value.normalize("NFKC").replace(/[\u200B\uFEFF]/g, "").trim().replace(/:\s*$/, "").trim().replace(/\s+/g, " ").toLowerCase();
}
export function acceptedFinalOrderLabel(value:unknown):string {
  const key = labelKey(String(value ?? ""));
  return finalOrderLabels.find(label => labelKey(label) === key) || "";
}

export function positiveSatang(value:number|null|undefined):number|null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const satang = Math.round(value * 100);
  return Number.isSafeInteger(satang) && satang > 0 ? satang : null;
}

function paidOnlineDocument(result:VisionResult):PurchaseDocument|null {
  const document = result.document;
  return result.kind === "ONLINE_ORDER" && document?.documentType === "ONLINE_ORDER" &&
    document.paymentStatus === "PAID" && document.paymentDatePurpose === "PAYMENT" &&
    isIsoDate(document.paymentDate) && document.currency === "THB" &&
    document.orderId.trim() && document.vendor.trim() && document.confidence >= 0.85
    ? document : null;
}

export function shouldRetryOnlineOrderAmount(result:VisionResult):boolean {
  const document = paidOnlineDocument(result);
  // Only wholly absent amount evidence is eligible. Invalid/contradictory
  // readings, legacy documents, unpaid orders and date failures never retry.
  return document?.onlineOrderAmountIssue === "MISSING_TOTAL" &&
    document.finalPaidAmountBaht == null && document.orderTotalBaht == null &&
    document.reviewReasons.every(reason => reason === onlineOrderAmountReasons.MISSING_TOTAL);
}

export function recoverOnlineOrderAmount(first:VisionResult, retry:VisionResult):VisionResult {
  if (!shouldRetryOnlineOrderAmount(first)) return first;
  const original = paidOnlineDocument(first), candidate = paidOnlineDocument(retry);
  if (!original || !candidate || candidate.onlineOrderAmountIssue || candidate.needsReview || candidate.reviewReasons.length) return first;
  const total = positiveSatang(candidate.orderTotalBaht);
  if (total == null || total !== positiveSatang(candidate.finalPaidAmountBaht) || !acceptedFinalOrderLabel(candidate.orderTotalLabel)) return first;
  if (original.orderId.trim() !== candidate.orderId.trim() || original.paymentDate !== candidate.paymentDate ||
    original.paymentTime !== candidate.paymentTime || original.vendor.trim() !== candidate.vendor.trim()) return first;
  const originalSellers = new Set(original.items.map(item => item.sellerKey.trim() || original.vendor.trim()));
  const retrySellers = new Set(candidate.items.map(item => item.sellerKey.trim() || candidate.vendor.trim()));
  if (originalSellers.size !== retrySellers.size || [...originalSellers].some(seller => !retrySellers.has(seller))) return first;
  // Merge only verified amount fields. A second extraction must not replace
  // items, seller grouping, dates, card source or other first-read evidence.
  const recoveredDocument:PurchaseDocument = {...original,
    finalPaidAmountBaht: total / 100, orderTotalBaht: total / 100,
    orderTotalLabel: acceptedFinalOrderLabel(candidate.orderTotalLabel),
    needsReview: true,
    reviewReasons: ["Review item description and category after order-total reread"]
  };
  delete recoveredDocument.onlineOrderAmountIssue;
  return {...first, document: recoveredDocument};
}
