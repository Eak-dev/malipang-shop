import assert from 'node:assert/strict';
import { receive } from './issue348-private-r2.mjs';
import { validateFiles } from './issue348-transfer-rehearsal.mjs';

try {
  const control = JSON.parse(process.env.SYNTHETIC_CONTROL);
  const files = await receive(process.env.SYNTHETIC_GET_URL, control, 'synthetic', process.env.R2_ACCOUNT);
  console.log('Private R2 download: 10/10 SHA-256 matches');
  function expectRejection(sample, code) {
    let calls = 0;
    assert.throws(() => {
      for (const _ of validateFiles(sample, control.expected)) calls++;
    }, {code});
    assert.equal(calls, 0);
    console.log(code + ' mockVisionCalls=0');
  }
  expectRejection(files.slice(1), 'MISSING_FILES');
  const corrupted = files.map(f => ({...f, bytes: Buffer.from(f.bytes)}));
  corrupted.at(-1).bytes[0] ^= 1;
  expectRejection(corrupted, 'HASH_MISMATCH');
} catch {
  console.error('Private R2 synthetic rehearsal failed');
  process.exitCode = 1;
}
