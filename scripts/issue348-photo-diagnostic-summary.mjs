// Prints the allowlisted diagnostic of one clock case from a private TAP file.
// The TAP holds private readings, so only a line whose keys and value types
// match exactly is printed; anything else prints nothing and exits non-zero.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CASE = /^photo-0[1-7]$/;
const CODE = /^[A-Z_]{1,40}$/;
const PROVIDERS = ['openai', 'workers-ai', 'pipeline', 'none', 'openai-error', 'unrecognised'];
const FLAGS = ['accepted', 'clockPresent', 'overlayPresent', 'timestampPresent', 'gpsPresent'];
const KEYS = ['id', 'provider', 'accepted', 'validationCode', 'clockPresent', 'overlayPresent', 'timestampPresent', 'gpsPresent'];

export function summarize(tap, caseId) {
  if (!CASE.test(caseId)) return null;
  const found = [];
  for (const line of tap.split('\n')) {
    const m = /^\s*# (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    if (!d || typeof d !== 'object' || Array.isArray(d) || d.id !== caseId) continue;
    const keys = Object.keys(d);
    if (keys.length !== KEYS.length || !KEYS.every((k, i) => keys[i] === k)) return null;
    if (!PROVIDERS.includes(d.provider) || !CODE.test(d.validationCode) || !FLAGS.every(k => typeof d[k] === 'boolean')) return null;
    found.push(d);
  }
  if (found.length !== 1) return null;
  const d = found[0];
  return [d.id, `provider=${d.provider}`, `validationCode=${d.validationCode}`, ...FLAGS.map(k => `${k}=${d[k]}`)].join(' ');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let out = null;
  try { out = summarize(readFileSync(process.argv[2], 'utf8'), process.argv[3] ?? ''); } catch { out = null; }
  if (out) console.log(out);
  else { console.log('diagnostic unavailable'); process.exitCode = 1; }
}
