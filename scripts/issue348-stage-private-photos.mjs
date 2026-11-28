import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { receive } from '../reviewed-transfer/scripts/issue348-private-r2.mjs';

const bucket = 'malipang-issue348-private-test';
const account = process.env.R2_ACCOUNT;
const root = process.env.ISSUE348_SCRATCH;
const hexDigest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Issue one GET for the exact encrypted object, valid for five minutes.
function signObject(name, reader) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^photos-348-[a-f0-9]{16}\.bin$/.test(name)
      || !/^[a-f0-9]{32}$/.test(reader.id) || !/^[a-f0-9]{64}$/.test(reader.key)) throw Error();
  const host = account + '.r2.cloudflarestorage.com';
  const path = '/' + bucket + '/' + name;
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
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

try {
  const args = process.argv.slice(2);
  const clockOnly = args.length === 1 && args[0] === '--clock-only';
  if (args.length && !clockOnly) throw Error();
  const control = JSON.parse(process.env.PHOTO_CONTROL);
  const reader = JSON.parse(process.env.SCOPED_READER);
  const files = await receive(signObject(control.name, reader), control, 'photos', account);
  const byName = new Map(files.map(f => [f.id, f.bytes]));
  const seen = new Set();
  const slipIds = ['kbank-kplus', 'paotang-gwallet', 'scb-easy'];
  for (const [group, count, prefix] of [['clock', 7, 'photo'], ['slip', 3, 'slip']]) {
    const cases = control[group].cases;
    if (cases.length !== count) throw Error();
    const dir = join(root, group);
    const stage = group === 'clock' || !clockOnly;
    if (stage) await mkdir(dir, {mode: 0o700});
    for (let i = 0; i < count; i++) {
      const filename = prefix + '-' + String(i + 1).padStart(2, '0') + '.jpg';
      const row = cases.find(x => x.file === filename);
      const data = byName.get(filename);
      if (!row || !data || data.length > 5 * 1024 * 1024 || data[0] !== 255 || data[1] !== 216
          || row.sha256 !== hexDigest(data) || seen.has(row.sha256)) throw Error();
      const expectedId = group === 'clock' ? filename.slice(0, -4) : slipIds[i];
      if (row.id !== expectedId) throw Error();
      if (group === 'clock' && i < 5) {
        const {date, time} = row.verifiedOverlay ?? {};
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
            || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date
            || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw Error();
      }
      seen.add(row.sha256);
      if (stage) await writeFile(join(dir, filename), data, {mode: 0o600, flag: 'wx'});
    }
    if (stage) await writeFile(join(dir, 'manifest.json'), JSON.stringify(control[group]), {mode: 0o600, flag: 'wx'});
  }
  console.log(clockOnly ? 'ISSUE348_CLOCK_STAGING_OK' : 'Private transfer verified: seven attendance photos and three slips');
} catch {
  console.error('Private transfer or input validation failed; stopped before evaluation');
  process.exitCode = 1;
}
