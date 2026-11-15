/** Local prototype only. It is not wired into any Worker or release gate.
 * One instance must wrap every D1 and queue binding used by an invocation.
 * An HTTP budget is separate; callers must reserve/count those requests too. */
export class InvocationBindingBudgetError extends Error {
 constructor(code:string){super(`INVOCATION_BINDING_BUDGET_${code}`);this.name='InvocationBindingBudgetError';}
}
type Kind='d1'|'queue';
type Limits={d1:number;queue:number};
export class InvocationBindingBudget {
 private used:Limits={d1:0,queue:0};private reserve:Limits={d1:0,queue:0};private token:object|null=null;private readonly raw=new WeakMap<object,D1PreparedStatement>();private readonly limits:Readonly<Limits>;
 constructor(limits:Limits){if(!limits||!['d1','queue'].every(k=>Number.isSafeInteger(limits[k as Kind])&&limits[k as Kind]>0))throw Error('INVOCATION_BINDING_BUDGET_INVALID');this.limits=Object.freeze({...limits});}
 snapshot(){return{used:{...this.used},reserved:{...this.reserve},limits:{...this.limits}};}
 reservePost(d1:number,queue:number):object|null{
  if(this.token||![d1,queue].every(n=>Number.isSafeInteger(n)&&n>=0)||d1+this.used.d1>this.limits.d1||queue+this.used.queue>this.limits.queue)return null;
  this.reserve={d1,queue};return this.token={};
 }
 releasePost(token:object):void{if(token!==this.token)throw new InvocationBindingBudgetError('INVALID_TOKEN');this.token=null;this.reserve={d1:0,queue:0};}
 consume(kind:Kind,token?:object):void{
  if(token!==undefined){if(token!==this.token||this.reserve[kind]<1)throw new InvocationBindingBudgetError('POST_EXHAUSTED');this.reserve[kind]--;this.used[kind]++;return;}
  if(this.used[kind]+this.reserve[kind]>=this.limits[kind])throw new InvocationBindingBudgetError('PRE_EXHAUSTED');this.used[kind]++;
 }
 /** Preserves D1 batch semantics: a batch is one invocation query, and its
  * wrapped prepared statements are unwrapped before crossing the binding. */
 wrapD1(db:D1Database,token?:object):D1Database{
  const raw=this.raw,budget=this;
  const statement=(source:D1PreparedStatement):D1PreparedStatement=>{
   const proxy=new Proxy(source,{get(target,key){
    if(key==='bind')return (...args:unknown[])=>statement(target.bind(...args));
    if(key==='first'||key==='all'||key==='run'||key==='raw')return (...args:unknown[])=>{budget.consume('d1',token);return (Reflect.get(target,key) as (...a:unknown[])=>unknown).apply(target,args);};
    const value=Reflect.get(target,key);return typeof value==='function'?()=>{throw new InvocationBindingBudgetError('UNSUPPORTED_STATEMENT_METHOD');}:value;
   }});raw.set(proxy,source);return proxy;
  };
  return new Proxy(db,{get(target,key){
   if(key==='prepare')return (sql:string)=>statement(target.prepare(sql));
   if(key==='batch')return (statements:D1PreparedStatement[])=>{budget.consume('d1',token);return target.batch(statements.map(s=>raw.get(s as object)??s));};
   // Other methods have different accounting or can produce an unwrapped
   // database/session. Never treat them as covered by this prototype.
   if(key==='exec'||key==='dump'||key==='withSession')return ()=>{throw new InvocationBindingBudgetError('UNSUPPORTED_D1_METHOD');};
   const value=Reflect.get(target,key);return typeof value==='function'?()=>{throw new InvocationBindingBudgetError('UNSUPPORTED_D1_METHOD');}:value;
  }});
 }
 wrapQueue<T>(queue:Queue<T>,token?:object):Queue<T>{const budget=this;return new Proxy(queue,{get(target,key){
  if(key==='send'||key==='sendBatch')return (...args:unknown[])=>{budget.consume('queue',token);return (Reflect.get(target,key) as (...a:unknown[])=>unknown).apply(target,args);};
  const value=Reflect.get(target,key);return typeof value==='function'?()=>{throw new InvocationBindingBudgetError('UNSUPPORTED_QUEUE_METHOD');}:value;
 }});}
}
