import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const origin = 'https://malipang-backend-v5-2.eakkachai-dev.workers.dev';
const clock = JSON.parse(readFileSync(process.env.MALIPANG_CLOCK_PRIVATE_MANIFEST)).cases;
const slips = JSON.parse(readFileSync(process.env.MALIPANG_BANK_SLIP_PRIVATE_MANIFEST)).cases;
// Optional: a diagnostic run permits exactly one known clock case and no slips.
const only = process.env.ISSUE348_ONLY_CASE;
if (only !== undefined && !clock.some(row => row.id === only)) throw Error('ISSUE348_ONLY_CASE is not a known clock case');
const allowed = new Map();
for (const row of only === undefined ? [...clock, ...slips] : clock.filter(row => row.id === only)) {
  const url = new URL('/admin/vision/evaluate', origin);
  url.searchParams.set('provider', 'openai');
  if (clock.includes(row)) url.searchParams.set('receivedAt', row.receivedAt);
  url.searchParams.set('model', 'gpt-4.1-mini');
  allowed.set(row.sha256, {url: url.href, overlay: row.verifiedOverlay});
}
const send = globalThis.fetch;
globalThis.fetch = async (target, options) => {
  const hash = createHash('sha256').update(options.body).digest('hex');
  const permitted = allowed.get(hash);
  if (!permitted || target !== permitted.url || options.method !== 'POST') throw Error('Image request outside approved scope');
  allowed.delete(hash);
  let response;
  let result;
  try {
    response = await send(target, {...options, redirect: 'error', signal: AbortSignal.timeout(120000)});
    if (response.ok) result = await response.clone().json();
  } catch {
    console.error('ISSUE348_TRANSPORT_OUTCOME_UNKNOWN');
    throw Error('Transport outcome unknown');
  }
  if (response.ok && permitted.overlay) {
    const reading = result?.reading;
    if (reading?.photoDate !== permitted.overlay.date || reading?.photoTime !== permitted.overlay.time) {
      throw Error('Reviewed overlay mismatch');
    }
  }
  return response;
};
