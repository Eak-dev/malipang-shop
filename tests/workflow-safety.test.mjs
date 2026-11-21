import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/issue248-g7-receipt-writer.yml',import.meta.url),'utf8');
test('branch push cannot enter production release concurrency lane',()=>{
 const push=workflow.match(/\n  push:\n([\s\S]*?)\npermissions:/)?.[1];assert.ok(push);assert.match(push,/^    branches: \[main\]/);assert.match(push,/\n    paths: \['\.github\/workflows\/issue248-g7-receipt-writer\.yml'\]/);
 assert.ok(workflow.includes("group: ${{ github.event_name == 'push' && 'malipang-receipt-registry' || 'malipang-release-control' }}"));assert.match(workflow,/cancel-in-progress: false/);
});
test('push registration job cannot execute the receipt writer',()=>{
 const registry=workflow.match(/\n  registry:\n([\s\S]*?)\n  receipt-write:/)?.[1],write=workflow.split('\n  receipt-write:')[1];assert.ok(registry&&write);assert.match(registry,/if: github\.event_name == 'push'/);assert.doesNotMatch(registry,/CLOUDFLARE|node scripts\/|checkout|setup-node/);assert.match(write,/if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
});
