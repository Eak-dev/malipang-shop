import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  FIXTURE_COUNT, buildScenario, encryptPackage, expectedManifest, generateFixtures, runRehearsal, serveLoopback,
} from '../scripts/issue348-transfer-rehearsal.mjs';

const URL_OK = 'http://127.0.0.1:9/package.bin';
const mockFetch = (body, status = 200) => async (_url, init) => {
  assert.equal(init.redirect, 'error');
  return new Response(body, { status });
};
const visionSpy = () => {
  const calls = [];
  return { calls, vision: async (f) => { calls.push(f.id); } };
};

test('fixtures: exactly 10 distinct synthetic files with distinct hashes', () => {
  const m = expectedManifest(generateFixtures());
  assert.equal(m.count, FIXTURE_COUNT);
  assert.equal(new Set(m.files.map((f) => f.id)).size, 10);
  assert.equal(new Set(m.files.map((f) => f.sha256)).size, 10);
});

test('positive: 10/10 exact over real loopback HTTP, vision after validation', async () => {
  const { key, expected, pkg } = buildScenario();
  const server = await serveLoopback(pkg);
  const spy = visionSpy();
  try {
    const r = await runRehearsal({ url: server.url, key, expected, vision: spy.vision });
    assert.deepEqual(r, { ok: true, passed: 10, total: 10, visionCalls: 10 });
    assert.deepEqual(spy.calls, expected.files.map((f) => f.id));
  } finally {
    await server.close();
  }
});

for (const [fault, code] of [['missing', 'MISSING_FILES'], ['hash', 'HASH_MISMATCH']]) {
  test(`fails closed on ${fault} with zero vision calls`, async () => {
    const { key, expected, pkg } = buildScenario(fault);
    const spy = visionSpy();
    await assert.rejects(runRehearsal({ url: URL_OK, key, expected, vision: spy.vision, fetchImpl: mockFetch(pkg) }), { code });
    assert.equal(spy.calls.length, 0);
  });
}

test('fails closed on extra, duplicate, tampered, wrong key, HTTP error and non-loopback', async () => {
  const fixtures = generateFixtures();
  const expected = expectedManifest(fixtures);
  const key = randomBytes(32);
  const tampered = encryptPackage(fixtures, key);
  tampered[tampered.length - 1] ^= 1;
  const cases = [
    [encryptPackage([...fixtures, { id: 'synthetic-99', bytes: Buffer.from('x') }], key), 'UNEXPECTED_FILES'],
    [encryptPackage([...fixtures, fixtures[0]], key), 'DUPLICATE_FILE'],
    [tampered, 'DECRYPT_FAILED'],
    [encryptPackage(fixtures, randomBytes(32)), 'DECRYPT_FAILED'],
    [Buffer.alloc(4), 'PACKAGE_TRUNCATED'],
  ];
  const spy = visionSpy();
  for (const [pkg, code] of cases) {
    await assert.rejects(runRehearsal({ url: URL_OK, key, expected, vision: spy.vision, fetchImpl: mockFetch(pkg) }), { code });
  }
  await assert.rejects(runRehearsal({ url: URL_OK, key, expected, vision: spy.vision, fetchImpl: mockFetch('', 404) }), { code: 'HTTP_STATUS' });
  let fetched = false;
  const neverFetch = async () => { fetched = true; };
  for (const url of ['https://example.com/p', 'http://10.0.0.1/p', 'file:///etc/hosts']) {
    await assert.rejects(runRehearsal({ url, key, expected, vision: spy.vision, fetchImpl: neverFetch }), { code: 'DESTINATION_REJECTED' });
  }
  assert.equal(fetched, false);
  assert.equal(spy.calls.length, 0);
});
