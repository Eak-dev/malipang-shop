// Prints the allowlisted diagnostic of one clock case from a private TAP file and,
// with --test-exit, decides the run. The TAP holds private readings, so only a
// line whose keys and value types match exactly is printed; anything else prints
// nothing. Verdict reasons are fixed codes, never reading values.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CASE = /^photo-0[1-7]$/;
const CODE = /^[A-Z_]{1,40}$/;
const PROVIDERS = ['openai', 'workers-ai', 'pipeline', 'none', 'openai-error', 'unrecognised'];
const FLAGS = ['accepted', 'clockPresent', 'overlayPresent', 'timestampPresent', 'gpsPresent'];
const KEYS = ['id', 'provider', 'accepted', 'validationCode', 'clockPresent', 'overlayPresent', 'timestampPresent', 'gpsPresent'];
// Acceptance for photo-07: the reader saw the white overlay, found no date/time in it,
// and validation stopped there (src/domain/attendance.ts order).
export const EXPECTED_CODE = 'TIMESTAMP_FIELDS_MISSING';

/** The one allowlisted diagnostic object of the case, or null. */
export function diagnosticOf(tap, caseId) {
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
  return found.length === 1 ? found[0] : null;
}

export function summarize(tap, caseId) {
  const d = diagnosticOf(tap, caseId);
  return d && [d.id, `provider=${d.provider}`, `validationCode=${d.validationCode}`, ...FLAGS.map(k => `${k}=${d[k]}`)].join(' ');
}

/** PASS only for a clean test run that rejected for missing overlay date/time. */
export function verdict(tap, caseId, testExit) {
  if (tap.includes('ISSUE348_TRANSPORT_OUTCOME_UNKNOWN')) return 'FAIL TRANSPORT_OUTCOME_UNKNOWN';
  const d = diagnosticOf(tap, caseId);
  if (!d) return 'FAIL DIAGNOSTIC_UNAVAILABLE';
  if (d.accepted) return 'FAIL ACCEPTED';
  if (d.timestampPresent) return 'FAIL TIMESTAMP_PRESENT';
  if (d.validationCode !== EXPECTED_CODE) return 'FAIL OTHER_REJECTION_CODE';
  if (testExit !== 0) return 'FAIL TEST_FAILED';
  return 'PASS EXPECTED_REJECTION';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, caseId = '', flag, exitText] = process.argv.slice(2);
  let tap = '';
  try { tap = readFileSync(file, 'utf8'); } catch { tap = ''; }
  console.log(summarize(tap, caseId) ?? 'diagnostic unavailable');
  if (flag === '--test-exit') {
    const testExit = /^\d{1,3}$/.test(exitText ?? '') ? Number(exitText) : -1;
    const result = verdict(tap, caseId, testExit);
    console.log(`verdict: ${result}`);
    if (!result.startsWith('PASS ')) process.exitCode = 1;
  } else if (!summarize(tap, caseId)) process.exitCode = 1;
}
