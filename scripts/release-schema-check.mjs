// Runs the whole suite on the release schema alone (migrations/, what Production
// applies) and compares the failing tests with a reviewed list. Any failure not on
// the list, or a listed test that now passes, fails the check: nothing is skipped.
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const LIST=new URL('../tests/release-schema-expected-failures.json',import.meta.url);

const NOT_OK=/^\s*not ok \d+ - (.+?)(?: # (?:TODO|SKIP).*)?$/;
/** Names of every failing test or subtest in a TAP stream. */
export function failingNames(tap){
  const names=new Set();
  for(const line of tap.split('\n')){const m=NOT_OK.exec(line);if(m)names.add(m[1]);}
  return names;
}

/** Compares failures with the reviewed list; returns the problems found. */
export function compare(failing,expected){
  const unexpected=[...failing].filter(name=>!Object.hasOwn(expected,name)).sort();
  const stale=Object.keys(expected).filter(name=>!failing.has(name)).sort();
  return{unexpected,stale};
}


const TOTALS=['tests','pass','fail','cancelled','skipped','todo'];
/**
 * Decides a finished child run. The runner itself must have finished normally (no
 * spawn error, no signal, the exit status node --test gives for this failure count)
 * and printed complete, consistent totals before failure names are compared.
 */
export function judge({error,signal,status,tap},expected){
  const problems=[],totals={};
  if(error)problems.push('RUNNER_ERROR');
  if(signal)problems.push('RUNNER_SIGNAL');
  for(const key of TOTALS){
    const found=[...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`,'gm'))];
    if(found.length!==1){problems.push('TOTALS_MISSING');break;}
    totals[key]=Number(found[0][1]);
  }
  if(!problems.includes('TOTALS_MISSING')){
    if(totals.pass+totals.fail+totals.cancelled+totals.skipped+totals.todo!==totals.tests)problems.push('TOTALS_INCONSISTENT');
    if(totals.cancelled!==0)problems.push('CANCELLED');
    if(totals.fail!==tap.split('\n').filter(line=>NOT_OK.test(line)).length)problems.push('FAIL_COUNT_MISMATCH');
    if(status!==(totals.fail>0?1:0))problems.push('EXIT_STATUS_UNEXPECTED');
  }
  const {unexpected,stale}=compare(failingNames(tap),expected);
  if(unexpected.length)problems.push('UNEXPECTED_FAILURES');
  if(stale.length)problems.push('STALE_EXPECTED_FAILURES');
  return{problems,totals,unexpected,stale};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const expected=JSON.parse(readFileSync(LIST,'utf8')).failures;
  for(const [name,reason] of Object.entries(expected))if(typeof reason!=='string'||reason.length<10)throw Error(`reason required for: ${name}`);
  const files=readdirSync(new URL('../tests/',import.meta.url)).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>`tests/${n}`);
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{env:{...process.env,MALIPANG_TEST_SCHEMA:'release'},encoding:'utf8',maxBuffer:512*1024*1024});
  const result=judge({error:run.error,signal:run.signal,status:run.status,tap:run.stdout||''},expected);
  console.log(TOTALS.map(key=>`# ${key} ${result.totals[key]??'?'}`).join('\n'));
  console.log(`runner: status=${run.status} signal=${run.signal??'none'} error=${run.error?.code??'none'}`);
  for(const name of result.unexpected)console.log(`UNEXPECTED failure on release schema: ${name}`);
  for(const name of result.stale)console.log(`STALE expected failure (now passes; remove it from the list): ${name}`);
  if(result.problems.length){console.log(`release schema check failed: ${result.problems.join(', ')}`);process.exitCode=1;}
  else console.log(`release schema: ${Object.keys(expected).length} reviewed expected failures, no other failure`);
}
