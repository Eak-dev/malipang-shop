import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
    "real_active == 4",
    "uat_inactive == 3",
    "wage_rows == 4",
    "shift_rows == 28",
    "/admin/import-employees-from-sheet",
    "/admin/import-shifts-from-sheet"
  ])assert.match(workflow,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.doesNotMatch(workflow,/default: "2026-07-23"/);
  assert.doesNotMatch(workflow,/default: "2026-07-29"/);
});
