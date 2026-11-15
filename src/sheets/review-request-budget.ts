/** Explicit per-invocation request budget for reviewed expense recovery only.
 * Caller must account for other subrequests or run in a dedicated invocation. */
export class ReviewRequestBudgetError extends Error {
 constructor(readonly code:'EXHAUSTED'|'MUTATION_NOT_RESERVED'){super(`REVIEW_REQUEST_BUDGET_${code}`);this.name='ReviewRequestBudgetError';}
}
export class ReviewRequestBudget {
 private count=0; private slot=false; private claimed=false;
 constructor(readonly limit:number){if(!Number.isSafeInteger(limit)||limit<1||limit>40)throw Error('REVIEW_REQUEST_BUDGET_INVALID');}
 get used():number{return this.count;}
 get remaining():number{return this.limit-this.count-(this.slot?1:0);}
 get reserved():boolean{return this.slot;}
 reserveMutation():boolean{if(this.slot||this.claimed||this.remaining<1)return false;this.slot=true;return true;}
 releaseMutation():void{if(!this.claimed)this.slot=false;}
 consumeRead():void{if(this.remaining<1)throw new ReviewRequestBudgetError('EXHAUSTED');this.count++;}
 claimMutation():{consume:()=>void;release:()=>void}{
  if(!this.slot||this.claimed)throw new ReviewRequestBudgetError('MUTATION_NOT_RESERVED');
  this.claimed=true;let finished=false;
  return {consume:()=>{if(finished||!this.slot||!this.claimed)throw new ReviewRequestBudgetError('MUTATION_NOT_RESERVED');finished=true;this.slot=false;this.claimed=false;this.count++;},release:()=>{if(!finished){finished=true;this.slot=false;this.claimed=false;}}};
 }
}
