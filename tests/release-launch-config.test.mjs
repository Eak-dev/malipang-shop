import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {parseShiftStatus} from "../dist/admin/shift-import.js";

const root=new URL("../",import.meta.url);

test("launch candidate is locked to silent Shadow mode",()=>{
  const config=JSON.parse(fs.readFileSync(new URL("wrangler.jsonc",root),"utf8"));
  assert.equal(config.vars.APP_ENV,"shadow");
  assert.equal(config.vars.RUNTIME_MODE,"shadow");
  assert.equal(config.vars.SHADOW_LINE_OUTPUT,"false");
});

test("release control uses the first real payroll cycle and verifies its sources",()=>{
  const workflow=fs.readFileSync(new URL(".github/workflows/release-control.yml",root),"utf8");
  for(const expected of[
    'default: "2026-07-30"',
    'default: "2026-08-05"',
    'expected="PRODUCTION-2026-07-28"',
    'expected="APPLY-PAYROLL-2026-08-05"',
    "active_total == 4",
    "authorized_active == 4",
    "uat_inactive == 3",
    "wage_rows == 4",
    "shift_rows == 620",
    "expected_rows == 620",
    "first_cycle_rows == 28",
    "employees_with_155 == 4",
    "uat_shift_rows == 0",
    "/admin/import-employees-from-sheet",
    "/admin/import-shifts-from-sheet"
  ])assert.match(workflow,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.ok(workflow.indexOf("Import Staff Config")<workflow.indexOf("Verify exact active employee set after staff import"));
  assert.ok(workflow.indexOf("Verify exact active employee set after staff import")<workflow.indexOf("Import Shift Schedule"));
  assert.doesNotMatch(workflow,/default: "2026-07-23"/);
  assert.doesNotMatch(workflow,/default: "2026-07-29"/);
});

test("current operator documentation matches Silent Shadow and the locked payroll cycle",()=>{
  const readme=fs.readFileSync(new URL("README.md",root),"utf8");
  const runbook=fs.readFileSync(new URL("docs/16_WEDNESDAY_PAYROLL_RELEASE_TH.md",root),"utf8");
  assert.match(readme,/\| `APP_ENV` \| `shadow` \|/);
  assert.match(readme,/\| `RUNTIME_MODE` \| `shadow` \|/);
  assert.match(readme,/\| `SHADOW_LINE_OUTPUT` \| `false` \|/);
  assert.match(readme,/Owner DLQ alert/);
  for(const expected of[
    "2026-07-30",
    "2026-08-05",
    "payroll-2026-08-05-v1",
    "SHADOW-PREFLIGHT",
    "PRODUCTION-2026-07-28",
    "PREVIEW-PAYROLL",
    "APPLY-PAYROLL-2026-08-05"
  ])assert.match(runbook,new RegExp(expected));
  assert.match(runbook,/Historical\/Audit/);
  assert.match(runbook,/ห้าม Preview\/Apply รอบ `2026-07-23` ถึง `2026-07-29`/);
});

test("shift status accepts only the three approved source values",()=>{
  assert.equal(parseShiftStatus("EXPECTED"),"EXPECTED");
  assert.equal(parseShiftStatus("DAY_OFF"),"DAY_OFF");
  assert.equal(parseShiftStatus("CANCELLED"),"CANCELLED");
  assert.throws(()=>parseShiftStatus(""),/Invalid shift status/);
  assert.throws(()=>parseShiftStatus("EXPECTD"),/Invalid shift status/);
});
