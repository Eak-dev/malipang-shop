// Synthetic data only: no real photos, no real credentials, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptPackage, expectedManifest } from '../scripts/issue348-transfer-rehearsal.mjs';
import { diagnose, summaryLine, readCappedPrefix, ERROR_BODY_CAP } from '../scripts/issue348-stage-diagnostic.mjs';

const script = fileURLToPath(new URL('../scripts/issue348-stage-diagnostic.mjs', import.meta.url));
const vendored = fileURLToPath(new URL('../scripts/issue348-transfer-rehearsal.mjs', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`synthetic-${n}-${randomBytes(4).toString('hex')}`)]);
const LINE = /^ISSUE348_STAGING_DIAGNOSTIC stage=[A-Z]+ code=[A-Z_]+( http=\d+ s3=[A-Za-z]+)?( bytes=\d+)?( group=(clock|slip))?( index=\d+)?$/;

function fixture(mutate = () => {}) {
  const names = [...Array.from({length: 7}, (_, i) => `photo-0${i + 1}.jpg`), 'slip-01.jpg', 'slip-02.jpg', 'slip-03.jpg'];
  const files = names.map(id => ({id, bytes: jpeg(id)}));
  const key = randomBytes(32);
  const pkg = encryptPackage(files, key);
  const digest = sha(pkg);
  const slipIds = ['kbank-kplus', 'paotang-gwallet', 'scb-easy'];
  const control = {name: 'photos-348-' + digest.slice(0, 16) + '.bin', sha256: digest, key: key.toString('hex'),
    expected: expectedManifest(files),
    clock: {cases: files.slice(0, 7).map((f, i) => ({file: f.id, id: f.id.slice(0, -4), sha256: sha(f.bytes),
      ...(i < 5 ? {verifiedOverlay: {date: '2026-11-24', time: '08:0' + i + ':00'}} : {})}))},
    slip: {cases: files.slice(7).map((f, i) => ({file: f.id, id: slipIds[i], sha256: sha(f.bytes)}))}};
  mutate(control);
  const reader = {id: 'a'.repeat(32), key: 'b'.repeat(64)};
  const env = {PHOTO_CONTROL: JSON.stringify(control), SCOPED_READER: JSON.stringify(reader), R2_ACCOUNT: 'c'.repeat(32)};
  return {env, pkg, control, reader};
}

// A body stream that counts what was pulled and whether it was cancelled.
function meteredStream(total, chunkSize, fill, {errorAt = -1, errorMessage = 'boom'} = {}) {
  const meter = {pulled: 0, cancelled: 0};
  const stream = new ReadableStream({
    pull(ctrl) {
      if (errorAt >= 0 && meter.pulled >= errorAt) { ctrl.error(new Error(errorMessage)); return; }
      if (meter.pulled >= total) { ctrl.close(); return; }
      const n = Math.min(chunkSize, total - meter.pulled);
      ctrl.enqueue(fill(meter.pulled, n));
      meter.pulled += n;
    },
    cancel() { meter.cancelled++; },
  });
  return {stream, meter};
}
const xmlAt = (offset, code) => (start, n) => {
  const buf = Buffer.alloc(n, 0x20);
  const tag = Buffer.from(`<Code>${code}</Code>`);
  if (offset >= start && offset < start + n) tag.copy(buf, offset - start);
  return new Uint8Array(buf);
};

