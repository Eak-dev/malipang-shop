import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Runs the real candidate shell script, real jq, and the real stage guard.
// All network/Cloudflare/Wrangler interactions are synthetic fixtures.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const jqProbe = spawnSync(process.env.MP248_JQ_PATH || 'jq', ['--version'], {encoding:'utf8'});
const jqAvailable = jqProbe.status === 0 && /^jq-/.test(jqProbe.stdout);
if (!jqAvailable && (process.env.CI || process.env.MP248_JQ_PATH)) {
  throw new Error('A working jq is required on CI and when MP248_JQ_PATH is set');
}
const jqTestOptions = {skip: jqAvailable ? false : 'jq is not installed locally'};
const sha = 'a'.repeat(40);
const g5 = '11111111-1111-4111-8111-111111111111';
const g6 = '22222222-2222-4222-8222-222222222222';
const prior = '310192aa-8a04-4b61-8a72-4455231b3339';
const queue = 'synthetic-queue';

function run(mode, d1Override) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mp248-snapshot-test-'));
  try {
    mkdirSync(path.join(dir, 'node_modules/.bin'), {recursive: true});
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(path.join(root, 'scripts/pr247-stage-guard.mjs'), path.join(dir, 'scripts/pr247-stage-guard.mjs'));
    if (process.env.MP248_JQ_PATH) symlinkSync(process.env.MP248_JQ_PATH, path.join(dir, 'bin/jq'));
    const data = {
      migration: '0023_stable_recovery_admission.sql', recovery_tables: 4,
      review: 1, review_all: 1, held: 0, inflight: 0,
      epoch_total: 0, epoch_active: 0, epoch_complete: 0,
      unverified_ops: 0, verified_ops: 0, completed: 3296, open_failed: 32,
      canary_jobs_completed: 0, canary_daily: 0, canary_raw: 0, canary_detail: 0
    };
    const fixture = {
      receipt: {release:'PR247', state:'VERIFIED_COMPLETED', expected_sha:sha,
        prior_worker_version:prior, queue_was_active:true, queue_id:queue},
      cron: {success:true,result:{schedules:[{cron:'*/5 * * * *'}]}},
      queues: {success:true,result:[{queue_name:'malipang-jobs',queue_id:queue,settings:{delivery_paused:false}}]},
      deploy: {success:true,result:{deployments:[{versions:[{version_id:mode==='A_POST'?g6:g5,percentage:100}]}]}},
      status: {ok:true,inFlightProjections:0,claim:{state:'REVIEW',notice_stamp:'2026-11-05 21:26:00'},
        recoveryGate:{mode:mode==='A_POST'?'UNARMED':'DISABLED'},
        sheetPacing:{mode:mode==='A_POST'?'UNARMED':'DISABLED'}},
      d1: d1Override === undefined ? [{results:[data],success:true,meta:{changed_db:false,rows_written:0}}] : d1Override(data)
    };
    for (const [key, value] of Object.entries(fixture))
      writeFileSync(path.join(dir, key+'.json'), JSON.stringify(value));
    writeFileSync(path.join(dir, 'node_modules/.bin/wrangler'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == r2 && "$2" == object && "$3" == get ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --file=* ]]; then target="$(printf '%s' "$1" | cut -c8-)"; cp "$FIXTURE_DIR/receipt.json" "$target"; exit 0; fi
    if [[ "$1" == --file ]]; then cp "$FIXTURE_DIR/receipt.json" "$2"; exit 0; fi
    shift
  done
  exit 12
fi
if [[ "$1" == d1 && "$2" == execute ]]; then cat "$FIXTURE_DIR/d1.json"; exit 0; fi
exit 13
`, {mode:0o755});
    writeFileSync(path.join(dir, 'bin/curl'), `#!/bin/bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */schedules) cat "$FIXTURE_DIR/cron.json"; exit 0;;
    */queues) cat "$FIXTURE_DIR/queues.json"; exit 0;;
    */deployments) cat "$FIXTURE_DIR/deploy.json"; exit 0;;
    */admin/stable-sync/status) cat "$FIXTURE_DIR/status.json"; exit 0;;
  esac
done
exit 14
`, {mode:0o755});
    const out = path.join(dir, 'snapshot.json');
    const result = spawnSync('bash', [path.join(root,'scripts/pr247-readonly-snapshot.sh'), mode, out], {
      cwd: dir, encoding:'utf8', timeout: 15000,
      env: {...process.env, PATH:path.join(dir,'bin')+':'+process.env.PATH, FIXTURE_DIR:dir,
        CLOUDFLARE_ACCOUNT_ID:'synthetic', CLOUDFLARE_API_TOKEN:'synthetic',
        MALIPANG_ADMIN_TOKEN:'synthetic', MALIPANG_WORKER_URL:'https://synthetic.invalid',
        G5_RUN_ID:'123', G5_RUN_ATTEMPT:'1', G5_SHA:sha,
        EXPECTED_WORKER_VERSION:mode==='A_POST'?g6:g5,
        PRIOR_WORKER_VERSION:g5, COMPLETED_BEFORE:'3296', OPEN_FAILED_BEFORE:'32'}
    });
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,
      snapshot:result.status===0?JSON.parse(readFileSync(out,'utf8')):null};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

for (const mode of ['A_PRE','A_POST']) test(mode+' realistic Wrangler array reaches actual guard',jqTestOptions,()=>{
  const result=run(mode);
  assert.equal(result.status,0, result.stderr);
  assert.match(result.stdout, new RegExp('STAGE_GUARD_'+mode+'_PASS'));
  assert.equal(result.snapshot.d1.migration, '0023_stable_recovery_admission.sql');
  assert.equal(result.snapshot.d1.review,1);
});
for (const [name,make] of [
  ['empty array',()=>[]],
  ['multiple statements',d=>[{success:true,results:[d]},{success:true,results:[d]}]],
  ['missing result list',()=>[{success:true}]],
  ['non-array results',d=>[{success:true,results:d}]],
  ['empty results',()=>[{success:true,results:[]}]],
  ['multiple result rows',d=>[{success:true,results:[d,d]}]],
  ['failed query',d=>[{success:false,results:[d]}]],
  ['null row',()=>[{success:true,results:[null]}]],
  ['wrong count type',d=>[{success:true,results:[{...d,completed:'3296'}]}]],
  ['held claim',d=>[{success:true,results:[{...d,held:1}]}]]
]) test('reject '+name+' without producing a PASS',jqTestOptions,()=>{
  const result=run('A_PRE',make);
  assert.notEqual(result.status,0, result.stdout);
  assert.doesNotMatch(result.stdout,/STAGE_GUARD_A_PRE_PASS/);
});
