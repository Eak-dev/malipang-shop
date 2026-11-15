import {decodePublicationCarrier,encodePublicationCarrier,publicationEmptyMarker,publicationStageRequest,publicationTransitionRequest,verifyPublicationColumn,type PublicationCarrier} from './continuous-publication-template';

/** This is an isolated executor, not a route. Each callback must be backed by
 * durable storage/provider operations and the caller must hold the exact
 * source version, workbook claim and live lease across the transition. */
export type PublicationColumn={formula:unknown[][];effective:unknown[][]};
export type PublicationIntent={sheetId:number;row:number;rows:number;before:string;after:PublicationCarrier};
export type PublicationExecutor={
 read:()=>Promise<PublicationColumn>;
 /** Recheck exact source fingerprint, claim, lease, target and (for publish)
  * independently read and verify all DAILY/RAW/DETAIL projections. */
 guard:(phase:'BEFORE'|'AFTER')=>Promise<boolean>;
 /** Atomically insert an IN_FLIGHT intent under the same guards. */
 persist:()=>Promise<boolean>;
 /** Dispatch exactly one compare-and-swap; unknown outcomes are retained. */
 dispatch:(request:unknown)=>Promise<unknown>;
 /** Atomically mark the matching intent VERIFIED and advance its marker. */
 commit:()=>Promise<boolean>;
 /** Release reservations after a POST has returned or its outcome is held. */
 release?:()=>void;
};

export function validPublicationBefore(column:PublicationColumn,intent:PublicationIntent):boolean{
 const before=decodePublicationCarrier(intent.before);
 if(before)return verifyPublicationColumn(column.formula,column.effective,intent.rows,before,intent.row);
 const match=/^PUB0_([1-9][0-9]*)_([0-9a-f]{32})$/.exec(intent.before);
 if(!match||Number(match[1])!==intent.row||intent.after.state!=='STAGED'||publicationEmptyMarker(intent.row,match[2]!)!==intent.before)return false;
 if(column.formula[intent.row-1]?.[0]!==intent.before||column.effective[intent.row-1]?.[0]!==intent.before)return false;
 // Replacing only the verified placeholder in memory also checks that the
 // prospective ID/nonce are absent and every other marker is well formed.
 const f=column.formula.map(row=>row.slice()),e=column.effective.map(row=>row.slice());
 f[intent.row-1]=[encodePublicationCarrier(intent.after)];e[intent.row-1]=[encodePublicationCarrier(intent.after)];
 return verifyPublicationColumn(f,e,intent.rows,intent.after,intent.row);
}
function request(intent:PublicationIntent):unknown{
 const before=decodePublicationCarrier(intent.before);
 return before?publicationTransitionRequest(intent.sheetId,intent.row,before,intent.after):publicationStageRequest(intent.sheetId,intent.row,intent.before,intent.after);
}

/** Never retry the POST after an uncertain outcome. A read failure or guard
 * failure leaves the intent in flight for explicit positive recovery. */
export async function executePublicationIntent(intent:PublicationIntent,io:PublicationExecutor):Promise<void>{
 const operation=request(intent);
 if(!validPublicationBefore(await io.read(),intent)||!await io.guard('BEFORE'))throw Error('PUBLICATION_PREFLIGHT_UNVERIFIED');
 try{
  if(!await io.persist())throw Error('PUBLICATION_INTENT_UNVERIFIED');
  if(!validPublicationBefore(await io.read(),intent)||!await io.guard('BEFORE'))throw Error('PUBLICATION_DISPATCH_UNVERIFIED');
  try{await io.dispatch(operation);}catch{throw Error('PUBLICATION_OUTCOME_UNKNOWN');}
 }finally{io.release?.();}
 await recoverPublicationIntent(intent,io);
}

/** Read-only on Sheets: only the complete exact positive postimage permits a
 * guarded durable commit. Absence, old value and errors never authorize POST. */
export async function recoverPublicationIntent(intent:PublicationIntent,io:Pick<PublicationExecutor,'read'|'guard'|'commit'>):Promise<void>{
 const after=await io.read();
 if(!verifyPublicationColumn(after.formula,after.effective,intent.rows,intent.after,intent.row)||!await io.guard('AFTER'))throw Error('PUBLICATION_POSTIMAGE_UNVERIFIED');
 if(!await io.commit())throw Error('PUBLICATION_COMMIT_UNCERTAIN');
}
