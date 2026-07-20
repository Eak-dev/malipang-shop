import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('DLQ has an active consumer in Wrangler config',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const main=config.queues.consumers.find(consumer=>consumer.queue==='malipang-jobs');
  const dlq=config.queues.consumers.find(consumer=>consumer.queue==='malipang-jobs-dlq');
  assert.equal(main.dead_letter_queue,'malipang-jobs-dlq');
  assert.ok(dlq);
});
