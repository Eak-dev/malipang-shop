import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectedManifest, FIXTURE_COUNT, generateFixtures, validateFiles } from './issue348-transfer-rehearsal.mjs';

const [operation, directory] = process.argv.slice(2);

async function prepare() {
  const originals = generateFixtures();
  await mkdir(directory);
  for (const { id, bytes } of originals) {
    await writeFile(join(directory, id), bytes, { flag: 'wx' });
  }
  // Only the payload directory goes into the artifact. The sender passes
  // this manifest independently through a GitHub Actions job output.
  console.log(JSON.stringify(expectedManifest(originals)));
}

async function receive() {
  const expected = JSON.parse(process.env.EXPECTED_MANIFEST);
  if (expected.count !== FIXTURE_COUNT) throw new Error('Unexpected manifest count');
  const files = [];
  for (const id of await readdir(directory)) {
    files.push({ id, bytes: await readFile(join(directory, id)) });
  }
  const mockVisionCalls = [];
  try {
    for (const file of validateFiles(files, expected)) {
      mockVisionCalls.push(file.id);
    }
    console.log(`PASS files=${files.length} hashes=${files.length} mockVisionCalls=${mockVisionCalls.length}`);
  } catch (error) {
    console.error(`REJECT ${error.code} files=${files.length} mockVisionCalls=${mockVisionCalls.length}`);
    process.exitCode = 1;
  }
}

if (operation === 'prepare') await prepare();
else if (operation === 'receive') await receive();
else throw new Error('Expected prepare or receive');
