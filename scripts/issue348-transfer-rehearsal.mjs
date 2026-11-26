#!/usr/bin/env node
// Issue #348 local rehearsal: synthetic private-file transfer over loopback HTTP.
// Synthetic data only. No real photos, secrets, providers, R2 or Production.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_COUNT = 10;
const AAD = Buffer.from('malipang-issue348-rehearsal-v1');
const IV_LEN = 12;
const TAG_LEN = 16;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export class RehearsalError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function generateFixtures(count = FIXTURE_COUNT) {
  return Array.from({ length: count }, (_, i) => {
    const id = `synthetic-${String(i + 1).padStart(2, '0')}`;
    return { id, bytes: Buffer.from(`ISSUE348-SYNTHETIC-FIXTURE ${id} ${'x'.repeat(i + 1)}\n`) };
  });
}

export function expectedManifest(fixtures) {
  return {
    count: fixtures.length,
    files: fixtures.map(({ id, bytes }) => ({ id, size: bytes.length, sha256: sha256(bytes) })),
  };
}

// Package = iv | tag | AES-256-GCM(JSON {files:[{id,data(base64)}]}).
export function encryptPackage(fixtures, key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plain = Buffer.from(JSON.stringify({ files: fixtures.map(({ id, bytes }) => ({ id, data: bytes.toString('base64') })) }));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptPackage(pkg, key) {
  if (pkg.length <= IV_LEN + TAG_LEN) throw new RehearsalError('PACKAGE_TRUNCATED', `${pkg.length} bytes`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, pkg.subarray(0, IV_LEN));
    decipher.setAAD(AAD);
    decipher.setAuthTag(pkg.subarray(IV_LEN, IV_LEN + TAG_LEN));
    const plain = Buffer.concat([decipher.update(pkg.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
    const files = JSON.parse(plain.toString('utf8')).files;
    if (!Array.isArray(files)) throw new Error('files not an array');
    return files.map(({ id, data }) => ({ id: String(id), bytes: Buffer.from(String(data), 'base64') }));
  } catch {
    throw new RehearsalError('DECRYPT_FAILED', 'package failed authentication or decoding');
  }
}

// Every check runs before the caller may invoke any vision callback.
export function validateFiles(files, expected) {
  const byId = new Map();
  for (const f of files) {
    if (byId.has(f.id)) throw new RehearsalError('DUPLICATE_FILE', f.id);
    byId.set(f.id, f);
  }
  const expectedIds = new Set(expected.files.map((e) => e.id));
  const missing = [...expectedIds].filter((id) => !byId.has(id));
  if (missing.length) throw new RehearsalError('MISSING_FILES', missing.join(','));
  const extra = [...byId.keys()].filter((id) => !expectedIds.has(id));
  if (extra.length) throw new RehearsalError('UNEXPECTED_FILES', extra.join(','));
  if (files.length !== expected.count || expected.files.length !== expected.count) {
    throw new RehearsalError('COUNT_MISMATCH', `got ${files.length}, expected ${expected.count}`);
  }
  for (const e of expected.files) {
    const { bytes } = byId.get(e.id);
    if (bytes.length !== e.size) throw new RehearsalError('SIZE_MISMATCH', e.id);
    if (sha256(bytes) !== e.sha256) throw new RehearsalError('HASH_MISMATCH', e.id);
  }
  return expected.files.map((e) => byId.get(e.id));
}

function assertLoopback(url) {
  const u = new URL(url);
  // shortcut: plain http loopback only; a real runner needs https + an allowlisted host.
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new RehearsalError('DESTINATION_REJECTED', `${u.protocol}//${u.hostname}`);
  }
}

export async function runRehearsal({ url, key, expected, vision, fetchImpl = fetch }) {
  assertLoopback(url);
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'error' });
  } catch (err) {
    throw new RehearsalError('FETCH_FAILED', err?.message ?? String(err));
  }
  if (res.status !== 200) throw new RehearsalError('HTTP_STATUS', String(res.status));
  const files = validateFiles(decryptPackage(Buffer.from(await res.arrayBuffer()), key), expected);
  let visionCalls = 0;
  for (const f of files) {
    await vision({ id: f.id, bytes: f.bytes });
    visionCalls += 1;
  }
  return { ok: true, passed: files.length, total: expected.count, visionCalls };
}

export async function serveLoopback(body) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/package.bin') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/package.bin`, close: () => new Promise((r) => server.close(r)) };
}

// Builds the package served over loopback; fault simulates a broken transfer.
export function buildScenario(fault = 'none') {
  const key = randomBytes(32);
  const fixtures = generateFixtures();
  const expected = expectedManifest(fixtures);
  let sent = fixtures;
  if (fault === 'missing') sent = fixtures.slice(1);
  else if (fault === 'hash') sent = fixtures.map((f, i) => (i === 3 ? { id: f.id, bytes: Buffer.from(f.bytes).fill(0x41, 0, 1) } : f));
  else if (fault !== 'none') throw new Error(`unknown fault: ${fault}`);
  return { key, expected, pkg: encryptPackage(sent, key) };
}

async function main(argv) {
  const faultArg = argv.find((a) => a.startsWith('--fault='));
  if (!argv.includes('--smoke')) {
    console.error('usage: node scripts/issue348-transfer-rehearsal.mjs --smoke [--fault=missing|hash]');
    return 2;
  }
  const { key, expected, pkg } = buildScenario(faultArg ? faultArg.slice(8) : 'none');
  const server = await serveLoopback(pkg);
  let visionCalls = 0;
  const vision = async () => { visionCalls += 1; };
  try {
    const result = await runRehearsal({ url: server.url, key, expected, vision });
    console.log(`PASS ${result.passed}/${result.total} visionCalls=${result.visionCalls}`);
    return result.passed === FIXTURE_COUNT && result.visionCalls === FIXTURE_COUNT ? 0 : 1;
  } catch (err) {
    console.error(`FAIL_CLOSED ${err.code ?? 'ERROR'} visionCalls=${visionCalls}`);
    return 1;
  } finally {
    await server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
