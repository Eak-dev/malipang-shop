import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localMigrations,pendingMigrations} from '../scripts/prod-ops-snapshot.mjs';
import {migrationFiles} from './helpers/migration-files.mjs';

// The release workflow reads localMigrations() for preflight, migrate and the
// deploy guard. Draft files must never appear there.
const historicalAudit='0068_issue296_historical_daily_audit.sql';

test('release inventory ends at the historical audit and excludes all serial drafts',()=>{
  const local=localMigrations();
  const drafts=migrationFiles({draft:true}).filter(file=>file.url.pathname.includes('/migrations-draft/'));
  assert.equal(local.at(-1),historicalAudit);
  assert.ok(drafts.every(file=>!local.includes(file.name)));
  assert.ok(drafts.some(file=>file.name==='0068_serial_round_evidence.sql'));
  const config=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(config,/"migrations_dir":\s*"migrations"/,'wrangler applies migrations/ only');
});

test('a ledger at 0067 leaves only the historical audit pending',()=>{
  const local=localMigrations();
  assert.deepEqual(pendingMigrations(local.slice(),local),[]);
  assert.deepEqual(pendingMigrations(local.slice(0,-1),local),[historicalAudit]);
});

test('the default test schema applies canonical release files before the twelve serial drafts',()=>{
  const names=migrationFiles({draft:true}).map(file=>file.name),release=localMigrations();
  assert.deepEqual(names.slice(0,release.length),release);
  assert.deepEqual(names.slice(release.length).map(name=>Number(name.slice(0,4))),Array.from({length:12},(_,i)=>68+i));
  assert.deepEqual(migrationFiles({draft:false}).map(file=>file.name),release);
});

test('release-schema check reports unexpected and stale failures, nothing else',async()=>{
  const {failingNames,compare}=await import('../scripts/release-schema-check.mjs');
  const tap=['not ok 1 - top level','    not ok 2 - nested case','ok 3 - passing','not ok 4 - skipped one # SKIP reason'].join('\n');
  const failing=failingNames(tap);
  assert.deepEqual([...failing].sort(),['nested case','skipped one','top level']);
  assert.deepEqual(compare(failing,{'top level':'r','nested case':'r','skipped one':'r'}),{unexpected:[],stale:[]});
  assert.deepEqual(compare(failing,{'top level':'r','gone':'r'}),{unexpected:['nested case','skipped one'],stale:['gone']});
});

test('release-schema check fails when the runner did not finish normally, even if names match',async()=>{
  const {judge}=await import('../scripts/release-schema-check.mjs');
  const expected={'draft only':'needs the draft schema'};
  const tap=(over={})=>{const t={tests:3,pass:2,fail:1,cancelled:0,skipped:0,todo:0,...over};
    return ['ok 1 - a','ok 2 - b','not ok 3 - draft only',...Object.entries(t).map(([k,v])=>`# ${k} ${v}`)].join('\n');};
  const clean={error:undefined,signal:null,status:1,tap:tap()};
  assert.deepEqual(judge(clean,expected).problems,[]);
  assert.deepEqual(judge({...clean,error:Object.assign(Error('x'),{code:'ENOBUFS'})},expected).problems,['RUNNER_ERROR']);
  assert.deepEqual(judge({...clean,signal:'SIGTERM',status:null},expected).problems,['RUNNER_SIGNAL','EXIT_STATUS_UNEXPECTED']);
  assert.deepEqual(judge({...clean,status:0},expected).problems,['EXIT_STATUS_UNEXPECTED'],'failures must give exit 1');
  assert.deepEqual(judge({...clean,status:7},expected).problems,['EXIT_STATUS_UNEXPECTED']);
  assert.deepEqual(judge({...clean,tap:tap().replace('# todo 0\n','').replace(/\n# todo 0$/,'')},expected).problems,['TOTALS_MISSING'],'a truncated stream fails');
  assert.deepEqual(judge({...clean,tap:tap()+'\n# tests 3'},expected).problems,['TOTALS_MISSING'],'duplicated totals fail');
  assert.deepEqual(judge({...clean,tap:tap({tests:4})},expected).problems,['TOTALS_INCONSISTENT']);
  assert.deepEqual(judge({...clean,tap:tap({tests:4,cancelled:1})},expected).problems,['CANCELLED']);
  assert.deepEqual(judge({...clean,tap:tap({fail:2,tests:4})},expected).problems,['FAIL_COUNT_MISMATCH']);
  assert.deepEqual(judge({...clean,tap:tap().replace('ok 2 - b','not ok 2 - b'),status:1},expected).problems,['FAIL_COUNT_MISMATCH','UNEXPECTED_FAILURES'],'an unlisted failure is caught');
  assert.deepEqual(judge({...clean,tap:tap({fail:0,pass:3}).replace('not ok 3','ok 3'),status:0},expected).problems,['STALE_EXPECTED_FAILURES']);
});
