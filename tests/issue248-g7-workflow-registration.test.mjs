import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const raw=readFileSync(new URL('../.github/workflows/issue248-g7-audit-writer.yml',import.meta.url),'utf8');
const steps=raw.split(/(?=^      - (?:name|uses):)/m).slice(1);
test('registration push is restricted to default branch and this workflow path',()=>{
 assert.match(raw,/^on:\n  push:\n    branches: \[main\]\n    paths: \['\.github\/workflows\/issue248-g7-audit-writer\.yml'\]\n  workflow_dispatch:/m);
 assert.match(raw,/^    if: github\.ref == 'refs\/heads\/main'$/m);
});
test('push can only run the constant provider-free registration step',()=>{
 assert.equal(steps.length,5);assert.match(steps[0],/^      - name: Register workflow without provider access\n        if: github\.event_name == 'push'\n        run: echo 'G7_AUDIT_WORKFLOW_REGISTERED_NO_PROVIDER_ACTION'\n$/);
 for(const step of steps.slice(1))assert.match(step,/^        if: github\.event_name == 'workflow_dispatch'$/m);
 assert.doesNotMatch(steps[0],/secrets\.|cloudflare|wrangler|curl|node|checkout/i);
});
test('manual workflow retains one scoped production job and audit provenance steps',()=>{
 assert.match(raw,/^jobs:\n  audit-write:/m);assert.equal((raw.match(/^  audit-write:/gm)||[]).length,1);assert.match(raw,/^    environment: production$/m);
 assert.match(steps[3],/^      - name: Pin reviewed source$/m);assert.match(steps[3],/git diff --quiet/);
 assert.match(steps[4],/^      - name: Write one scoped audit object and verify$/m);assert.match(steps[4],/node scripts\/issue248-g7-audit\.mjs/);
});
test('manual inputs, event permissions and concurrency remain constrained',()=>{
 for(const name of ['expected_sha','audit_nonce','phase','record_base64'])assert.match(raw,new RegExp('^      '+name+':','m'));
 assert.match(raw,/^permissions: \{contents: read\}$/m);assert.match(raw,/^concurrency: \{group: malipang-release-control, cancel-in-progress: false\}$/m);
});
