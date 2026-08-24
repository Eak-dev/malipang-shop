import { authorize } from "./authorization";
import {
  approveIdentityLinkRequest,
  createEmployeeChangeRequest,
  listIdentityLinkRequests,
  rejectIdentityLinkRequest,
  submitHrStaffId,
} from "./repository";
import {
  approveOnboardingAsNewEmployee,
  getLineFirstOnboardingRequest,
  hasPendingLineFirstOnboarding,
  linkOnboardingToExistingStaff,
  listPendingLineFirstOnboarding,
  listUnboundActiveStaff,
  rejectLineFirstOnboarding,
  startLineFirstOnboarding,
  type HrOnboardingRequest,
  type UnboundStaff,
} from "./hr-onboarding";
import { importEmployeesFromConfiguredSheet } from "../admin/staff-import";
import { getLineUserProfile } from "../line/profile";
import { respondFlexToLineEvent, respondTextToLineEvent } from "../line/event-response";
import type { Env, LineEvent } from "../types";
import type { StaffActor } from "./repository";

function reply(env: Env, event: LineEvent, text: string, traceId: string): Promise<unknown> {
  return respondTextToLineEvent(env, event, text, { traceId, purpose: "EMPLOYEE_RESPONSE", identitySuffix: "hr" });
}
function replyFlex(env: Env, event: LineEvent, message: unknown, traceId: string, suffix = "hr-flex"): Promise<unknown> {
  return respondFlexToLineEvent(env, event, message, { traceId, purpose: "EMPLOYEE_RESPONSE", identitySuffix: suffix });
}
function tri(th: string, en: string, mm: string): string { return `${th}\n\n${en}\n\n${mm}`; }
function profile(actor: StaffActor): string {
  return tri(
    `โปรไฟล์ HR\nรหัสพนักงาน: ${actor.employeeId}\nชื่อ: ${actor.employee.staffName}\nบทบาท: ${actor.role}\nสาขา: ${actor.branchName || "ทุกสาขา"}\nLINE: เชื่อมต่อแล้ว\nสถานะ: ${actor.employeeStatus}`,
    `HR Profile\nStaff ID: ${actor.employeeId}\nName: ${actor.employee.staffName}\nRole: ${actor.role}\nBranch: ${actor.branchName || "All branches"}\nLINE: Connected\nStatus: ${actor.employeeStatus}`,
    `HR ပရိုဖိုင်\nဝန်ထမ်း ID: ${actor.employeeId}\nအမည်: ${actor.employee.staffName}\nအခန်းကဏ္ဍ: ${actor.role}\nLINE: ချိတ်ဆက်ပြီး\nအခြေအနေ: ${actor.employeeStatus}`,
  );
}
function maskLineId(lineUserId: string): string { const value = lineUserId.trim(); return value.length <= 4 ? "••••" : `U••••${value.slice(-4)}`; }
function requestTime(value: string): string {
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  } catch { return value; }
}
function safeText(value: string, max = 80): string { return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) || "LINE user"; }
function button(label: string, text: string, style: "primary" | "secondary" = "secondary"): unknown { return { type: "button", style, action: { type: "message", label, text } }; }
function textBlock(text: string, size = "sm", weight?: "bold"): unknown { return { type: "text", text, wrap: true, size, ...(weight ? { weight } : {}) }; }
function hero(pictureUrl: string): Record<string, unknown> { return /^https:\/\//i.test(pictureUrl) ? { hero: { type: "image", url: pictureUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" } } : {}; }

function onboardingBubble(request: HrOnboardingRequest): unknown {
  return {
    type: "bubble", ...hero(request.pictureUrl),
    body: { type: "box", layout: "vertical", spacing: "sm", contents: [
      textBlock("👤 คำขอพนักงานใหม่", "lg", "bold"), textBlock(`ชื่อ LINE: ${safeText(request.displayName)}`),
      textBlock(`LINE: ${maskLineId(request.externalUserId)}`), textBlock(`ส่งคำขอ: ${requestTime(request.requestedAt)}`),
      textBlock("สถานะ: รอ Owner เพิ่มเข้าระบบ"),
    ] },
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
      button("✅ เพิ่มพนักงาน", `HR ADD ${request.requestId}`, "primary"), button("🔗 พนักงานเดิม", `HR STAFF ${request.requestId}`), button("❌ ปฏิเสธ", `HR DECLINE ${request.requestId}`),
    ] },
  };
}
function pendingFlex(requests: HrOnboardingRequest[]): unknown { return { type: "flex", altText: `HR: มีคำขอพนักงานใหม่ ${requests.length} คน`, contents: { type: "carousel", contents: requests.slice(0, 10).map(onboardingBubble) } }; }
function addConfirmFlex(request: HrOnboardingRequest): unknown {
  return { type: "flex", altText: `ยืนยันเพิ่มพนักงาน ${safeText(request.displayName)}`, contents: {
    type: "bubble", ...hero(request.pictureUrl), body: { type: "box", layout: "vertical", spacing: "sm", contents: [
      textBlock("✅ ยืนยันเพิ่มพนักงาน", "lg", "bold"), textBlock(`ชื่อ: ${safeText(request.displayName)}`), textBlock(`LINE: ${maskLineId(request.externalUserId)}`),
      textBlock("รหัส: ระบบสร้าง EMPxxx อัตโนมัติ"), textBlock("บทบาท: EMPLOYEE"), textBlock("สาขา: B001 · ยิ่งเจริญ"),
      textBlock("เวลางาน: 04:00–16:00"), textBlock("ค่าแรง: 500 บาท/วัน"), textBlock("ส่ง Expense: ไม่อนุญาต"),
    ] }, footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
      button("✅ ยืนยันเพิ่ม", `HR ADD CONFIRM ${request.requestId}`, "primary"), button("🔗 เป็นพนักงานเดิม", `HR STAFF ${request.requestId}`), button("↩️ กลับ", "HR"),
    ] },
  } };
}
function staffChoiceBubble(request: HrOnboardingRequest, staff: UnboundStaff): unknown {
  return { type: "bubble", body: { type: "box", layout: "vertical", spacing: "sm", contents: [
    textBlock("🔗 เชื่อมพนักงานเดิม", "lg", "bold"), textBlock(`ผู้ขอ LINE: ${safeText(request.displayName)}`), textBlock(`รหัส: ${staff.employeeId}`),
    textBlock(`ชื่อพนักงาน: ${safeText(staff.staffName)}`), textBlock(`บทบาท: ${staff.role}`), textBlock(`สาขา: ${staff.branchId || "-"}`),
    textBlock(`เวลา: ${staff.scheduledIn}–${staff.scheduledOut}`), textBlock(`ค่าแรง: ${staff.dailyWageBaht.toLocaleString("th-TH")} บาท/วัน`),
  ] }, footer: { type: "box", layout: "vertical", spacing: "sm", contents: [button(`เลือก ${staff.employeeId}`, `HR LINK ${request.requestId} ${staff.employeeId}`, "primary")] } };
}
function staffChoicesFlex(request: HrOnboardingRequest, staff: UnboundStaff[]): unknown { return { type: "flex", altText: `เลือกข้อมูลพนักงานเดิมสำหรับ ${safeText(request.displayName)}`, contents: { type: "carousel", contents: staff.slice(0, 10).map((item) => staffChoiceBubble(request, item)) } }; }
function linkConfirmFlex(request: HrOnboardingRequest, staff: UnboundStaff): unknown {
  return { type: "flex", altText: `ยืนยันเชื่อม ${staff.employeeId}`, contents: { type: "bubble", ...hero(request.pictureUrl), body: { type: "box", layout: "vertical", spacing: "sm", contents: [
    textBlock("⚠️ ยืนยันตัวบุคคล", "lg", "bold"), textBlock(`บัญชี LINE: ${safeText(request.displayName)}`), textBlock(`LINE: ${maskLineId(request.externalUserId)}`),
    textBlock("จะเชื่อมกับ"), textBlock(`${staff.employeeId} · ${safeText(staff.staffName)}`, "md", "bold"), textBlock(`บทบาท: ${staff.role}`),
    textBlock(`สาขา: ${staff.branchId || "-"}`), textBlock(`เวลา: ${staff.scheduledIn}–${staff.scheduledOut}`), textBlock(`ค่าแรง: ${staff.dailyWageBaht.toLocaleString("th-TH")} บาท/วัน`),
    textBlock("โปรดยืนยันเฉพาะเมื่อแน่ใจว่า LINE นี้เป็นของพนักงานคนดังกล่าว"),
  ] }, footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
    button("✅ ยืนยันเชื่อม", `HR LINK CONFIRM ${request.requestId} ${staff.employeeId}`, "primary"), button("↩️ เลือกใหม่", `HR STAFF ${request.requestId}`), button("❌ ยกเลิก", "HR"),
  ] } } };
}
function ownerOnly(actor: StaffActor | null): actor is StaffActor { return Boolean(actor && actor.role === "OWNER" && authorize(actor, "identity.approve")); }
function errorCode(error: unknown): string { if (!(error instanceof Error)) return "HR_ONBOARDING_FAILED"; const value = error.message.trim(); return /^[A-Z0-9_:-]{3,120}$/.test(value) ? value : "HR_ONBOARDING_FAILED"; }

