import type {OwnerCorrectionDraft} from "./owner-correction";

export type CorrectionGuardReason="OWNER_UNVERIFIED"|"SNAPSHOT_STALE"|"PERIOD_UNKNOWN_OR_CLOSED"|"RECEIPT_ALLOCATION_REVIEW"|"ROW_IDENTITY_UNVERIFIED"|"PROJECTION_TARGET_UNVERIFIED"|"REPORT_DEDUPLICATION_UNVERIFIED"|"SYNC_IN_PROGRESS";
export interface CorrectionGuardEvidence{
  ownerVerified:boolean;snapshotCurrent:boolean;
  sourcePeriod:"OPEN"|"CLOSED"|"UNKNOWN";destinationPeriod:"OPEN"|"CLOSED"|"UNKNOWN";
  itemCount:number;receiptAllocationVerified:boolean;rowIdentityVerified:boolean;projectionTargetsVerified:boolean;reportDeduplicationVerified:boolean;syncInProgress:boolean;
}
/** Unknown evidence stops the financial mutation, rather than guessing. */
export function assessOwnerCorrection(draft:OwnerCorrectionDraft,evidence:CorrectionGuardEvidence):CorrectionGuardReason[]{
  const reasons:CorrectionGuardReason[]=[];
  if(!evidence.ownerVerified)reasons.push("OWNER_UNVERIFIED");
  if(!evidence.snapshotCurrent)reasons.push("SNAPSHOT_STALE");
  if(evidence.syncInProgress)reasons.push("SYNC_IN_PROGRESS");
  if(draft.before.status==="CONFIRMED"){
    if(evidence.sourcePeriod!=="OPEN"||evidence.destinationPeriod!=="OPEN")reasons.push("PERIOD_UNKNOWN_OR_CLOSED");
    if(!evidence.rowIdentityVerified)reasons.push("ROW_IDENTITY_UNVERIFIED");
    if(!evidence.projectionTargetsVerified)reasons.push("PROJECTION_TARGET_UNVERIFIED");
    if(evidence.reportDeduplicationVerified!==true)reasons.push("REPORT_DEDUPLICATION_UNVERIFIED");
    if((draft.field==="amountSatang"||draft.field==="category")&&(!Number.isSafeInteger(evidence.itemCount)||evidence.itemCount<0||(evidence.itemCount>1&&!evidence.receiptAllocationVerified)))reasons.push("RECEIPT_ALLOCATION_REVIEW");
  }
  return reasons;
}
