import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cfg=JSON.parse(fs.readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
const g6a=fs.readFileSync(new URL("../.github/workflows/production-pr247-g6a-gate-on.yml",import.meta.url),"utf8");
const doc=fs.readFileSync(new URL("../docs/ISSUE248_STEADY_PR_B_PREP_TH.md",import.meta.url),"utf8");

test("PR-B local candidate is gate literal false with pacing true",()=>{
 assert.equal(cfg.vars.STABLE_RECOVERY_GATE_ENABLED,"false");
 assert.equal(cfg.vars.STABLE_SHEETS_PACING_ENABLED,"true");
 assert.equal(Object.hasOwn(cfg.vars,"STABLE_SHEETS_READ_BUDGET_PER_MINUTE"),false);
});
test("G6a workflow deliberately fails its on-config guard if retriggered from B",()=>{
 assert.match(g6a,/now\.vars\.STABLE_RECOVERY_GATE_ENABLED!=='true'/);
 assert.match(g6a,/G6A_CONFIG_FLAG_MISMATCH/);
});
test("B is marked NOT MERGE READY until G7 provider readback and G8 owner authorization",()=>{
 assert.match(doc,/LOCAL RELEASE WORKFLOW IMPLEMENTED; AWAITING INDEPENDENT REVIEW \/ NO-GO FOR MERGE/);
 assert.match(doc,/G7/);
 assert.match(doc,/G8/);
 assert.match(doc,/provider readback/i);
 assert.match(doc,/NO-GO/);
});
test("B documents strict future numeric/canary stop constraints",()=>{
 for(const phrase of ["IN_FLIGHT","REVIEW","COMPLETE","CLOSED","429","DLQ","GCP","SHA-256","FINAL"])
 assert.ok(doc.includes(phrase),"must document "+phrase);
});
