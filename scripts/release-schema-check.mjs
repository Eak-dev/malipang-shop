// Runs the whole suite on the release schema alone (migrations/, what Production
// applies) and compares the failing tests with a reviewed list. Any failure not on
// the list, or a listed test that now passes, fails the check: nothing is skipped.
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const LIST=new URL('../tests/release-schema-expected-failures.json',import.meta.url);

/** Names of every failing test or subtest in a TAP stream. */
export function failingNames(tap){
  const names=new Set();
  for(const line of tap.split('\n')){const m=/^\s*not ok \d+ - (.+?)(?: # (?:TODO|SKIP).*)?$/.exec(line);if(m)names.add(m[1]);}
  return names;
}

/** Compares failures with the reviewed list; returns the problems found. */
export function compare(failing,expected){
  const unexpected=[...failing].filter(name=>!Object.hasOwn(expected,name)).sort();
  const stale=Object.keys(expected).filter(name=>!failing.has(name)).sort();
  return{unexpected,stale};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const expected=JSON.parse(readFileSync(LIST,'utf8')).failures;
  for(const [name,reason] of Object.entries(expected))if(typeof reason!=='string'||reason.length<10)throw Error(`reason required for: ${name}`);
  const files=readdirSync(new URL('../tests/',import.meta.url)).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>`tests/${n}`);
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{env:{...process.env,MALIPANG_TEST_SCHEMA:'release'},encoding:'utf8',maxBuffer:512*1024*1024});
  const tap=run.stdout||'';
  const totals=tap.split('\n').filter(l=>/^# (tests|pass|fail|cancelled|skipped) \d+$/.test(l));
  if(!totals.length){console.error('release-schema run produced no TAP totals');process.exit(1);}
  console.log(totals.join('\n'));
  const {unexpected,stale}=compare(failingNames(tap),expected);
  for(const name of unexpected)console.log(`UNEXPECTED failure on release schema: ${name}`);
  for(const name of stale)console.log(`STALE expected failure (now passes; remove it from the list): ${name}`);
  if(/^# cancelled [1-9]/m.test(tap)){console.log('cancelled tests on release schema');process.exitCode=1;}
  if(unexpected.length||stale.length)process.exitCode=1;
  else console.log(`release schema: ${Object.keys(expected).length} reviewed expected failures, no other failure`);
}
