// A manual dispatch consumes one explicit list of missing cases. The fixture and
// its fetch guard both get exactly one ID per process, with no retry or fallback.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {diagnosticOf, verdict} from './issue348-photo-diagnostic-summary.mjs';

const origin = 'https://malipang-backend-v5-2.eakkachai-dev.workers.dev';
const guard = fileURLToPath(new URL('./issue348-guard-photo-fetch.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../tests/clock-photo-fixtures.test.mjs', import.meta.url));
const env = process.env;

function dispatchIds() {
  const {inputs} = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'Eak-dev/malipang-shop'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1'
      || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) || env.GITHUB_SHA !== inputs.expected_main_sha) throw Error();
  if (typeof inputs.approved_photo_ids !== 'string') throw Error();
  const ids = inputs.approved_photo_ids.split(',').map(id => id.trim());
  if (ids.length > 7 || ids.some(id => !/^photo-0[1-7]$/.test(id)) || new Set(ids).size !== ids.length) throw Error();
  return ids;
}

function evaluate(id) {
  // Raw TAP is held privately in memory. Require one case, the parent suite,
  // and the diagnostic from the expected provider before recording success.
  const child = spawnSync(process.execPath, [
    '--import', guard, '--test', '--test-reporter=tap', '--test-concurrency=1',
    '--test-name-pattern=^live vision enforces', fixture,
  ], {env:{...env, MALIPANG_LIVE_TESTS:'clock-photos', MALIPANG_VISION_PROVIDER:'openai',
    MALIPANG_OPENAI_MODEL:'gpt-4.1-mini', MALIPANG_CLOCK_DIAGNOSTIC_CASE:id, ISSUE348_ONLY_CASE:id,
    ISSUE348_ATTENDANCE_UAT:'1'},
    encoding:'utf8', timeout:150000});
  const tap = (child.stdout ?? '') + '\n' + (child.stderr ?? '');
  const diagnostic = diagnosticOf(tap, id);
  if (child.error || child.signal || /^(?:# )?ISSUE348_TRANSPORT_OUTCOME_UNKNOWN$/m.test(tap)
      || !/^(?:# )?ISSUE348_EVALUATOR_RESPONDED$/m.test(tap)) return 'UNKNOWN';
  if (!diagnostic) return 'FAIL';
  const passed = child.status === 0 && diagnostic.provider === 'openai' && /^# pass 2$/m.test(tap)
    && (id !== 'photo-07' || verdict(tap, id, child.status) === 'PASS EXPECTED_REJECTION');
  return passed ? 'PASS' : 'FAIL';
}

function main() {
  const ids = dispatchIds();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check-dispatch') return 0;
  if (args.length || env.MALIPANG_VISION_BASE_URL !== origin || !env.MALIPANG_CLOCK_PRIVATE_MANIFEST) throw Error();
  const {cases} = JSON.parse(readFileSync(env.MALIPANG_CLOCK_PRIVATE_MANIFEST, 'utf8'));
  const order = cases.map(row => row.id).filter(id => ids.includes(id));
  if (order.length !== ids.length || new Set(order).size !== ids.length) throw Error();
  for (const id of order) {
    const result = evaluate(id);
    console.log((result === 'PASS' ? 'ok ' : 'not ok ') + id);
    if (result === 'UNKNOWN') console.log('ISSUE348_TRANSPORT_OUTCOME_UNKNOWN');
    if (result !== 'PASS') return 1;
  }
  return 0;
}

try { process.exitCode = main(); }
catch { console.log('ISSUE348_INPUT_REJECTED'); process.exitCode = 1; }