async function getUnboundStaffById(env: Env, employeeId: string): Promise<UnboundStaff | null> {
  const row = await env.DB.prepare(
    `SELECT e.employee_id,e.staff_name,e.scheduled_in,e.scheduled_out,e.daily_wage_satang,r.role,r.branch_id
     FROM employees e
     JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE'
     LEFT JOIN line_identity_bindings i ON i.employee_id=e.employee_id AND i.provider='LINE' AND i.status='VERIFIED'
     WHERE e.employee_id=? AND e.status='ACTIVE' AND r.role<>'OWNER' AND i.binding_id IS NULL
     LIMIT 1`,
  ).bind(employeeId).first<Record<string, unknown>>();
  if (!row) return null;
  return { employeeId: String(row.employee_id), staffName: String(row.staff_name), role: String(row.role), branchId: row.branch_id == null ? null : String(row.branch_id), scheduledIn: String(row.scheduled_in), scheduledOut: String(row.scheduled_out), dailyWageBaht: Number(row.daily_wage_satang || 0) / 100 };
}

type HrDependencies = {
  importConfiguredStaff?: typeof importEmployeesFromConfiguredSheet;
  getLineProfile?: typeof getLineUserProfile;
  startOnboarding?: typeof startLineFirstOnboarding;
  hasPendingOnboarding?: typeof hasPendingLineFirstOnboarding;
  listOnboarding?: typeof listPendingLineFirstOnboarding;
  getOnboarding?: typeof getLineFirstOnboardingRequest;
  addNew?: typeof approveOnboardingAsNewEmployee;
  listUnboundStaff?: typeof listUnboundActiveStaff;
  getUnboundStaff?: typeof getUnboundStaffById;
  linkExisting?: typeof linkOnboardingToExistingStaff;
  rejectOnboarding?: typeof rejectLineFirstOnboarding;
};

