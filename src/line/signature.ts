function toBase64(bytes: ArrayBuffer): string {
  let binary = ""; for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b); return btoa(binary);
}
export async function verifyLineSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toBase64(digest), signature);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; let diff=0; for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}
