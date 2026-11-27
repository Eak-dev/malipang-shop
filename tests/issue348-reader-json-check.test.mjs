import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const workflow = new URL('../.github/workflows/issue348-reader-json-check.yml', import.meta.url);

test('reader classification only emits an allowlisted result for synthetic inputs', async () => {
  const source = await readFile(workflow, 'utf8');
  const match = source.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/);
  assert.ok(match, 'workflow embeds the checked script');
  const script = match[1].replace(/^          /gm, '');
  const cases = [
    [undefined, 'EMPTY'], ['', 'EMPTY'], ['{', 'INVALID_JSON'], ['  ', 'INVALID_JSON'],
    ['\ufeff{}', 'INVALID_JSON'], ['\n{}\n', 'VALID_JSON'],
    [JSON.stringify({id: 'a'.repeat(32), key: 'b'.repeat(64)}), 'VALID_JSON'],
    ['"synthetic-marker-not-for-output"', 'VALID_JSON'], ['null', 'VALID_JSON'],
  ];
  for (const [value, expected] of cases) {
    const env = {PATH: process.env.PATH};
    if (value !== undefined) env.SCOPED_READER = value;
    const result = spawnSync(process.execPath, [], {input: script, encoding: 'utf8', env});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `ISSUE348_READER_JSON=${expected}\n`);
    assert.equal(result.stderr, '');
  }
});

test('workflow keeps the owner gate and receives only the intended secret', async () => {
  const source = await readFile(workflow, 'utf8');
  assert.match(source, /^permissions: \{\}$/m);
  assert.match(source, /^    environment: production$/m);
  assert.match(source, /github\.sha == inputs\.expected_main_sha/);
  assert.match(source, /github\.run_attempt == 1/);
  const refs = [...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(refs, ['ISSUE348_R2_READER']);
  assert.doesNotMatch(source, /actions\/checkout|\bfetch\s*\(|\bcurl\b/);
});
