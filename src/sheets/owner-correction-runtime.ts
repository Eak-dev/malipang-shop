import type {Env} from "../types";
import {inspectOwnerCorrectionTargets} from "./owner-correction-inspection";
import {patchOwnerCorrectionGoogle,rebindOwnerCorrectionGoogle} from "./owner-correction-google";
import {inspectOwnerCorrectionRebind} from "./owner-correction-rebind-inspection";
import {reconcileOwnerCorrection} from "./owner-correction-reconciliation";
import {processOwnerCorrectionJob,type OwnerCorrectionWorkerOutcome} from "./owner-correction-worker";
import type {OwnerCorrectionJob} from "./owner-correction-lease";

/** Use live reads and fenced Google writes; no adapter asserts reconciliation by assumption. */
export async function processOwnerCorrectionRuntime(env:Env,job:OwnerCorrectionJob):Promise<OwnerCorrectionWorkerOutcome>{
  return processOwnerCorrectionJob(env,job,{
    now:()=>Date.now(),
    inspect:plan=>inspectOwnerCorrectionTargets(env,plan),
    patch:(plan,beforeDispatch)=>patchOwnerCorrectionGoogle(env,plan,beforeDispatch),
    inspectRebind:plan=>inspectOwnerCorrectionRebind(env,plan),
    rebind:(plan,inspection,beforeDispatch)=>rebindOwnerCorrectionGoogle(env,plan,inspection,beforeDispatch),
    reconcile:(plan,selected)=>reconcileOwnerCorrection(env,plan,selected)
  });
}
