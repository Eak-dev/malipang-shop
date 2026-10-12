import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeRuntimeAudit } from '../scripts/sanitize-runtime-audit.mjs';

const REJECTED = 'Runtime audit evidence rejected.';
const SENTINEL = 'SYNTHETIC_PRIVATE_SENTINEL@example.invalid';
const VERSION_ID = '11111111-2222-4333-8444-555555555555';
const CREATED_ON = '2026-10-12T08:09:10.123456Z';
const PROBES = ['d1', 'line', 'lineReplyCapability', 'linePushCapacity', 'sheets', 'r2', 'attendanceConfig'];
const SCRIPT = fileURLToPath(new URL('../scripts/sanitize-runtime-audit.mjs', import.meta.url));

function fixtures() {
  return {
    health: { ok: true, mode: 'production', configured: true },
    readiness: {
      ok: true,
      checks: {
        ...Object.fromEntries(PROBES.map(key => [key, { ok: true }])),
        linePushCapacity: { ok: true, detail: { status: 'EXHAUSTED', severity: 'DEGRADED', pushCapacity: 'EXHAUSTED' } },
      },
    },
    status: {
      ok: true, mode: 'production',
      inbound: ['PROCESSING', 'COMPLETED', 'FAILED', 'STALE', 'IGNORED', 'REJECTED', 'REVIEW'].map((status, count) => ({ status, count })),
      sync: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].map((status, count) => ({ status, count })),
      openFailedJobs: 0,
      line: { auth: 'PASS', replyCapability: 'PASS', push: { pushCapacity: 'EXHAUSTED' } },
    },
    versions: [{ id: VERSION_ID, number: 123, metadata: { created_on: CREATED_ON } }],
  };
}

function rejected(kind, body) {
  assert.throws(() => sanitizeRuntimeAudit(kind, body), error => error.message === REJECTED);
}

function withPrivateFields(value) {
  if (Array.isArray(value)) return value.map(withPrivateFields);
  if (!value || typeof value !== 'object') return value;
  return {
    ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withPrivateFields(child)])),
    userId: SENTINEL, displayName: SENTINEL, basicId: SENTINEL,
    spreadsheetId: SENTINEL, spreadsheetUrl: SENTINEL,
    title: SENTINEL, properties: { title: SENTINEL },
    author_email: SENTINEL, author_id: SENTINEL,
    annotations: { message: SENTINEL, tag: SENTINEL },
    message: SENTINEL, tag: SENTINEL,
    error: SENTINEL, warning: SENTINEL,
    privateEvidenceUrl: SENTINEL, accessToken: SENTINEL,
    futureProviderField: { nested: [SENTINEL] },
  };
}

test('all audit kinds retain only allowlisted evidence despite private fields at every object depth', () => {
  for (const [kind, expected] of Object.entries(fixtures())) {
    const body = withPrivateFields(expected);
    if (kind === 'health') Object.assign(body, { service: SENTINEL, version: SENTINEL, missing: [SENTINEL], now: SENTINEL });
    if (kind === 'readiness') {
      body.checkedAt = SENTINEL;
      for (const key of PROBES.filter(key => key !== 'linePushCapacity')) body.checks[key].detail = withPrivateFields({ metadata: { sheets: [{ properties: { title: SENTINEL } }] } });
      body.checks[SENTINEL] = { ok: true, detail: SENTINEL };
    }
    if (kind === 'status') body.now = SENTINEL;
    const result = sanitizeRuntimeAudit(kind, body);
    assert.deepEqual(result, expected, kind);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false, kind);
  }
});

test('safe failures, shadow mode, empty queues and unavailable Push remain truthful', () => {
  const bodies = fixtures();
  assert.deepEqual(sanitizeRuntimeAudit('health', { ok: false, mode: 'shadow', configured: false }), { ok: false, mode: 'shadow', configured: false });
  bodies.readiness.ok = false;
  bodies.readiness.checks.line.ok = false;
  bodies.readiness.checks.lineReplyCapability.ok = false;
  bodies.readiness.checks.linePushCapacity.detail = { status: 'UNKNOWN', severity: 'DEGRADED', warning: SENTINEL };
  const readiness = sanitizeRuntimeAudit('readiness', bodies.readiness);
  assert.equal(readiness.ok, false);
  assert.equal(readiness.checks.line.ok, false);
  assert.deepEqual(readiness.checks.linePushCapacity.detail, { status: 'UNKNOWN', severity: 'DEGRADED' });
  const status = { ...bodies.status, ok: false, mode: 'shadow', inbound: [], sync: [], line: { auth: 'FAIL', replyCapability: 'FAIL', push: { pushCapacity: 'UNKNOWN', warning: SENTINEL } } };
  assert.deepEqual(sanitizeRuntimeAudit('status', status), { ...status, line: { auth: 'FAIL', replyCapability: 'FAIL', push: { pushCapacity: 'UNKNOWN' } } });
});

test('valid Push capacity enum values and optional version numbers are accepted', () => {
  for (const pushCapacity of ['UNLIMITED', 'AVAILABLE', 'EXHAUSTED', 'UNKNOWN']) {
    const body = fixtures().status;
    body.line.push.pushCapacity = pushCapacity;
    assert.equal(sanitizeRuntimeAudit('status', body).line.push.pushCapacity, pushCapacity);
  }
  assert.deepEqual(sanitizeRuntimeAudit('versions', [{ id: VERSION_ID, metadata: { created_on: CREATED_ON } }]), [{ id: VERSION_ID, metadata: { created_on: CREATED_ON } }]);
});

