// Issue 248 diagnostic: safe summary of a node --test TAP log. Prints only counts and, for each failing
// test, its title, file basename:line, duration, failureType and error code (allowlisted shapes). Never
// prints assertion messages, stdout/stderr, stack traces or environment values. Titles are redacted for
// token-like and long hexadecimal strings and truncated.
// Usage: node issue248-tap-safe-summary.mjs <label> <file.tap>   |   node ... DIFF <a.tap> <b.tap>
import {readFileSync} from 'node:fs';
const clean=t=>t.replace(/Bearer\s+\S+/gi,'Bearer <redacted>').replace(/\b(gh[pousr]_|eyJ)[A-Za-z0-9_.-]+/g,'<redacted>').replace(/\b[0-9a-f]{32,}\b/gi,'<hex>').replace(/[^\x20-\x7e฀-๿]/g,'?').slice(0,160);
function parse(file){
  const lines=readFileSync(file,'utf8').split('\n'),out=[];let counts={};
  for(let i=0;i<lines.length;i++){
    const m=/^(\s*)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(lines[i]);
    const c=/^# (tests|pass|fail|skipped|cancelled|todo|duration_ms) (\S+)$/.exec(lines[i]);if(c)counts[c[1]]=c[2];
    if(!m)continue;
    const r={depth:m[1].length,ok:m[2]==='ok',title:clean(m[3]),skip:m[4]||''};
    // The YAML block that follows this test point (indented "---" ... "...").
    for(let j=i+1;j<lines.length&&!/^\s*\.\.\.\s*$/.test(lines[j])&&!/^\s*(ok|not ok) \d+ - /.test(lines[j]);j++){
      let y;
      if((y=/^\s+duration_ms: ([0-9.]+)$/.exec(lines[j])))r.duration=Math.round(Number(y[1]));
      else if((y=/^\s+failureType: '([A-Za-z]+)'$/.exec(lines[j])))r.failureType=y[1];
      else if((y=/^\s+code: '?([A-Z0-9_]{3,40})'?$/.exec(lines[j])))r.code=y[1];
      else if((y=/^\s+location: '.*\/([^/']+:\d+):\d+'$/.exec(lines[j])))r.location=clean(y[1]);
    }
    out.push(r);
  }
  return {tests:out,counts};
}
const [mode,a,b]=process.argv.slice(2);
if(mode==='DIFF'){
  const fa=new Set(parse(a).tests.filter(t=>!t.ok).map(t=>t.location+' '+t.title));
  const only=parse(b).tests.filter(t=>!t.ok&&!fa.has(t.location+' '+t.title));
  console.log(`### Failing only with the release environment (${only.length})`);
  for(const t of only)console.log(`- ${t.location??'?'} ${t.title} | ${t.duration??'?'}ms | ${t.failureType??'?'} | ${t.code??'?'}`);
}else{
  const {tests,counts}=parse(a);
  console.log(`### ${clean(mode)}: tests=${counts.tests??'?'} pass=${counts.pass??'?'} fail=${counts.fail??'?'} skipped=${counts.skipped??'?'} cancelled=${counts.cancelled??'?'}`);
  for(const t of tests.filter(t=>!t.ok))console.log(`- NOT_OK ${t.location??'?'} ${t.title} | ${t.duration??'?'}ms | ${t.failureType??'?'} | ${t.code??'?'}`);
}
