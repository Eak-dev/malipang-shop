import { createHash } from 'node:crypto';
import { decryptPackage, validateFiles } from './issue348-transfer-rehearsal.mjs';

const bucket = 'malipang-issue348-private-test';
const maxPackage = 80 * 1024 * 1024;

export async function receive(urlText, control, prefix, account) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{64}$/.test(control.sha256)
      || !/^[a-f0-9]{64}$/.test(control.key) || !['synthetic', 'photos'].includes(prefix)) {
    throw new Error('Invalid transfer settings');
  }
  const url = new URL(urlText);
  const name = prefix + '-348-' + control.sha256.slice(0, 16) + '.bin';
  const expiry = Number(url.searchParams.get('X-Amz-Expires'));
  if (url.origin !== 'https://' + account + '.r2.cloudflarestorage.com' || url.username || url.password
      || url.hash || url.pathname !== '/' + bucket + '/' + name || control.name !== name
      || !(expiry > 0 && expiry <= 3600) || !url.searchParams.has('X-Amz-Signature')) {
    throw new Error('Unapproved transfer');
  }
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error('Private download denied');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxPackage) throw new Error('Package too large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  if (createHash('sha256').update(bytes).digest('hex') !== control.sha256) throw new Error('Package digest mismatch');
  if (control.expected.count !== 10 || control.expected.files.length !== 10
      || new Set(control.expected.files.map(f => f.id)).size !== 10) throw new Error('Expected ten distinct files');
  return validateFiles(decryptPackage(bytes, Buffer.from(control.key, 'hex')), control.expected);
}
