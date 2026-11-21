// Issue #248 G8: static source and config check. Pure local process, no provider calls.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateSteadyConfig(before, now) {
  if (!before || !now || !before.vars || !now.vars) throw Error("NO_GO_CONFIG_MISSING");
  if (before.vars.STABLE_RECOVERY_GATE_ENABLED !== undefined ||
      before.vars.STABLE_SHEETS_PACING_ENABLED !== undefined)
    throw Error("NO_GO_INVALID_REVIEWED_CONFIG");
  if (now.vars.STABLE_RECOVERY_GATE_ENABLED !== "false" ||
      now.vars.STABLE_SHEETS_PACING_ENABLED !== "true")
    throw Error("NO_GO_STEADY_FLAGS");
  if (Object.hasOwn(now.vars, "STABLE_SHEETS_READ_BUDGET_PER_MINUTE"))
    throw Error("NO_GO_UNAPPROVED_PACING_BUDGET");
  const cloned = structuredClone(now);
  delete cloned.vars.STABLE_RECOVERY_GATE_ENABLED;
  delete cloned.vars.STABLE_SHEETS_PACING_ENABLED;
  if (JSON.stringify(cloned) !== JSON.stringify(before))
    throw Error("NO_GO_UNRELATED_CONFIG_DRIFT");
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = process.env.CONFIG_BASELINE_SHA;
    if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("NO_GO_REVIEWED_SHA");
    const source = execFileSync("git", ["show", sha + ":wrangler.jsonc"], { encoding: "utf8" });
    validateSteadyConfig(JSON.parse(source), JSON.parse(readFileSync("wrangler.jsonc", "utf8")));
    console.log("PR247_G8_STEADY_CONFIG_VERIFIED");
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("NO_GO_")
      ? error.message : "NO_GO_CONFIG_NOT_VERIFIED");
    process.exitCode = 1;
  }
}