async function ownerOnboardingCommand(env: Env, event: LineEvent, actor: StaffActor | null, traceId: string, text: string, deps: HrDependencies): Promise<boolean> {
  const match = /^HR\s+(ADD|STAFF|LINK|DECLINE)\b\s*(.*)$/i.exec(text);
  if (!match) return false;
  if (!ownerOnly(actor)) { await reply(env, event, "HR onboarding administration is available only to a verified Owner LINE account.", traceId); return true; }
  const action = match[1]!.toUpperCase();
  const args = match[2]!.trim().split(/\s+/).filter(Boolean);
  const getRequest = deps.getOnboarding || getLineFirstOnboardingRequest;
  const listStaff = deps.listUnboundStaff || listUnboundActiveStaff;
  const getStaff = deps.getUnboundStaff || getUnboundStaffById;
  try {
    if (action === "ADD") {
      const confirm = args[0]?.toUpperCase() === "CONFIRM"; const requestId = confirm ? args[1] : args[0];
      if (!requestId) { await reply(env, event, confirm ? "Usage: HR ADD CONFIRM <requestId>" : "Usage: HR ADD <requestId>", traceId); return true; }
      const request = await getRequest(env, requestId);
      if (!request) { await reply(env, event, "ไม่พบคำขอพนักงานใหม่ หรือคำขอนี้หมดสถานะแล้ว", traceId); return true; }
      if (!confirm) { if (request.status !== "PENDING_OWNER_SETUP") { await reply(env, event, `คำขอนี้อยู่ในสถานะ ${request.status}`, traceId); return true; } await replyFlex(env, event, addConfirmFlex(request), traceId, "hr-add-confirm"); return true; }
      const result = await (deps.addNew || approveOnboardingAsNewEmployee)(env, requestId, actor, traceId);
      await reply(env, event, `✅ เพิ่มพนักงานสำเร็จ\nรหัส: ${result.employeeId}\nชื่อ: ${result.staffName}\nบทบาท: EMPLOYEE\nสาขา: B001 · ยิ่งเจริญ\nค่าแรง: 500 บาท/วัน\nเวลา: 04:00–16:00\nLINE: เชื่อมต่อแล้ว\nสถานะ: ACTIVE\n\nระบบจะอัปเดต HR_STAFF_CONFIG ให้อัตโนมัติ${result.idempotent ? "\n(รายการนี้เคยยืนยันแล้ว)" : ""}`, traceId);
      return true;
    }
    if (action === "STAFF") {
      const requestId = args[0]; if (!requestId) { await reply(env, event, "Usage: HR STAFF <requestId>", traceId); return true; }
      const request = await getRequest(env, requestId); if (!request || request.status !== "PENDING_OWNER_SETUP") { await reply(env, event, "คำขอนี้ไม่พร้อมสำหรับการเชื่อมพนักงานเดิม", traceId); return true; }
      const staff = await listStaff(env); if (!staff.length) { await reply(env, event, `ไม่พบพนักงาน ACTIVE ที่ยังไม่ได้เชื่อม LINE\nหากเป็นพนักงานใหม่ ให้พิมพ์ HR ADD ${requestId}`, traceId); return true; }
      await replyFlex(env, event, staffChoicesFlex(request, staff), traceId, "hr-staff-list"); return true;
    }
    if (action === "LINK") {
      const confirm = args[0]?.toUpperCase() === "CONFIRM"; const requestId = confirm ? args[1] : args[0]; const employeeId = confirm ? args[2] : args[1];
      if (!requestId || !employeeId) { await reply(env, event, confirm ? "Usage: HR LINK CONFIRM <requestId> <employeeId>" : "Usage: HR LINK <requestId> <employeeId>", traceId); return true; }
      const request = await getRequest(env, requestId); if (!request) { await reply(env, event, "ไม่พบคำขอพนักงานใหม่", traceId); return true; }
      if (!confirm) {
        if (request.status !== "PENDING_OWNER_SETUP") { await reply(env, event, `คำขอนี้อยู่ในสถานะ ${request.status}`, traceId); return true; }
        // Validate the exact Staff ID directly, not against the 20-row browse list.
        // This keeps manual exact-ID selection reachable even when the store grows.
        const staff = await getStaff(env, employeeId);
        if (!staff) { await reply(env, event, "ไม่พบพนักงานนี้ หรือพนักงานเชื่อม LINE แล้ว", traceId); return true; }
        await replyFlex(env, event, linkConfirmFlex(request, staff), traceId, "hr-link-confirm"); return true;
      }
      const result = await (deps.linkExisting || linkOnboardingToExistingStaff)(env, requestId, employeeId, actor, traceId);
      await reply(env, event, `✅ เชื่อม LINE กับพนักงานสำเร็จ\nรหัส: ${result.employeeId}\nชื่อ: ${result.staffName}\nLINE: เชื่อมต่อแล้ว\nสถานะ: ACTIVE\n\nระบบจะอัปเดต HR_STAFF_CONFIG ให้อัตโนมัติ${result.idempotent ? "\n(รายการนี้เคยยืนยันแล้ว)" : ""}`, traceId);
      return true;
    }
    const requestId = args[0]; if (!requestId) { await reply(env, event, "Usage: HR DECLINE <requestId>", traceId); return true; }
    await (deps.rejectOnboarding || rejectLineFirstOnboarding)(env, requestId, actor, "Owner declined LINE onboarding");
    await reply(env, event, "ปฏิเสธคำขอพนักงานแล้ว หากเป็นการกดผิด พนักงานสามารถพิมพ์ HR ใหม่ได้", traceId); return true;
  } catch (error) { await reply(env, event, `ดำเนินการ HR ไม่สำเร็จ\nCode: ${errorCode(error)}\nกรุณาพิมพ์ HR เพื่อดูสถานะล่าสุด`, traceId); return true; }
}

