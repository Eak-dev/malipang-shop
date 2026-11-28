import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const run = promisify(execFile);
const script = name => fileURLToPath(new URL('../scripts/' + name, import.meta.url));
const cli = script('issue348-attendance-uat.mjs');
const workflow = new URL('../.github/workflows/issue348-attendance-photo-uat.yml', import.meta.url);
const origin = 'https://malipang-backend-v5-2.eakkachai-dev.workers.dev';
const ids = ['photo-01','photo-02','photo-03','photo-04','photo-05','photo-06','photo-07'];
const slipIds = ['kbank-kplus','paotang-gwallet','scb-easy'];
const sha = 'a'.repeat(40);
const overlay = {date:'2000-01-02',time:'03:04:05'};
const image = id => Buffer.concat([Buffer.from([255,216,255]), Buffer.from('synthetic-' + id)]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clockRows = ids.map((id,i) => ({
  id, file:id + '.jpg', sha256:hash(image(id)), receivedAt:'2000-01-01T20:04:10.000Z',
  ownerExpected:i < 5 ? 'pass' : 'reject', ...(i < 5 ? {verifiedOverlay:overlay} : {}),
}));
const slipRows = slipIds.map((id,i) => ({id, file:'slip-0' + (i + 1) + '.jpg', sha256:hash(image(id))}));

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'issue348-uat-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return dir;
}
async function invoke(args, env) {
  try { return {status:0, ...await run(process.execPath, args, {env:{PATH:process.env.PATH, ...env}})}; }
  catch (e) { return {status:e.code, stdout:e.stdout, stderr:e.stderr}; }
}

test('clock-only staging verifies the pack and writes only clock files; default staging still writes ten', async t => {
  const root = await temp(t);
  const scripts = path.join(root, 'scripts'), transport = path.join(root, 'reviewed-transfer/scripts');
  await mkdir(scripts);
  await mkdir(transport, {recursive:true});
  const stage = path.join(scripts, 'issue348-stage-private-photos.mjs');
  await copyFile(script('issue348-stage-private-photos.mjs'), stage);
  // Only the pinned transfer boundary is replaced. File validation and writes run unchanged.
  const files = [...clockRows, ...slipRows].map(row => ({id:row.file, hex:image(row.id).toString('hex')}));
  await writeFile(path.join(transport, 'issue348-private-r2.mjs'),
    'export async function receive(){return ' + JSON.stringify(files) + '.map(f => ({id:f.id,bytes:Buffer.from(f.hex,"hex")}));}');
  for (const [i,args] of [[], ['--clock-only'], ['--typo']].entries()) {
    const dir = path.join(root, String(i)); await mkdir(dir);
    const result = await invoke([stage, ...args], {
      ISSUE348_SCRATCH:dir, R2_ACCOUNT:'1'.repeat(32), SCOPED_READER:JSON.stringify({id:'2'.repeat(32),key:'3'.repeat(64)}),
      PHOTO_CONTROL:JSON.stringify({name:'photos-348-0123456789abcdef.bin',clock:{cases:clockRows},slip:{cases:slipRows}}),
    });
    assert.equal(result.status, i === 2 ? 1 : 0);
    assert.deepEqual((await readdir(dir)).sort(), [ ['clock','slip'], ['clock'], [] ][i]);
    if (i !== 2) assert.equal((await readdir(path.join(dir,'clock'))).length, 8);
    if (i === 0) assert.equal((await readdir(path.join(dir,'slip'))).length, 4);
  }
});

