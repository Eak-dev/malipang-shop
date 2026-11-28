// Staging-only diagnostic for the private photo pack (#348). Repeats issue348-stage-private-photos.mjs
// step by step and prints ONE allowlisted line naming the stage that failed. Never prints the URL, object
// key, headers, body, plaintext, image bytes, reader id/key, account or control hash. One fetch, no retry.
// No Worker, model or LINE call: the workflow gives this job no evaluator settings.
import { createHash, createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Byte-identical copy of scripts/issue348-transfer-rehearsal.mjs at 440e22061cf27ed76b0188bfc3f15bde63e20f88
// (git blob fc44009eef4e368082051644d648ac005a5e992c); the test pins that blob id.
import { decryptPackage, validateFiles } from './issue348-transfer-rehearsal.mjs';

const bucket = 'malipang-issue348-private-test';
const maxPackage = 80 * 1024 * 1024;
export const ERROR_BODY_CAP = 4096;
const hexDigest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const isObject = value => typeof value === 'object' && value !== null;

const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'TimeoutError', 'AbortError']);
const S3_CODES = new Set(['AccessDenied', 'Unauthorized', 'ExpiredRequest', 'SignatureDoesNotMatch',
  'InvalidAccessKeyId', 'NoSuchKey', 'NoSuchBucket', 'RequestTimeTooSkewed', 'NotEntitled',
  'InvalidArgument', 'InternalError', 'ServiceUnavailable', 'SlowDown']);
const FS_CODES = new Set(['EEXIST', 'EACCES', 'ENOSPC', 'ENOENT', 'EROFS', 'EPERM']);
const REHEARSAL_CODES = new Set(['PACKAGE_TRUNCATED', 'DECRYPT_FAILED', 'DUPLICATE_FILE', 'MISSING_FILES',
  'UNEXPECTED_FILES', 'COUNT_MISMATCH', 'SIZE_MISMATCH', 'HASH_MISMATCH']);
const pick = (set, value) => (set.has(value) ? value : 'OTHER');

class Stage extends Error {
  constructor(stage, code, extra = {}) { super(stage); Object.assign(this, {stage, code, extra}); }
}
const fail = (stage, code, extra) => { throw new Stage(stage, code, extra); };

// Same signing as issue348-stage-private-photos.mjs lines 13-29.
function signObject(account, name, reader, now) {
  const host = account + '.r2.cloudflarestorage.com';
  const path = '/' + bucket + '/' + name;
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const scope = day + '/auto/s3/aws4_request';
  const query = new URLSearchParams([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', reader.id + '/' + scope],
    ['X-Amz-Date', stamp], ['X-Amz-Expires', '300'], ['X-Amz-SignedHeaders', 'host'],
  ]).toString();
  const req = ['GET', path, query, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const signing = hmac(hmac(hmac(hmac('AWS4' + reader.key, day), 'auto'), 's3'), 'aws4_request');
  const sig = hmac(signing, ['AWS4-HMAC-SHA256', stamp, scope, hexDigest(req)].join('\n')).toString('hex');
  return 'https://' + host + path + '?' + query + '&X-Amz-Signature=' + sig;
}

const netCode = err => pick(NET_CODES, err?.cause?.code ?? err?.code ?? err?.name);

// Keeps at most `cap` raw bytes of an error body (Buffer.concat copies them out of the last chunk), then
// cancels the stream. This bounds what the application retains and classifies; a single chunk or the
// network layer may already hold more than `cap` bytes, which this cannot prevent.
export async function readCappedPrefix(body, cap = ERROR_BODY_CAP) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts = [];
  let kept = 0;
  try {
    while (kept < cap) {
      const {done, value} = await reader.read();
      if (done) break;
      const take = value.subarray(0, cap - kept);
      parts.push(take);
      kept += take.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, kept);
}

// Calendar check equal to the original rule, but an impossible date is a FILE/OVERLAY reject, not a throw.
function validOverlay(overlay) {
  const {date, time} = isObject(overlay) ? overlay : {};
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time);
}

