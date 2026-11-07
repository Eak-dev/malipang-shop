import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/production-pr247-flags-off-release.yml", import.meta.url),
  "utf8",
);
const docs = fs.readFileSync(
  new URL("../docs/RELEASE_PR247_FLAGS_OFF_TH.md", import.meta.url),
  "utf8",
);

const at = (text) => {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, "missing: " + text);
  return index;
};
const section = (start, end) => workflow.slice(at(start), at(end));

test("manual-only release and explicit confirmation", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow, /test "\$CONFIRMATION" = 'RELEASE PR247 4bb84a4 MIGRATION 0023 FLAGS OFF KEEP REVIEW'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: malipang-release-control/);
});

test("reviewed exact runtime source and exact main SHA are enforced", () => {
  assert.match(workflow, /REVIEWED_SOURCE_SHA: 4bb84a4869920f70981477de0ef69607438e2c74/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /test "\$\(git rev-parse refs\/review\/pr247\)" = "\$REVIEWED_SOURCE_SHA"/);
  assert.match(workflow, /git diff --quiet "\$REVIEWED_SOURCE_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json tsconfig\.json/);
  assert.doesNotMatch(workflow, /EXPECTED_SHA: [0-9a-f]{40}/);
});

test("only additive migration 0023 after 0022; P0 flags remain absent", () => {
  assert.match(workflow, /PRIOR_MIGRATION: 0022_stable_claim_diagnostics\.sql/);
  assert.match(workflow, /MIGRATION: 0023_stable_recovery_admission\.sql/);
  assert.match(workflow, /test "\$\(ls migrations \| awk -v p="\$PRIOR_MIGRATION" '\$0>p'\)" = "\$MIGRATION"/);
  assert.ok(fs.existsSync(new URL("../migrations/0022_stable_claim_diagnostics.sql", import.meta.url)));
  assert.match(workflow, /P0 flag must stay absent/);
  assert.doesNotMatch(workflow, /--var\b|--vars\b|wrangler secret|STABLE_RECOVERY_GATE_ENABLED[=:]\s*["']?true/);
});

test("order remains pause → drain → private backup → 0023 → deploy → verify → resume", () => {
  const order = [
    at("npm run check"),
    at("queues pause-delivery malipang-jobs"),
    at("npx wrangler d1 export malipang-v5-2 --remote"),
    at("test \"$(sha256sum"),
    at("PRAGMA integrity_check"),
    at("npx wrangler d1 migrations apply malipang-v5-2 --remote"),
    at("npx wrangler deploy\n"),
    at("queues resume-delivery malipang-jobs"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("retains existing REVIEW and verifies financial outbox was not released", () => {
  assert.match(workflow, /\.results\[0\]\.review == 1 and \.\[0\]\.results\[0\]\.held == 0 and \.\[0\]\.results\[0\]\.in_flight == 0/);
  assert.match(workflow, /\.claim\.state == "REVIEW" and \.recoveryGate\.mode == "DISABLED" and \.sheetPacing\.mode == "DISABLED"/);
  assert.match(workflow, /\.completed == \$c and \.\[0\]\.results\[0\]\.open_failed <= \$f/);
});

test("cannot edit REVIEW/epochs/business rows or replay DLQ from this workflow", () => {
  assert.doesNotMatch(workflow, /(DELETE FROM|UPDATE|INSERT INTO)\s+(stable_workbook_claims|stable_recovery_epochs|stable_recovery_operations|sync_jobs|stable_projection_writes|expense_events|failed_jobs|staff_config_sync_outbox)/i);
  assert.doesNotMatch(workflow, /retry-sync|bootstrap-sheets|staff-import|shift-import|reconcile-sheets|resume-capacity|includeTerminalDlq|queues purge|sheets\.googleapis/);
});

test("hard-fails BEFORE pause unless Cron triggers are externally fenced by separate Owner approval", () => {
  const prior = workflow.slice(0, at("queues pause-delivery malipang-jobs"));
  assert.match(prior, /workers\/scripts\/malipang-backend-v5-2\/schedules/);
  assert.match(prior, /schedules \| length/);
  assert.match(prior, /CRON_FENCE_NOT_VERIFIED/);
  assert.match(docs, /แยกต่างหาก|separate Owner/);
  assert.match(docs, /Cron/);
});

test("must prove queue was active before taking ownership, and retain durable pause intent", () => {
  const prior = workflow.slice(0, at("queues pause-delivery malipang-jobs"));
  assert.match(prior, /cf_get "\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/queues"/);
  assert.match(prior, /delivery_paused == false/);
  assert.match(prior, /release-control\/pr247/);
  assert.match(prior, /PAUSE_INTENT/);
  assert.match(prior, /r2 object put/);
  assert.match(workflow, /PAUSE_CONFIRMED/);
});

test("drain explicitly checks in-flight LINE events and other known D1 writers", () => {
  const step = section("Pause delivery and wait for active writers", "Fresh private backup and restored migration validation");
  assert.match(step, /inbound_events/);
  assert.match(step, /stable_workbook_claims/);
  assert.match(step, /staff_config_sync_outbox/);
  assert.match(step, /CONSECUTIVE_QUIET_CHECKS/);
});

test("export revalidates both paused queue and disabled Cron immediately before D1 export", () => {
  const step = section("Fresh private backup and restored migration validation", "Apply only additive migration 0023");
  assert.match(step, /CRON_FENCE_LOST/);
  assert.match(step, /QUEUE_FENCE_LOST/);
  assert.ok(step.indexOf("CRON_FENCE_LOST") < step.indexOf("npx wrangler d1 export malipang-v5-2 --remote"));
});

test("records pinned old Worker and verifies new deployment version", () => {
  assert.match(workflow, /PRIOR_WORKER_VERSION/);
  assert.match(workflow, /WORKER_VERSION_UNVERIFIED/);
  assert.match(workflow, /workers\/scripts\/malipang-backend-v5-2\/deployments/);
  assert.match(docs, /310192aa|Worker Version/);
});

test("does not clear durable intent before post-resume verification", () => {
  const step = section("Resume delivery and prove the release is inert", "Failure handling");
  assert.match(step, /RESUME_REQUESTED/);
  assert.match(step, /RESUMED_VERIFIED/);
  assert.match(step, /POSTCHECK_FAILED/);
  assert.ok(step.indexOf("RESUME_REQUESTED") < step.indexOf("POSTCHECK_FAILED"));
  assert.doesNotMatch(step, /rm -f "\$RUNNER_TEMP\/delivery-paused"/);
});

test("failure and cancellation handler is invoked but does NOT claim guaranteed cleanup after runner death", () => {
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /MANUAL_CONTAINMENT_REQUIRED/);
  assert.match(docs, /Timeout|timeout/i);
  assert.match(docs, /Cancel|cancel/i);
  assert.match(docs, /runner|Runner/i);
  assert.doesNotMatch(docs, /ยืนยัน.*100%.*resume/i);
});


test("a failing health/readback after confirmed resume triggers bounded re-pause rather than a silent log", () => {
  const cleanup = workflow.slice(at("Failure handling"));
  assert.match(cleanup, /if \[ "\$state" = RESUMED_VERIFIED \]/);
  assert.match(cleanup, /queues pause-delivery malipang-jobs/);
  assert.match(cleanup, /\.state="POSTCHECK_FAILED"/);
  assert.match(cleanup, /queue-final-containment\.json/);
  assert.match(cleanup, /MANUAL_CONTAINMENT_REQUIRED/);
});

test("all embedded workflow shell steps pass Bash syntax validation", () => {
  const lines = workflow.split(/\r?\n/);
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "        run: |") continue;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.startsWith("          ") && line.trim() !== "") break;
      block.push(line.startsWith("          ") ? line.slice(10) : "");
    }
    scripts.push(block.join("\n") + "\n");
  }
  assert.ok(scripts.length >= 9, "workflow must retain all guarded stages");
  for (const [i, script] of scripts.entries()) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, "Bash syntax invalid in stage " + (i + 1) + ": " + result.stderr);
  }
});

