import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-audit.yml',import.meta.url),'utf8');

test('runtime audit keeps protected-main checkout and Production secret scope',()=>{
  assert.match(workflow,/name: Checkout protected main[\s\S]*ref: main/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/AUDIT_CONFIRMATION: \$\{\{ inputs.confirmation \}\}/);
  assert.doesNotMatch(workflow,/if \[\[ "\$\{\{ inputs.confirmation/);
});

test('runtime audit publishes only explicit sanitized evidence files',()=>{
  const upload=workflow.split('uses: actions/upload-artifact@v4')[1];
  const paths=upload.split('path: |')[1].split('if-no-files-found:')[0].trim().split('\n').map(x=>x.trim());
  assert.deepEqual(paths,[
    'runtime-audit/source-sha.txt','runtime-audit/source-config.json','runtime-audit/bindings.json',
    'runtime-audit/worker-versions.json','runtime-audit/health.json','runtime-audit/health-http.txt',
    'runtime-audit/readiness.json','runtime-audit/readiness-http.txt','runtime-audit/status.json','runtime-audit/status-http.txt'
  ]);
  assert.doesNotMatch(upload,/RUNNER_TEMP|raw|\*/);
  assert.match(workflow,/versions list --json > "\$RUNNER_TEMP\/worker-versions.raw.json" 2> "\$RUNNER_TEMP\/worker-versions.raw.stderr"/);
  assert.match(workflow,/sanitize-runtime-audit.mjs versions "\$RUNNER_TEMP\/worker-versions.raw.json" runtime-audit\/worker-versions.json/);
});

test('runtime probes are bounded GET-only, fixed-origin, no redirect or credential argv',()=>{
  assert.match(workflow,/method:'GET',redirect:'error',signal:AbortSignal.timeout\(45000\)/);
  assert.match(workflow,/base.origin!=='https:\/\/malipang-backend-v5-2.eakkachai-dev.workers.dev'/);
  assert.match(workflow,/sanitizeRuntimeAudit\(kind,await response.json\(\)\)/);
  assert.doesNotMatch(workflow,/curl|--header|--verbose|set -x|console\.log/);
  assert.doesNotMatch(workflow,/wrangler (deploy|secret put|d1 migrations)|\/admin\/(retry|reconcile|bootstrap)/);
  assert.match(workflow,/raw response\/error is not published/);
});

test('runtime audit asserts results instead of inferring PASS from artifact existence',()=>{
  for(const name of ['health','readiness','status']){
    assert.ok(workflow.includes(`jq -e '.ok == true' runtime-audit/${name}.json`));
    assert.ok(workflow.includes(`[[ "$${name}_http" == "200" ]]`));
  }
  assert.match(workflow,/\[\[ "\$health_mode" == "production" \]\]/);
  assert.match(workflow,/if\(response.status!==200\|\|safe.ok!==true\)throw new Error\(\)/);
  assert.match(workflow,/Diagnostic GETs may record operational metrics/);
});

function runProbeFixture(scenario,base='https://malipang-backend-v5-2.eakkachai-dev.workers.dev'){
  const code=workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1].split('\n').map(line=>line.slice(10)).join('\n');
  const prefix=`
    import mockFs from 'node:fs';
    const artifacts={}; const calls=[];
    const marker='SYNTHETIC_PRIVATE_MARKER';
    mockFs.writeFileSync=(name,value)=>{artifacts[name]=value;};
    globalThis.fetch=async(url,options)=>{
      const pathname=new URL(url).pathname;
      calls.push({pathname,method:options.method,redirect:options.redirect,authMatches:pathname==='/health'?options.headers.Authorization===undefined:options.headers.Authorization==='Bearer '+marker});
      if(${JSON.stringify(scenario)}==='disconnect')throw new Error(marker);
      const checks=Object.fromEntries(['d1','line','lineReplyCapability','linePushCapacity','sheets','r2','attendanceConfig'].map(k=>[k,{ok:true,detail:{displayName:marker},error:marker}]));
      checks.linePushCapacity.detail={status:'PASS',severity:'OK',pushCapacity:'AVAILABLE',warning:marker};
      const bodies={
        '/health':{ok:true,mode:'production',configured:true,missing:[marker]},
        '/admin/readiness':{ok:true,checks,privateUrl:marker},
        '/admin/status':{ok:true,mode:'production',inbound:[],sync:[],openFailedJobs:4,line:{auth:'PASS',replyCapability:'PASS',push:{pushCapacity:'AVAILABLE',warning:marker}},email:marker}
      };
      return {status:${JSON.stringify(scenario)}==='unauthorized'?401:200,json:async()=>{
        if(${JSON.stringify(scenario)}==='invalid-json')throw new Error(marker);
        return bodies[pathname];
      }};
    };
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',prefix+code+'\nconsole.log(JSON.stringify({artifacts,calls}));'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',
    env:{PATH:process.env.PATH,MALIPANG_WORKER_URL:base,MALIPANG_ADMIN_TOKEN:'SYNTHETIC_PRIVATE_MARKER'},
  });
  assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_PRIVATE_MARKER/);
  return {...result,report:JSON.parse(result.stdout)};
}

test('actual workflow probe block emits only sanitized artifacts with mock responses',()=>{
  const result=runProbeFixture('success');
  assert.equal(result.status,0);
  assert.equal(result.stderr,'');
  assert.deepEqual(result.report.calls.map(x=>x.pathname),['/health','/admin/readiness','/admin/status']);
  assert.ok(result.report.calls.every(x=>x.method==='GET'&&x.redirect==='error'&&x.authMatches));
  assert.equal(Object.keys(result.report.artifacts).length,6);
  for(const kind of ['health','readiness','status'])assert.equal(JSON.parse(result.report.artifacts[`runtime-audit/${kind}.json`]).ok,true);
});

test('actual workflow stops on HTTP, JSON, or network failure without raw diagnostics',()=>{
  for(const scenario of ['unauthorized','invalid-json','disconnect']){
    const result=runProbeFixture(scenario);
    assert.equal(result.status,1,scenario);
    assert.equal(result.report.calls.length,1,scenario);
    assert.equal(result.report.artifacts['runtime-audit/status.json'],undefined);
    assert.match(result.stderr,/raw response\/error is not published/);
  }
});

test('actual workflow refuses token forwarding to another origin or URL credentials',()=>{
  for(const url of ['https://example.invalid','http://malipang-backend-v5-2.eakkachai-dev.workers.dev','https://user:password@malipang-backend-v5-2.eakkachai-dev.workers.dev','https://malipang-backend-v5-2.eakkachai-dev.workers.dev/other']){
    const result=runProbeFixture('success',url);
    assert.equal(result.status,1);
    assert.equal(result.report.calls.length,0);
    assert.deepEqual(result.report.artifacts,{});
  }
});
