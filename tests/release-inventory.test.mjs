import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localMigrations,pendingMigrations} from '../scripts/prod-ops-snapshot.mjs';
import {migrationFiles} from './helpers/migration-files.mjs';

// The release workflow reads localMigrations() for preflight, migrate and the
// deploy guard. Draft files must never appear there.
test('release inventory ends at 0067 and holds no serial draft file',()=>{
  const local=localMigrations();
  assert.equal(local.at(-1),'0067_monthly_report_journal.sql');
  assert.ok(!local.some(name=>/^00(6[89]|7\d)_/.test(name)),'no draft number in the release inventory');
  const config=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(config,/"migrations_dir":\s*"migrations"/,'wrangler applies migrations/ only');
});

test('a ledger at 0067 leaves nothing pending, so the deploy guard does not ask for a migrate',()=>{
  const local=localMigrations();
  assert.deepEqual(pendingMigrations(local.slice(),local),[]);
  assert.deepEqual(pendingMigrations(local.slice(0,-1),local),['0067_monthly_report_journal.sql']);
});

test('the default test schema still includes all twelve drafts after the release files',()=>{
  const names=migrationFiles({draft:true}).map(file=>file.name),release=localMigrations();
  assert.equal(names.length,release.length+12);
  assert.deepEqual(names.slice(release.length).map(name=>Number(name.slice(0,4))),Array.from({length:12},(_,i)=>68+i));
  assert.deepEqual(migrationFiles({draft:false}).map(file=>file.name),localMigrations());
});

test('release-schema check reports unexpected and stale failures, nothing else',async()=>{
  const {failingNames,compare}=await import('../scripts/release-schema-check.mjs');
  const tap=['not ok 1 - top level','    not ok 2 - nested case','ok 3 - passing','not ok 4 - skipped one # SKIP reason'].join('\n');
  const failing=failingNames(tap);
  assert.deepEqual([...failing].sort(),['nested case','skipped one','top level']);
  assert.deepEqual(compare(failing,{'top level':'r','nested case':'r','skipped one':'r'}),{unexpected:[],stale:[]});
  assert.deepEqual(compare(failing,{'top level':'r','gone':'r'}),{unexpected:['nested case','skipped one'],stale:['gone']});
});