test("negative scenarios documented instead of assumed PASS", () => {
  assert.match(docs, /lost ACK|ACK loss/i);
  assert.match(docs, /external writer|external admin/i);
  assert.match(docs, /post-resume/i);
  assert.match(docs, /NO-GO/);
});

// Actual Bash execution with a synthetic, local-only Cloudflare fixture.
// All provider commands are shadowed by stubs and NEVER access Production.
function extractStepBash(name) {
  const lines=workflow.split(/\r?\n/);
  const start=lines.indexOf("      - name: "+name);
  assert.ok(start>=0,"missing workflow step "+name);
  const marker=lines.indexOf("        run: |",start);
  assert.ok(marker>start&&marker<start+4,"missing Bash body");
  const out=[];
  for(let i=marker+1;i<lines.length;i++){
    if(!lines[i].startsWith("          ")&&lines[i].trim())break;
    out.push(lines[i].startsWith("          ")?lines[i].slice(10):"");
  }
  return out.join("\n");
}

function runFakePreflight({cronActive,queuePaused}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mp-pr250-safe-"));
  const bin=path.join(dir,"bin"),log=path.join(dir,"calls");
  fs.mkdirSync(bin);fs.writeFileSync(log,"");
  const curl=[
    '#!/usr/bin/env node',
    'const fs=require("fs"),url=process.argv.at(-1);',
    'fs.appendFileSync(process.env.CALL_LOG,"curl "+url+"\\n");',
    'let result;',
    'if(url.endsWith("/schedules"))result={schedules:process.env.FAKE_CRON==="1"?[{cron:"*/5 * * * *"}]:[]};',
    'else if(url.endsWith("/queues"))result=[{queue_name:"malipang-jobs",queue_id:"b9b12fe82e6b402291b5d16d2ce61770",settings:{delivery_paused:process.env.FAKE_QUEUE==="1"}}];',
    'else result={deployments:[{versions:[{percentage:100,version_id:"310192aa-8a04-4b61-8a72-4455231b3339"}]}]};',
    'process.stdout.write(JSON.stringify({success:true,result}));',
  ].join("\n");
  const jq=[
    '#!/usr/bin/env node',
    'const fs=require("fs"),args=process.argv.slice(2);',
    'const exp=args.find(x=>x.startsWith(".success")||x.includes(".queue_id")||x.includes(".version_id"));',
    'const file=args.at(-1),doc=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};',
    'let v=false;',
    'if(exp?.includes(".result.schedules"))v=doc.success===true&&Array.isArray(doc.result?.schedules)&&doc.result.schedules.length===0;',
    'else if(exp?.includes("delivery_paused == false"))v=doc.success===true&&doc.result?.length===1&&doc.result[0].queue_name==="malipang-jobs"&&doc.result[0].settings.delivery_paused===false;',
    'else if(exp?.includes(".queue_id"))v=doc.result?.[0]?.queue_id||"";',
    'else if(exp?.includes(".version_id"))v=doc.result?.deployments?.[0]?.versions?.[0]?.version_id||"";',
    'else if(exp?.includes(".result.deployments"))v=doc.success===true&&doc.result?.deployments?.[0]?.versions?.length===1&&doc.result.deployments[0].versions[0].percentage===100;',
    'else if(args.includes("-n"))v={release:"PR247",state:"PAUSE_INTENT"};',
    'process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));',
    'process.exit(v===false?1:0);',
  ].join("\n");
  const npx=[
    '#!/usr/bin/env node',
    'require("fs").appendFileSync(process.env.CALL_LOG,"npx "+process.argv.slice(2).join(" ")+"\\n");',
    'process.exit(77);',
  ].join("\n");
  for(const [name,script] of [["curl",curl],["jq",jq],["npx",npx]]){
    const p=path.join(bin,name);fs.writeFileSync(p,script,{mode:0o700});
  }
  try{
    const proc=spawnSync("bash",["-c",extractStepBash("Verify Cron writer fence and Queue ownership; record durable pause intent")],{
      cwd:dir,encoding:"utf8",timeout:12000,
      env:{...process.env,PATH:bin+":"+process.env.PATH,CALL_LOG:log,
        RUNNER_TEMP:dir,GITHUB_ENV:path.join(dir,"env"),GITHUB_STEP_SUMMARY:path.join(dir,"summary"),
        CLOUDFLARE_ACCOUNT_ID:"synthetic",CLOUDFLARE_API_TOKEN:"synthetic",
        GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",EXPECTED_SHA:"a".repeat(40),
        FAKE_CRON:cronActive?"1":"0",FAKE_QUEUE:queuePaused?"1":"0"},
    });
    return {proc,calls:fs.readFileSync(log,"utf8")};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test("FAULT INJECTION: active Cron rejects before Pause without any remote mutation",()=>{
  const {proc,calls}=runFakePreflight({cronActive:true,queuePaused:false});
  assert.notEqual(proc.status,0);
  assert.match(proc.stderr,/CRON_FENCE_NOT_VERIFIED/);
  assert.doesNotMatch(calls,/npx|\/queues/);
});
test("FAULT INJECTION: already paused Queue rejects ownership without a second Pause",()=>{
  const {proc,calls}=runFakePreflight({cronActive:false,queuePaused:true});
  assert.notEqual(proc.status,0);
  assert.match(proc.stderr,/QUEUE_NOT_ACTIVE_OR_OWNERSHIP_UNKNOWN/);
  assert.match(calls,/\/queues/);
  assert.doesNotMatch(calls,/npx/);
});
test("FAULT INJECTION: safe preflight attempts durable R2 intent before Queue Pause",()=>{
  const {proc,calls}=runFakePreflight({cronActive:false,queuePaused:false});
  assert.equal(proc.status,77,"Mock npx must stop at first R2 action: "+proc.stderr);
  assert.match(calls,/npx wrangler r2 object put/);
  assert.doesNotMatch(calls,/queues pause-delivery/);
});

// Fault injection for the actual cleanup Bash body. The R2/Queue responses
// are synthetic local files, not connected external services.
function runFakeCleanup({initialState="PAUSE_INTENT",queuePaused=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mp-pr250-cleanup-"));
  const bin=path.join(dir,"bin"),log=path.join(dir,"calls"),queue=path.join(dir,"queue-state");
  fs.mkdirSync(bin);fs.writeFileSync(log,"");fs.writeFileSync(queue,queuePaused?"1":"0");
  const npx=[
    '#!/usr/bin/env node',
    'const fs=require("fs"),a=process.argv.slice(2);',
    'fs.appendFileSync(process.env.CALL_LOG,"npx "+a.join(" ")+"\\n");',
    'if(a.includes("get")&&a.includes("object")){const f=a.find(x=>x.startsWith("--file=")).slice(7);fs.writeFileSync(f,JSON.stringify({state:process.env.FAKE_INTENT}));}',
    'if(a.includes("pause-delivery"))fs.writeFileSync(process.env.QUEUE_STATE,"1");',
    'process.exit(0);',
  ].join("\n");
  const curl=[
    '#!/usr/bin/env node',
    'const fs=require("fs");fs.appendFileSync(process.env.CALL_LOG,"curl\\n");',
    'const paused=fs.readFileSync(process.env.QUEUE_STATE,"utf8")==="1";',
    'process.stdout.write(JSON.stringify({success:true,result:{queue_name:"malipang-jobs",settings:{delivery_paused:paused}}}));',
  ].join("\n");
  const jq=[
    '#!/usr/bin/env node',
    'const fs=require("fs"),a=process.argv.slice(2),expr=a.find(x=>x.includes(".state")||x.includes(".result")||x.includes("Queue delivery_paused"));',
    'const f=a.at(-1),d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};',
    'let out,pass=true;',
    'if(expr?.includes(".state //"))out=d.state||"UNKNOWN";',
    'else if(expr?.includes("delivery_paused | type")){pass=d.success&&d.result.queue_name==="malipang-jobs"&&typeof d.result.settings.delivery_paused==="boolean";out=pass;}',
    'else if(expr?.includes("delivery_paused == false")){pass=d.success&&d.result.settings.delivery_paused===false;out=pass;}',
    'else if(expr?.includes("delivery_paused == true")){pass=d.success&&d.result.settings.delivery_paused===true;out=pass;}',
    'else if(expr?.includes("Queue delivery_paused"))out="Queue delivery_paused readback: "+d.result.settings.delivery_paused;',
    'else if(expr?.includes(".state=\\"POSTCHECK_FAILED\\""))out={...d,state:"POSTCHECK_FAILED"};',
    'else {pass=false;out=false;}',
    'process.stdout.write(typeof out==="object"?JSON.stringify(out):String(out));',
    'process.exit(pass?0:1);',
  ].join("\n");
  for(const [name,s] of [["npx",npx],["curl",curl],["jq",jq]]){
    fs.writeFileSync(path.join(bin,name),s,{mode:0o700});
  }
  try{
    const proc=spawnSync("bash",["-c",extractStepBash("Failure handling")],{
      encoding:"utf8",timeout:15000,cwd:dir,
      env:{...process.env,PATH:bin+":"+process.env.PATH,
        CALL_LOG:log,QUEUE_STATE:queue,FAKE_INTENT:initialState,
        RUNNER_TEMP:dir,GITHUB_ENV:path.join(dir,"env"),
        GITHUB_STEP_SUMMARY:path.join(dir,"summary"),
        CLOUDFLARE_ACCOUNT_ID:"synthetic",CLOUDFLARE_API_TOKEN:"synthetic",
        RELEASE_QUEUE_ID:"b9b12fe82e6b402291b5d16d2ce61770",
        RELEASE_INTENT_KEY:"release-control/pr247/SYNTHETIC.json"},
    });
    return {proc,calls:fs.readFileSync(log,"utf8"),summary:fs.readFileSync(path.join(dir,"summary"),"utf8"),
      currentPaused:fs.readFileSync(queue,"utf8")==="1"};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test("FAULT INJECTION: lost pause ACK retains intent, never blindly resumes Queue",()=>{
  const {proc,calls,summary}=runFakeCleanup({initialState:"PAUSE_INTENT",queuePaused:true});
  assert.equal(proc.status,0,proc.stderr);
  assert.match(summary,/MANUAL_CONTAINMENT_REQUIRED/);
  assert.match(calls,/r2 object get/);
  assert.doesNotMatch(calls,/queues (resume-delivery|pause-delivery)/);
});

test("FAULT INJECTION: post-resume failure attempts audited re-pause only after verified active Queue",()=>{
  const {proc,calls,summary,currentPaused}=runFakeCleanup({initialState:"RESUMED_VERIFIED",queuePaused:false});
  assert.equal(proc.status,0,proc.stderr);
  assert.match(calls,/queues pause-delivery/);
  assert.match(calls,/r2 object put/);
  assert.ok(currentPaused);
  assert.match(summary,/POSTCHECK_FAILED/);
});

test("FAULT INJECTION: completed release leaves Queue state untouched",()=>{
  const {proc,calls,summary}=runFakeCleanup({initialState:"VERIFIED_COMPLETED",queuePaused:false});
  assert.equal(proc.status,0,proc.stderr);
  assert.match(summary,/sentinels verified/);
  assert.doesNotMatch(calls,/queues (resume-delivery|pause-delivery)/);
});