export async function handleHrText(env: Env, event: LineEvent, actor: StaffActor | null, traceId: string, deps: HrDependencies = {}): Promise<boolean> {
  const text = (event.message?.text || "").trim(), lineUserId = event.source.userId || "";
  if (!lineUserId) return false;
  if (await ownerOnboardingCommand(env, event, actor, traceId, text, deps)) return true;

  const ownerCommand = /^HR\s+(PENDING|APPROVE|REJECT|SYNC)\b\s*(.*)$/i.exec(text);
  if (ownerCommand) {
    if (!ownerOnly(actor)) { await reply(env, event, "HR identity administration is available only to a verified Owner LINE account.", traceId); return true; }
    const action = ownerCommand[1]!.toUpperCase(), args = ownerCommand[2]!.trim();
    if (action === "SYNC") {
      if (args) { await reply(env, event, "Usage: HR SYNC", traceId); return true; }
      try {
        const result = await (deps.importConfiguredStaff || importEmployeesFromConfiguredSheet)(env);
        await reply(env, event, tri(`ซิงก์ข้อมูลพนักงานสำเร็จ (Legacy fallback)\nประมวลผล ${result.count} รายการ\nการเพิ่มพนักงานใหม่ตามปกติไม่ต้องเปิดชีทหรือใช้ HR SYNC`, `HR staff sync completed (legacy fallback).\nProcessed ${result.count} staff rows.\nNormal new-employee onboarding no longer requires the sheet or HR SYNC.`, `HR staff sync ပြီးပါပြီ (legacy fallback)။\nပုံမှန်ဝန်ထမ်းအသစ်များအတွက် Sheet သို့မဟုတ် HR SYNC မလိုတော့ပါ။`), traceId);
      } catch {
        await reply(env, event, tri("ซิงก์ข้อมูลพนักงานไม่สำเร็จ\nการเพิ่มพนักงานใหม่ให้ใช้ LINE-first: พนักงานพิมพ์ HR แล้ว Owner จัดการต่อจาก HR", "HR staff sync failed.\nFor new staff, use LINE-first onboarding: employee sends HR and Owner completes setup from HR.", "HR staff sync မအောင်မြင်ပါ။ ဝန်ထမ်းအသစ်သည် HR ပို့ပြီး Owner က HR မှ ဆက်လက်စီမံပါ။"), traceId);
      }
      return true;
    }
    if (action === "PENDING") {
      const requests = await listIdentityLinkRequests(env);
      const rows = requests.map((request) => `${request.requestId} | ${request.requestedStaffId || "-"} | ${request.staffName || "-"} | ${request.role || "-"} | ${request.branchName || "All branches"}`).join("\n");
      await reply(env, event, rows ? `Legacy HR registration requests\n${rows}` : "Legacy HR registration requests\nNo pending requests.", traceId); return true;
    }
    const [requestId, ...reasonParts] = args.split(/\s+/).filter(Boolean);
    if (!requestId) { await reply(env, event, `Usage: HR ${action} <requestId>${action === "REJECT" ? " <reason>" : ""}`, traceId); return true; }
    if (action === "APPROVE") { const result = await approveIdentityLinkRequest(env, requestId, actor); await reply(env, event, `HR identity approved.\nStaff ID: ${result.employeeId}\nStatus: VERIFIED${result.idempotent ? " (already approved)" : ""}`, traceId); return true; }
    const reason = reasonParts.join(" ").trim(); if (reason.length < 3) { await reply(env, event, "Usage: HR REJECT <requestId> <reason>", traceId); return true; }
    await rejectIdentityLinkRequest(env, requestId, actor, reason); await reply(env, event, `HR identity request rejected.\nRequest ID: ${requestId}`, traceId); return true;
  }

  if (/^HR$/i.test(text)) {
    if (actor?.role === "OWNER" && ownerOnly(actor)) {
      const requests = await (deps.listOnboarding || listPendingLineFirstOnboarding)(env);
      if (requests.length) { await replyFlex(env, event, pendingFlex(requests), traceId, "hr-owner-pending"); return true; }
      await reply(env, event, `${profile(actor)}\n\n👥 คำขอพนักงานใหม่: 0\nพนักงานใหม่ให้พิมพ์ HR จาก LINE ของตัวเองเพียงครั้งเดียว แล้ว Owner กลับมาพิมพ์ HR เพื่อจัดการ`, traceId); return true;
    }
    if (actor) { await reply(env, event, profile(actor), traceId); return true; }
    let lineProfile: { displayName: string; pictureUrl: string };
    try { lineProfile = await (deps.getLineProfile || getLineUserProfile)(env, lineUserId); } catch { lineProfile = { displayName: "LINE user", pictureUrl: "" }; }
    const request = await (deps.startOnboarding || startLineFirstOnboarding)(env, lineUserId, lineProfile);
    await reply(env, event, tri(`✅ รับคำขอลงทะเบียนแล้ว\nชื่อ LINE: ${safeText(request.displayName)}\nสถานะ: รอ Owner เพิ่มเข้าระบบ\n\nไม่ต้องพิมพ์รหัสพนักงานหรือข้อมูลเพิ่มเติม`, `✅ Registration request received.\nLINE name: ${safeText(request.displayName)}\nStatus: waiting for Owner setup.\n\nNo Staff ID or additional information is required.`, `✅ မှတ်ပုံတင်တောင်းဆိုချက်ကို လက်ခံရရှိပါပြီ။\nLINE အမည်: ${safeText(request.displayName)}\nOwner ထံမှ အတည်ပြုချက်ကို စောင့်ပါ။\n\nStaff ID သို့မဟုတ် အခြားအချက်အလက်များ မရိုက်ထည့်ရပါ။`), traceId); return true;
  }

  if (!actor && /^[A-Za-z0-9_-]{1,40}$/.test(text)) {
    if (await (deps.hasPendingOnboarding || hasPendingLineFirstOnboarding)(env, lineUserId)) { await reply(env, event, tri("ได้รับคำขอ HR แล้ว ไม่ต้องพิมพ์รหัสพนักงาน กรุณารอ Owner ดำเนินการ", "Your HR request is already waiting for Owner setup. You do not need to enter a Staff ID.", "HR တောင်းဆိုချက်ကို Owner စီမံရန် စောင့်ဆိုင်းနေပါသည်။ Staff ID မရိုက်ထည့်ရပါ။"), traceId); return true; }
    const result = await submitHrStaffId(env, lineUserId, text);
    if (result.ok) await reply(env, event, tri(`ได้รับคำขอลงทะเบียนแบบเดิมแล้ว\nพนักงาน: ${result.staffName}\nรอ Owner อนุมัติ`, `Legacy registration request received.\nStaff: ${result.staffName}\nWaiting for Owner approval.`, `မှတ်ပုံတင်တောင်းဆိုချက်ကို လက်ခံရရှိပါပြီ။ Owner အတည်ပြုချက်ကို စောင့်ပါ။`), traceId);
    else if (result.code !== "HR_REGISTRATION_NOT_STARTED") await reply(env, event, tri("ลงทะเบียนไม่สำเร็จ\nกรุณาพิมพ์ HR เพื่อเริ่มขั้นตอนใหม่", `Registration was not accepted.\nCode: ${result.code}\nSend HR to start the new flow.`, "မှတ်ပုံတင်ခြင်း မအောင်မြင်ပါ။ HR ပို့ပြီး အသစ်စတင်ပါ။"), traceId);
    else return false;
    return true;
  }
  return false;
}

export async function requestOwnAttendanceCorrection(env: Env, event: LineEvent, actor: StaffActor, raw: string, traceId: string): Promise<boolean> {
  if (!/^CORRECT\s+/i.test(raw.trim())) return false;
  if (!authorize(actor, "staff.self.low_risk_update", { employeeId: actor.employeeId })) { await reply(env, event, "Not authorized.", traceId); return true; }
  const reason = raw.replace(/^CORRECT\s+/i, "").trim();
  if (reason.length < 3) { await reply(env, event, "Correction request needs a short reason. Example: CORRECT missing OUT 2026-07-29", traceId); return true; }
  const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(reason)?.[0];
  const request = await createEmployeeChangeRequest(env, actor, { requestType: "ATTENDANCE_CORRECTION", ...(date ? { workDate: date } : {}), reason });
  await reply(env, event, `Correction request received.\nRequest ID: ${request.requestId}\nStatus: PENDING REVIEW`, traceId); return true;
}