export async function diagnose({env, root, fetchImpl = fetch, now = new Date()}) {
  // CONFIG: secrets parse and shape (stage script lines 14-15, 32-33; transport lines 8-11).
  let control, reader;
  try { control = JSON.parse(env.PHOTO_CONTROL); } catch { fail('CONFIG', 'PHOTO_CONTROL_JSON'); }
  try { reader = JSON.parse(env.SCOPED_READER); } catch { fail('CONFIG', 'SCOPED_READER_JSON'); }
  const account = env.R2_ACCOUNT;
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) fail('CONFIG', 'ACCOUNT_SHAPE');
  if (!/^[a-f0-9]{32}$/.test(reader?.id ?? '') || !/^[a-f0-9]{64}$/.test(reader?.key ?? '')) fail('CONFIG', 'READER_SHAPE');
  if (!/^[a-f0-9]{64}$/.test(control?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(control?.key ?? '')) fail('CONFIG', 'CONTROL_SHAPE');
  if (!/^photos-348-[a-f0-9]{16}\.bin$/.test(control?.name ?? '')) fail('CONFIG', 'CONTROL_NAME_SHAPE');
  if (typeof root !== 'string' || !root) fail('CONFIG', 'SCRATCH_ROOT');

  // ALLOWLIST: the transport's URL checks (transport lines 12-19).
  const url = new URL(signObject(account, control.name, reader, now));
  if (control.name !== 'photos-348-' + control.sha256.slice(0, 16) + '.bin') fail('ALLOWLIST', 'NAME_DIGEST_MISMATCH');
  if (url.origin !== 'https://' + account + '.r2.cloudflarestorage.com' || url.pathname !== '/' + bucket + '/' + control.name) {
    fail('ALLOWLIST', 'URL_REJECTED');
  }

  // NETWORK / HTTP / STREAM: exactly one request, no retry (transport lines 20-28).
  let response;
  try {
    response = await fetchImpl(url, {redirect: 'error', signal: AbortSignal.timeout(60000)});
  } catch (err) { fail('NETWORK', netCode(err)); }
  if (!response.ok) {
    let s3 = 'NONE';
    try {
      const prefix = new TextDecoder('utf-8').decode(await readCappedPrefix(response.body));
      const m = /<Code>([A-Za-z]{1,40})<\/Code>/.exec(prefix);
      if (m) s3 = pick(S3_CODES, m[1]);
    } catch { s3 = 'UNREADABLE'; }
    fail('HTTP', 'NOT_OK', {http: Number.isInteger(response.status) ? response.status : 0, s3});
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxPackage) fail('STREAM', 'TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (err) { if (err instanceof Stage) throw err; fail('STREAM', netCode(err)); }
  const bytes = Buffer.concat(chunks, length);

  // DIGEST / EXPECTED / DECRYPT / VALIDATE (transport lines 29-33).
  if (hexDigest(bytes) !== control.sha256) fail('DIGEST', 'MISMATCH', {bytes: bytes.length});
  const exp = control.expected;
  if (!isObject(exp) || exp.count !== 10 || !Array.isArray(exp.files) || exp.files.length !== 10
      || !exp.files.every(isObject) || new Set(exp.files.map(f => f.id)).size !== 10) fail('EXPECTED', 'SHAPE');
  let files;
  try { files = decryptPackage(bytes, Buffer.from(control.key, 'hex')); } catch (err) { fail('DECRYPT', pick(REHEARSAL_CODES, err?.code)); }
  try { files = validateFiles(files, exp); } catch (err) { fail('VALIDATE', pick(REHEARSAL_CODES, err?.code)); }

  // FILE / FS: same per-file rules and writes as stage script lines 35-61.
  const byName = new Map(files.map(f => [f.id, f.bytes]));
  const seen = new Set();
  const slipIds = ['kbank-kplus', 'paotang-gwallet', 'scb-easy'];
  for (const [group, count, prefix] of [['clock', 7, 'photo'], ['slip', 3, 'slip']]) {
    const cases = isObject(control[group]) ? control[group].cases : undefined;
    if (!Array.isArray(cases) || cases.length !== count) fail('FILE', 'CASE_COUNT', {group});
    // The original find() throws on a null entry; with exactly `count` cases such a pack is always rejected.
    if (cases.some(x => x === null || x === undefined)) fail('FILE', 'CASE_SHAPE', {group});
    const dir = join(root, group);
    try { await mkdir(dir, {mode: 0o700}); } catch (err) { fail('FS', pick(FS_CODES, err?.code), {group}); }
    for (let i = 0; i < count; i++) {
      const filename = prefix + '-' + String(i + 1).padStart(2, '0') + '.jpg';
      const at = {group, index: i + 1};
      const row = cases.find(x => x.file === filename);
      const data = byName.get(filename);
      if (!row) fail('FILE', 'MISSING_ROW', at);
      if (!data) fail('FILE', 'MISSING_DATA', at);
      if (data.length > 5 * 1024 * 1024) fail('FILE', 'TOO_LARGE', at);
      if (data[0] !== 255 || data[1] !== 216) fail('FILE', 'NOT_JPEG', at);
      if (row.sha256 !== hexDigest(data)) fail('FILE', 'SHA_MISMATCH', at);
      if (seen.has(row.sha256)) fail('FILE', 'DUPLICATE', at);
      if (row.id !== (group === 'clock' ? filename.slice(0, -4) : slipIds[i])) fail('FILE', 'ID_MISMATCH', at);
      if (group === 'clock' && i < 5 && !validOverlay(row.verifiedOverlay)) fail('FILE', 'OVERLAY', at);
      seen.add(row.sha256);
      try { await writeFile(join(dir, filename), data, {mode: 0o600, flag: 'wx'}); } catch (err) { fail('FS', pick(FS_CODES, err?.code), at); }
    }
    try { await writeFile(join(dir, 'manifest.json'), JSON.stringify(control[group]), {mode: 0o600, flag: 'wx'}); }
    catch (err) { fail('FS', pick(FS_CODES, err?.code), {group}); }
  }
  return {stage: 'PASS', code: 'ALL_STAGES', extra: {}};
}

// Only these keys/values can reach the log. bytes= appears only for DIGEST MISMATCH (0..maxPackage).
export function summaryLine(result) {
  const parts = ['ISSUE348_STAGING_DIAGNOSTIC', 'stage=' + result.stage, 'code=' + result.code];
  const x = result.extra ?? {};
  if ('http' in x) parts.push('http=' + x.http, 's3=' + x.s3);
  if ('bytes' in x) parts.push('bytes=' + x.bytes);
  if ('group' in x) parts.push('group=' + x.group);
  if ('index' in x) parts.push('index=' + x.index);
  return parts.join(' ');
}

export async function main(env = process.env) {
  let result;
  try { result = await diagnose({env, root: env.ISSUE348_SCRATCH}); }
  catch (err) { result = err instanceof Stage ? err : {stage: 'RUNTIME', code: 'UNCLASSIFIED', extra: {}}; }
  console.log(summaryLine(result));
  return result.stage === 'PASS' ? 0 : 1;
}

// realpath: launched through a symlinked path, argv[1] differs from import.meta.url and main would silently not run.
const launched = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === launched) process.exitCode = await main();