test('approved attendance dispatch runs the real guarded fixture against a synthetic endpoint', async t => {
  const root = await temp(t);
  const manifest = path.join(root,'manifest.json'), token = path.join(root,'token'), event = path.join(root,'event.json');
  await writeFile(manifest, JSON.stringify({cases:clockRows}));
  await writeFile(token,'synthetic-only'.repeat(3));
  for (const row of clockRows) await writeFile(path.join(root,row.file),image(row.id));
  let seen, fault;
  const server = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const row = clockRows.find(row => hash(Buffer.concat(chunks)) === row.sha256);
    seen.push(row?.id ?? 'other');
    if (fault === 'disconnect' && row?.id === 'photo-03') { req.socket.destroy(); return; }
    const accepted = row?.ownerExpected === 'pass';
    const overlayPresent = accepted || (row?.id === 'photo-07' && fault !== 'wrong-07');
    res.setHeader('content-type','application/json');
    if (fault === 'endpoint-error' && row?.id === 'photo-02') {
      res.end(JSON.stringify({ok:false,error:'PRIVATE_MARKER'})); return;
    }
    res.end(JSON.stringify({ok:true,reading:{provider:'openai',kind:'CLOCK',clockPresent:true,clockConfidence:0.99,
      overlayPresent,overlayTextWhite:overlayPresent,photoDate:accepted ? overlay.date : null,photoTime:accepted ? (fault === 'wrong-overlay' && row?.id === 'photo-02' ? '04:05:06' : overlay.time) : null,
      latitude:accepted ? 13 : null,longitude:accepted ? 100 : null,locationText:'PRIVATE_MARKER'},
      validation:{ok:accepted,validationCode:accepted ? 'OK' : overlayPresent ? 'TIMESTAMP_FIELDS_MISSING' : 'TIMESTAMP_MISSING'}}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Redirect the underlying transport before the real fetch guard loads. No network path outside loopback exists.
  const preload = path.join(root,'loopback.mjs');
  await writeFile(preload, `const transport = globalThis.fetch;
    globalThis.fetch = (target, options) => {
      const url = new URL(target);
      if (url.origin !== ${JSON.stringify(origin)} || url.pathname !== '/admin/vision/evaluate'
          || url.searchParams.get('provider') !== 'openai' || url.searchParams.get('model') !== 'gpt-4.1-mini'
          || options.method !== 'POST' || options.redirect !== 'error') throw Error('unexpected request');
      return transport('http://127.0.0.1:${server.address().port}' + url.pathname + url.search, options);
    };`);
  async function evaluate(selected, overrides = {}) {
    seen = [];
    await writeFile(event, JSON.stringify({inputs:{approved_photo_ids:selected,expected_main_sha:sha}}));
    const result = await invoke([cli], {GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_REPOSITORY:'Eak-dev/malipang-shop',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_RUN_ATTEMPT:'1',
      MALIPANG_ADMIN_TOKEN_FILE:token,MALIPANG_CLOCK_PRIVATE_MANIFEST:manifest,MALIPANG_VISION_BASE_URL:origin,
      MALIPANG_ENDPOINT_CLOCK_MIN_CONFIDENCE:'0.70', NODE_OPTIONS:'--import=' + pathToFileURL(preload).href,...overrides});
    assert.equal(result.stderr, '');
    return {status:result.status, lines:result.stdout.trim().split('\n'), seen};
  }
  for (const selected of [ids, ['photo-07','photo-01','photo-06']]) {
    const expected = ids.filter(id => selected.includes(id));
    assert.deepEqual(await evaluate(selected.join(',')), {status:0,lines:expected.map(id => 'ok ' + id),seen:expected});
  }
  await writeFile(manifest, JSON.stringify({cases:[...clockRows].reverse()}));
  assert.deepEqual(await evaluate('photo-01,photo-06'), {status:0,lines:['ok photo-06','ok photo-01'],seen:['photo-06','photo-01']});
  await writeFile(manifest, JSON.stringify({cases:clockRows}));
  for (const input of [undefined,'','all','photo-00','slip-01','photo-01,photo-01','photo-01,','photo-01,PRIVATE_MARKER']) {
    assert.deepEqual(await evaluate(input), {status:1,lines:['ISSUE348_INPUT_REJECTED'],seen:[]});
  }
  for (const env of [{GITHUB_RUN_ATTEMPT:'2'}, {GITHUB_SHA:'b'.repeat(40)}, {GITHUB_REF:'refs/heads/test'},
    {GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_REPOSITORY:'other/repo'}, {MALIPANG_VISION_BASE_URL:'https://example.invalid'}]) {
    assert.deepEqual(await evaluate('photo-01',env), {status:1,lines:['ISSUE348_INPUT_REJECTED'],seen:[]});
  }
  for (fault of ['wrong-overlay','endpoint-error']) {
    assert.deepEqual(await evaluate('photo-01,photo-02,photo-03'), {status:1,lines:['ok photo-01','not ok photo-02'],seen:['photo-01','photo-02']});
  }
  fault = 'disconnect';
  assert.deepEqual(await evaluate('photo-01,photo-03,photo-06'), {status:1,lines:['ok photo-01','not ok photo-03','ISSUE348_TRANSPORT_OUTCOME_UNKNOWN'],seen:['photo-01','photo-03']});
  fault = 'wrong-07';
  assert.deepEqual(await evaluate('photo-07'), {status:1,lines:['not ok photo-07'],seen:['photo-07']});
});

test('manual workflow uses the reviewed SHA, first attempt, shared production gate and clock-only staging', async () => {
  const yaml = await readFile(workflow,'utf8');
  assert.match(yaml,/^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(yaml,/pull_request|^  (push|schedule):|upload-artifact|reviewed-tests/m);
  assert.match(yaml,/github\.repository == 'Eak-dev\/malipang-shop' && github\.ref == 'refs\/heads\/main' && github\.sha == inputs\.expected_main_sha && github\.run_attempt == 1/);
  assert.match(yaml,/environment: production/);
  assert.match(yaml,/group: issue348-production-private-photo-evaluation\n  cancel-in-progress: false/);
  assert.ok(yaml.indexOf('::add-mask::%s') > 0 && yaml.indexOf('::add-mask::%s') < yaml.indexOf('>> "$GITHUB_ENV"'));
  assert.match(yaml,/issue348-stage-private-photos\.mjs --clock-only/);
  assert.match(yaml,/node scripts\/issue348-attendance-uat\.mjs\s*\n/);
});
