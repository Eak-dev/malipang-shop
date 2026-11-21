import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Executes ONLY local synthetic in-memory sqlite3 via Python stdlib, no network.
const script = readFileSync(new URL("../scripts/pr247-readonly-snapshot.sh", import.meta.url), "utf8");
const extract = (begin, end) => {
  const a=script.indexOf(begin);
  const b=script.indexOf(end,a);
  assert.ok(a>=0&&b>a,"missing exact SQL component");
  return script.slice(a,b).trim();
};
const held = extract("(SELECT count(*) FROM stable_workbook_claims c WHERE c.state='HELD'", " stale_held,");
const unleased = extract("(SELECT count(*) FROM stable_projection_writes p WHERE p.state='IN_FLIGHT'", " unleased_inflight,");

const python = String.raw`
import sqlite3
c=sqlite3.connect(':memory:')
c.executescript("""
CREATE TABLE stable_workbook_claims(state TEXT,updated_at TEXT);
CREATE TABLE stable_projection_writes(entity_type TEXT,entity_id TEXT,source_version INTEGER,projection TEXT,state TEXT);
CREATE TABLE sync_jobs(entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT,lease_until TEXT,lease_token TEXT,updated_at TEXT);
""")
sql = "SELECT " + __HELD__ + " AS stale_held, " + __UNLEASED__ + " AS unleased_inflight"
def counts():
 return list(c.execute(sql))[0]
assert counts() == (0,0), ('empty',counts())
c.execute("INSERT INTO stable_workbook_claims VALUES('HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
c.execute("INSERT INTO stable_projection_writes VALUES('EXPENSE','synexpense',1,'DAILY','IN_FLIGHT')")
c.execute("INSERT INTO sync_jobs VALUES('EXPENSE','synexpense',1,'PROCESSING',strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'synthetic-lease',strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
assert counts() == (0,0), ('healthy',counts())
c.execute("UPDATE sync_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')")
assert counts() == (0,1), ('expired',counts())
c.execute("UPDATE sync_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')")
c.execute("UPDATE stable_workbook_claims SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-16 minutes')")
assert counts() == (1,0), ('stale claim',counts())
c.execute("UPDATE stable_workbook_claims SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
for bad in (None,'invalid','9999-12-31T23:59:59.999Z','2026-02-30T00:00:00.000Z','2026-01-01 00:00:00'):
 c.execute('UPDATE stable_workbook_claims SET updated_at=?',(bad,))
 assert counts() == (1,0), ('malformed or future claim',bad,counts())
c.execute("UPDATE stable_workbook_claims SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
for bad in (None,'invalid','zzzzzz','9999-99-99T23:59:59.999Z','9999-12-31T23:59:59+00:00','2026-02-30T00:00:00.000Z'):
 c.execute('UPDATE sync_jobs SET lease_until=?',(bad,))
 assert counts() == (0,1), ('malformed lease',bad,counts())
c.execute("UPDATE sync_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')")
for bad in (None,''):
 c.execute('UPDATE sync_jobs SET lease_token=?',(bad,))
 assert counts() == (0,1), ('missing lease token',bad,counts())
c.execute("UPDATE sync_jobs SET lease_token='synthetic-lease'")
for bad in (None,'invalid','9999-12-31T23:59:59.999Z','2026-02-30T00:00:00.000Z'):
 c.execute('UPDATE sync_jobs SET updated_at=?',(bad,))
 assert counts() == (0,1), ('invalid or future job update',bad,counts())
c.execute("UPDATE sync_jobs SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
c.execute("UPDATE stable_projection_writes SET entity_id='synexpense|item01',projection='DETAIL'")
assert counts() == (0,0), ('detail prefix',counts())
c.execute("UPDATE sync_jobs SET status='COMPLETED'")
assert counts() == (0,1), ('unowned journal',counts())
print('SYNTHETIC_SQL_LEASE_CASES_PASSED')
`.replace("__HELD__",JSON.stringify(held)).replace("__UNLEASED__",JSON.stringify(unleased));

test("actual read-only SQL detects stale HELD and unleased IN_FLIGHT without false alarms", () => {
  const result=execFileSync("python3",["-c",python],{encoding:"utf8",timeout:10000});
  assert.match(result,/SYNTHETIC_SQL_LEASE_CASES_PASSED/);
});