const requiredPaths = {
  health: ['ok', 'mode', 'configured'],
  readiness: ['ok', 'checks', ...PROBES.flatMap(key => [`checks.${key}`, `checks.${key}.ok`]), 'checks.linePushCapacity.detail', 'checks.linePushCapacity.detail.status', 'checks.linePushCapacity.detail.severity'],
  status: ['ok', 'mode', 'inbound', 'inbound.0.status', 'inbound.0.count', 'sync', 'sync.0.status', 'sync.0.count', 'openFailedJobs', 'line', 'line.auth', 'line.replyCapability', 'line.push', 'line.push.pushCapacity'],
  versions: ['0.id', '0.metadata', '0.metadata.created_on'],
};

function change(body, path, value, remove = false) {
  const parts = path.split('.');
  const parent = parts.slice(0, -1).reduce((value, key) => value[key], body);
  if (remove) delete parent[parts.at(-1)];
  else parent[parts.at(-1)] = value;
}

test('every required field rejects missing values, wrong types and attacker strings', () => {
  for (const [kind, paths] of Object.entries(requiredPaths)) {
    for (const path of paths) {
      for (const value of [undefined, null, SENTINEL, {}, []]) {
        // Empty queues are a valid status snapshot, and empty check objects are
        // not valid: the fixed required probe list is always enforced.
        if (kind === 'status' && ['inbound', 'sync'].includes(path) && Array.isArray(value)) continue;
        const body = fixtures()[kind];
        change(body, path, value, value === undefined);
        rejected(kind, body);
      }
    }
  }
  for (const kind of Object.keys(fixtures())) {
    for (const body of [null, true, 1, SENTINEL, {}]) rejected(kind, body);
  }
  rejected(SENTINEL, fixtures().health);
});

test('counts reject coercion, negatives, fractions, non-finite and unsafe integers', () => {
  for (const value of ['0', false, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const path of ['openFailedJobs', 'inbound.0.count', 'sync.0.count']) {
      const body = fixtures().status;
      change(body, path, value);
      rejected('status', body);
    }
    const versions = fixtures().versions;
    versions[0].number = value;
    rejected('versions', versions);
  }
});

test('unknown or duplicate queue status rows reject the whole snapshot without hiding counts', () => {
  for (const key of ['inbound', 'sync']) {
    for (const row of [{ status: 'FUTURE_STATUS', count: 1 }, { status: SENTINEL, count: 1 }, null, {}]) {
      const body = fixtures().status;
      body[key].push(row);
      rejected('status', body);
    }
    const body = fixtures().status;
    body[key].push({ ...body[key][0] });
    rejected('status', body);
  }
});

test('UUID and timestamp validators reject appended data and invalid dates', () => {
  for (const id of [SENTINEL, `${VERSION_ID}\n${SENTINEL}`, `${VERSION_ID}\n`, `${VERSION_ID} `, VERSION_ID.replace('-', ''), 123]) {
    const body = fixtures().versions;
    body[0].id = id;
    rejected('versions', body);
  }
  for (const created_on of [SENTINEL, `${CREATED_ON}\n${SENTINEL}`, `${CREATED_ON}\n`, '2026-02-30T08:09:10Z', '2026-13-01T08:09:10Z', '2026-10-12', '2026-10-12T24:00:00Z', 123]) {
    const body = fixtures().versions;
    body[0].metadata.created_on = created_on;
    rejected('versions', body);
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI writes sanitized artifacts only and leaves stdout/stderr empty on success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-audit-sanitizer-'));
  try {
    for (const [kind, body] of Object.entries(fixtures())) {
      const input = join(directory, `${kind}.raw.json`), output = join(directory, `${kind}.json`);
      writeFileSync(input, JSON.stringify(withPrivateFields(body)));
      const result = runCli([kind, input, output]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), body);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI fails closed without an output or raw diagnostics for invalid input and private paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-audit-sanitizer-'));
  try {
    const input = join(directory, `${SENTINEL}.raw.json`), output = join(directory, 'sanitized.json');
    const assertFailure = args => {
      const result = runCli(args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${REJECTED}\n`);
      assert.equal(existsSync(output), false);
    };
    assertFailure(['health', input, output]);
    writeFileSync(input, `{"raw":"${SENTINEL}", invalid JSON`);
    assertFailure(['health', input, output]);
    for (const kind of Object.keys(fixtures())) {
      writeFileSync(input, JSON.stringify({ raw: SENTINEL }));
      assertFailure([kind, input, output]);
    }
    assertFailure([SENTINEL, input, output]);
    assertFailure(['health', input]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI refuses an existing output or using its raw input as output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-audit-sanitizer-'));
  try {
    const input = join(directory, 'raw.json'), output = join(directory, 'existing.json');
    const raw = JSON.stringify(withPrivateFields(fixtures().health));
    writeFileSync(input, raw);
    writeFileSync(output, 'existing output');
    for (const destination of [input, output]) {
      const result = runCli(['health', input, destination]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${REJECTED}\n`);
    }
    assert.equal(readFileSync(input, 'utf8'), raw);
    assert.equal(readFileSync(output, 'utf8'), 'existing output');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
