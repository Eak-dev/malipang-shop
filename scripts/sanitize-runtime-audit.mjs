import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REJECTED = 'Runtime audit evidence rejected.';
const MODES = ['production', 'shadow'];
const PROBES = ['d1', 'line', 'lineReplyCapability', 'linePushCapacity', 'sheets', 'r2', 'attendanceConfig'];
const INBOUND_STATUSES = ['PROCESSING', 'COMPLETED', 'FAILED', 'STALE', 'IGNORED', 'REJECTED', 'REVIEW'];
const SYNC_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
const PUSH_CAPACITIES = ['UNLIMITED', 'AVAILABLE', 'EXHAUSTED', 'UNKNOWN'];

function reject() { throw new Error(REJECTED); }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value;
}
function boolean(value) {
  if (typeof value !== 'boolean') reject();
  return value;
}
function enumeration(value, allowed) {
  if (!allowed.includes(value)) reject();
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) reject();
  return value;
}
function statusCounts(value, allowed) {
  if (!Array.isArray(value)) reject();
  const seen = new Set();
  return value.map(row => {
    object(row);
    const status = enumeration(row.status, allowed);
    if (seen.has(status)) reject();
    seen.add(status);
    return { status, count: count(row.count) };
  });
}
function versionId(value) {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) reject();
  return value;
}
function timestamp(value) {
  // Cloudflare timestamps can include sub-millisecond precision. Accept only
  // bounded ISO date/time syntax, never a free-form date or appended diagnostics.
  if (typeof value !== 'string' || value.trim() !== value || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) reject();
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0) || !Number.isFinite(Date.parse(value))) reject();
  return value;
}

// Reconstruct each output from validated scalars. New upstream properties must
// never become artifact contents merely because the provider adds them.
export function sanitizeRuntimeAudit(kind, body) {
  try {
    if (kind === 'versions') {
      if (!Array.isArray(body)) reject();
      return body.map(version => {
        object(version);
        const metadata = object(version.metadata);
        return {
          id: versionId(version.id),
          metadata: { created_on: timestamp(metadata.created_on) },
          ...(Object.hasOwn(version, 'number') ? { number: count(version.number) } : {}),
        };
      });
    }
    object(body);
    if (kind === 'health') {
      return { ok: boolean(body.ok), mode: enumeration(body.mode, MODES), configured: boolean(body.configured) };
    }
    if (kind === 'readiness') {
      const rawChecks = object(body.checks);
      const checks = Object.fromEntries(PROBES.map(key => [key, { ok: boolean(object(rawChecks[key]).ok) }]));
      const push = object(rawChecks.linePushCapacity.detail);
      checks.linePushCapacity.detail = {
        status: enumeration(push.status, ['PASS', 'EXHAUSTED', 'UNKNOWN']),
        severity: enumeration(push.severity, ['OK', 'DEGRADED']),
        ...(Object.hasOwn(push, 'pushCapacity') ? { pushCapacity: enumeration(push.pushCapacity, PUSH_CAPACITIES) } : {}),
      };
      return { ok: boolean(body.ok), checks };
    }
    if (kind === 'status') {
      const line = object(body.line), push = object(line.push);
      return {
        ok: boolean(body.ok),
        mode: enumeration(body.mode, MODES),
        inbound: statusCounts(body.inbound, INBOUND_STATUSES),
        sync: statusCounts(body.sync, SYNC_STATUSES),
        openFailedJobs: count(body.openFailedJobs),
        line: {
          auth: enumeration(line.auth, ['PASS', 'FAIL']),
          replyCapability: enumeration(line.replyCapability, ['PASS', 'FAIL']),
          push: { pushCapacity: enumeration(push.pushCapacity, PUSH_CAPACITIES) },
        },
      };
    }
    reject();
  } catch {
    // Do not include upstream values, JSON parser diagnostics, or caller paths.
    throw new Error(REJECTED);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) reject();
    const [, , kind, input, output] = process.argv;
    const sanitized = sanitizeRuntimeAudit(kind, JSON.parse(readFileSync(input, 'utf8')));
    // Refuse to overwrite an existing file (including the raw input or a symlink).
    // Validation finishes before the output path is created.
    writeFileSync(output, `${JSON.stringify(sanitized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    process.stderr.write(`${REJECTED}\n`);
    process.exitCode = 1;
  }
}
