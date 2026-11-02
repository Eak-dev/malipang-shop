import type {Env} from "../types";
import {inspectOwnerCorrectionTargets} from "./owner-correction-inspection";
import {patchOwnerCorrectionGoogle,rebindOwnerCorrectionGoogle} from "./owner-correction-google";
import {inspectOwnerCorrectionRebind} from "./owner-correction-rebind-inspection";
import {reconcileOwnerCorrection} from "./owner-correction-reconciliation";
import {processOwnerCorrectionJob,type OwnerCorrectionWorkerOutcome} from "./owner-correction-worker";
import type {OwnerCorrectionJob} from "./owner-correction-lease";
import {withCorrectionDailyWriteFence} from "./owner-correction-daily-write-fence";

/** Use live reads and fenced Google writes; no adapter asserts reconciliation by assumption. */
export async function processOwnerCorrectionRuntime(env:Env,job:OwnerCorrectionJob):Promise<OwnerCorrectionWorkerOutcome>{
  return withCorrectionDailyWriteFence(env,env.SHEET_EXPENSE_DAILY,async write=>processOwnerCorrectionJob(env,job,{
    now:()=>Date.now(),
    inspect:plan=>inspectOwnerCorrectionTargets(env,plan),
    patch:(plan,beforeDispatch)=>write(fence=>patchOwnerCorrectionGoogle(env,plan,async()=>{await beforeDispatch();if(fence)await fence();})),
    inspectRebind:plan=>inspectOwnerCorrectionRebind(env,plan),
    rebind:(plan,inspection,beforeDispatch)=>write(fence=>rebindOwnerCorrectionGoogle(env,plan,inspection,async()=>{await beforeDispatch();if(fence)await fence();})),
    reconcile:(plan,selected)=>reconcileOwnerCorrection(env,plan,selected)
  }));
}