const s3err = (status, code) => async () => new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>x</Message></Error>`, {status});
const okBody = body => async () => new Response(body, {status: 200});

async function run(env, fetchImpl, prep) {
  const root = await mkdtemp(join(tmpdir(), 'issue348diag-'));
  try {
    if (prep) await prep(root);
    let calls = 0;
    const counted = async (...a) => { calls++; return fetchImpl(...a); };
    let result;
    try { result = await diagnose({env, root, fetchImpl: counted}); } catch (e) { result = e; }
    return {line: summaryLine(result), calls};
  } finally { await rm(root, {recursive: true, force: true}); }
}

const withControl = edit => f => { const c = JSON.parse(f.env.PHOTO_CONTROL); edit(c); return [{...f.env, PHOTO_CONTROL: JSON.stringify(c)}, okBody(f.pkg)]; };
const cases = [
  ['pass', f => [f.env, okBody(f.pkg)], /stage=PASS code=ALL_STAGES$/, 1],
  ['403 signature', f => [f.env, s3err(403, 'SignatureDoesNotMatch')], /stage=HTTP code=NOT_OK http=403 s3=SignatureDoesNotMatch$/, 1],
  ['403 unknown s3 code', f => [f.env, s3err(403, 'SomethingSecretLooking')], /stage=HTTP code=NOT_OK http=403 s3=OTHER$/, 1],
  ['404 no key', f => [f.env, s3err(404, 'NoSuchKey')], /http=404 s3=NoSuchKey$/, 1],
  ['dns failure', f => [f.env, async () => { throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}}); }], /stage=NETWORK code=ENOTFOUND$/, 1],
  ['odd network error', f => [f.env, async () => { throw new Error('host abc.r2 secret'); }], /stage=NETWORK code=OTHER$/, 1],
  ['digest mismatch', f => [f.env, okBody(Buffer.concat([f.pkg, Buffer.from([0])]))], /stage=DIGEST code=MISMATCH bytes=\d+$/, 1],
  ['bad control json', f => [{...f.env, PHOTO_CONTROL: '{'}, okBody(f.pkg)], /stage=CONFIG code=PHOTO_CONTROL_JSON$/, 0],
  ['bad reader shape', f => [{...f.env, SCOPED_READER: '{"id":"x","key":"y"}'}, okBody(f.pkg)], /stage=CONFIG code=READER_SHAPE$/, 0],
  ['wrong key', withControl(c => { c.key = 'd'.repeat(64); }), /stage=DECRYPT code=DECRYPT_FAILED$/, 1],
  ['name not from digest', withControl(c => { c.name = 'photos-348-' + '0'.repeat(16) + '.bin'; }), /stage=ALLOWLIST code=NAME_DIGEST_MISMATCH$/, 0],
  // R3: known malformed shapes are classified at their stage, never RUNTIME.
  ['expected.files has null', withControl(c => { c.expected.files[0] = null; }), /stage=EXPECTED code=SHAPE$/, 1],
  ['expected missing', withControl(c => { delete c.expected; }), /stage=EXPECTED code=SHAPE$/, 1],
  ['impossible overlay date', withControl(c => { c.clock.cases[1].verifiedOverlay.date = '2026-99-99'; }), /stage=FILE code=OVERLAY group=clock index=2$/, 1],
  ['rolled-over overlay date', withControl(c => { c.clock.cases[0].verifiedOverlay.date = '2026-02-30'; }), /stage=FILE code=OVERLAY group=clock index=1$/, 1],
  ['bad overlay time', withControl(c => { c.clock.cases[2].verifiedOverlay.time = '25:00:00'; }), /stage=FILE code=OVERLAY group=clock index=3$/, 1],
  ['null case entry', withControl(c => { c.clock.cases[3] = null; }), /stage=FILE code=CASE_SHAPE group=clock$/, 1],
  ['slip group missing', withControl(c => { delete c.slip; }), /stage=FILE code=CASE_COUNT group=slip$/, 1],
];

for (const [name, build, expect, calls] of cases) {
  test(`diagnostic stage: ${name}`, async () => {
    const f = fixture();
    const [env, impl] = build(f);
    const out = await run(env, impl);
    assert.match(out.line, LINE);
    assert.match(out.line, expect);
    assert.equal(out.calls, calls, 'at most one fetch, no retry');
    for (const secretish of [f.control.key, f.control.name, f.control.sha256, f.reader.key, f.reader.id, 'c'.repeat(32), 'r2.cloudflarestorage.com']) {
      assert.ok(!out.line.includes(secretish), 'no secret, key, account or URL in output');
    }
  });
}

test('diagnostic stage: filesystem EEXIST', async () => {
  const f = fixture();
  const out = await run(f.env, okBody(f.pkg), async root => { await mkdir(join(root, 'clock')); });
  assert.match(out.line, /stage=FS code=EEXIST group=clock$/);
});

// R1: the error body is limited in raw bytes and the stream is cancelled.
test('error body: 1 MiB multichunk 403 is cut at the cap and cancelled', async () => {
  const chunk = 64 * 1024;
  const {stream, meter} = meteredStream(1024 * 1024, chunk, xmlAt(100, 'AccessDenied'));
  const f = fixture();
  const out = await run(f.env, async () => new Response(stream, {status: 403}));
  assert.match(out.line, /stage=HTTP code=NOT_OK http=403 s3=AccessDenied$/);
  assert.equal(out.calls, 1);
  assert.equal(meter.cancelled, 1, 'stream cancelled once');
  assert.ok(meter.pulled <= ERROR_BODY_CAP + 2 * chunk, `pulled ${meter.pulled} stays near the cap`);
  assert.ok(meter.pulled < 1024 * 1024, 'did not read the whole body');
});

test('error body: a code beyond the cap is not used', async () => {
  const {stream, meter} = meteredStream(64 * 1024, 1024, xmlAt(6000, 'AccessDenied'));
  const f = fixture();
  const out = await run(f.env, async () => new Response(stream, {status: 403}));
  assert.match(out.line, /http=403 s3=NONE$/);
  assert.equal(meter.cancelled, 1);
});

test('error body: code that straddles the cap is not used', async () => {
  const {stream} = meteredStream(8192, 8192, xmlAt(ERROR_BODY_CAP - 10, 'AccessDenied'));
  const f = fixture();
  assert.match((await run(f.env, async () => new Response(stream, {status: 403}))).line, /s3=NONE$/);
});

test('error body: multibyte prefix, cap splitting a character', async () => {
  const thai = Buffer.from('ก'.repeat(1365)); // 4095 bytes; the cap cuts the next 3-byte character
  const body = Buffer.concat([Buffer.from('<Code>NoSuchKey</Code>'), thai, Buffer.from('ข'.repeat(50))]);
  const f = fixture();
  assert.match((await run(f.env, async () => new Response(body, {status: 404}))).line, /http=404 s3=NoSuchKey$/);
  const prefix = await readCappedPrefix(new Response(body).body);
  assert.equal(prefix.length, ERROR_BODY_CAP);
});

test('error body: reader error is UNREADABLE and leaks nothing', async () => {
  const {stream} = meteredStream(1 << 20, 512, () => new Uint8Array(512), {errorAt: 1024, errorMessage: 'CANARY-READ-ERROR'});
  const f = fixture();
  const out = await run(f.env, async () => new Response(stream, {status: 403}));
  assert.match(out.line, /http=403 s3=UNREADABLE$/);
  assert.ok(!out.line.includes('CANARY'));
});

// Canary through a real child process: nothing from body or error text reaches stdout/stderr.
test('canary never reaches stdout or stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'issue348canary-'));
  try {
    const f = fixture();
    const stub = join(dir, 'stub.mjs');
    await writeFile(stub, `globalThis.fetch = async () => new Response('CANARY-BODY <Code>CANARY-CODE</Code>' + 'z'.repeat(9000) + 'CANARY-TAIL', {status: 403});\n`);
    await mkdir(join(dir, 'scratch'));
    let stdout = '', stderr = '', status = 0;
    try {
      stdout = execFileSync(process.execPath, ['--import', stub, script], {env: {...f.env, ISSUE348_SCRATCH: join(dir, 'scratch'), PATH: process.env.PATH}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    } catch (e) { stdout = e.stdout; stderr = e.stderr; status = e.status; }
    assert.equal(status, 1);
    assert.match(stdout.trim(), /^ISSUE348_STAGING_DIAGNOSTIC stage=HTTP code=NOT_OK http=403 s3=NONE$/);
    assert.ok(!(stdout + stderr).includes('CANARY'));
    assert.ok(!(stdout + stderr).includes(f.control.key) && !(stdout + stderr).includes(f.reader.key));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// Launched through a symlink (macOS /var -> /private/var) the CLI must still run, never exit 0 silently.
test('CLI runs when launched through a symlinked path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'issue348link-'));
  try {
    const link = join(dir, 'linked-scripts');
    await symlink(dirname(script), link);
    let stdout = '', status = 0;
    try {
      stdout = execFileSync(process.execPath, [join(link, 'issue348-stage-diagnostic.mjs')], {env: {PATH: process.env.PATH, PHOTO_CONTROL: '{'}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    } catch (e) { stdout = e.stdout; status = e.status; }
    assert.equal(status, 1);
    assert.equal(stdout.trim(), 'ISSUE348_STAGING_DIAGNOSTIC stage=CONFIG code=PHOTO_CONTROL_JSON');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// Provenance: the vendored helper must stay byte-identical to the pinned transport commit.
test('vendored transport matches 440e220 blob', async () => {
  const data = await readFile(vendored);
  const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  assert.equal(blob, 'fc44009eef4e368082051644d648ac005a5e992c');
});
