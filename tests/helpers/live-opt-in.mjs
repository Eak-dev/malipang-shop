// Live suites call a real Worker or use private images, so public/default CI
// never runs them. A run opts in by naming suites in MALIPANG_LIVE_TESTS
// (comma separated, or "all"). Once selected, a suite must fail when an input
// is missing; it is never skipped.
export const LIVE_SUITES=Object.freeze(['clock-photos','bank-slips','expense-text','online-order-images']);
// The owner deferred the three online-order image cases, so "all" leaves them out.
const EXPLICIT_ONLY=new Set(['online-order-images']);

export function liveSelected(suite,value=process.env.MALIPANG_LIVE_TESTS){
  if(!LIVE_SUITES.includes(suite))throw Error(`unknown live suite: ${suite}`);
  const names=String(value||'').split(',').map(name=>name.trim()).filter(Boolean);
  for(const name of names)if(name!=='all'&&!LIVE_SUITES.includes(name))throw Error(`MALIPANG_LIVE_TESTS has an unknown suite: ${name}`);
  return names.includes(suite)||(names.includes('all')&&!EXPLICIT_ONLY.has(suite));
}

/** node:test `skip` option: false when selected, otherwise the opt-in reason. */
export const liveSkip=suite=>liveSelected(suite)?false:`live suite not selected (set MALIPANG_LIVE_TESTS=${suite})`;
