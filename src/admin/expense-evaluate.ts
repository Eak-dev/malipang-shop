import { parseExpenseText } from "../expense/text-parser";

export function evaluateExpenseText(input: { text?: string; now?: string }): unknown {
  const text = String(input.text || "").trim();
  if (text.length > 500) throw new Error("text must not exceed 500 characters");
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid ISO date-time");
  const parsed = parseExpenseText(text, now);
  return {
    accepted: Boolean(parsed),
    action: parsed ? (parsed.quickSave ? "SAVE_NOW" : "CONFIRM") : "REJECT",
    parsed
  };
}
