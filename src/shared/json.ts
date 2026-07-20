export function safeJsonParse<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = safeJsonParse<Record<string, unknown>>(text);
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse(text.slice(start, end + 1));
  return null;
}
