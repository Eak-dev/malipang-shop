import {expenseSqlite,receipt,imageEvent} from './expense-sqlite.mjs';
import {getStaffActorByLineId} from '../../dist/access/repository.js';
import {normalizeOpenAIVisionResult} from '../../dist/vision/openai.js';
import {handleExpenseImage} from '../../dist/expense/service.js';
import {handleOnlineOrderReviewPostback,handleOnlineOrderReviewText} from '../../dist/expense/online-order-review-service.js';
import {loadOwnerReview,viewFromReviewRow} from '../../dist/expense/online-order-review-repository.js';

export function ownerOrderFixture(){
 const h=expenseSqlite(),now='2026-02-13T10:00:00.000Z',messages=[];
 const identities=[['TEST_OWNER','fixture_owner','OWNER'],['TEST_OWNER_TWO','fixture_owner_two','OWNER'],['TEST_STAFF','fixture_staff','EMPLOYEE'],['TEST_MANAGER','fixture_manager','BRANCH_MANAGER']];
 for(const [id,line,role] of identities){
  h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,can_submit_expense,status,updated_at) VALUES(?,?,?,'08:00','17:00',1,'ACTIVE',?)`).run(id,'Synthetic '+role,line,now);
  h.sqlite.prepare(`INSERT INTO staff_roles(role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,assigned_by,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,'fixture',?,?)`).run('role_'+id,id,role,role==='OWNER'?'ORGANIZATION':'BRANCH',role==='OWNER'?null:'B001',now,now,now);
  h.sqlite.prepare(`INSERT INTO line_identity_bindings(binding_id,provider,external_user_id,employee_id,status,verified_at,verified_by,reason,created_at,updated_at) VALUES(?,'LINE',?,?,'VERIFIED',?,'fixture','synthetic',?,?)`).run('binding_'+id,line,id,now,now,now);
 }
 let seq=0;
 h.env={...h.env,EXPENSE_ENABLED:'true',RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-token',EXTERNAL_API_TIMEOUT_MS:'1000',JOB_QUEUE:{async send(job){h.queue.push(job);},async sendBatch(jobs){h.queue.push(...jobs);}}};
 const event=(line='fixture_owner',extra={})=>({type:'message',timestamp:Date.parse(now),source:{type:'user',userId:line},replyToken:'synthetic_reply_'+(++seq),webhookEventId:'synthetic_event_'+seq,...extra});
 const actor=(line='fixture_owner')=>getStaffActorByLineId(h.env,line);
 const capture=async(run,{failReply=false}={})=>{
  const original=globalThis.fetch;
  try{globalThis.fetch=async(url,init)=>{if(!String(url).startsWith('https://api.line.me/'))throw new Error('Unexpected live API');messages.push(JSON.parse(String(init?.body||'{}')));return new Response(failReply?'synthetic unavailable':'',{status:failReply?503:200});};return await run();}
  finally{globalThis.fetch=original;}
 };
 async function receive(overrides={},options={}){
  const line=options.line||'fixture_owner',id=options.id||'synthetic_image_'+(++seq);
  const document=receipt({documentType:'ONLINE_ORDER',orderId:'SYNTHETIC_ORDER_'+id,documentNumber:'',documentDate:'2026-02-13',paymentDate:'',paymentTime:'',paymentDateFormat:'YMD',paymentDatePurpose:'ORDER_PLACED',paymentDateLabel:'',paymentStatus:'UNKNOWN',orderTotalBaht:519,orderTotalLabel:'รวมคำสั่งซื้อ',finalPaidAmountBaht:null,paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'',suggestedDescription:'Synthetic kitchen supplies',suggestedCategory:'equipment',subtotalBaht:519,shippingBaht:0,discountBaht:0,
   items:[{sellerKey:'Synthetic supplier',productCode:'SYNTHETIC_SKU',description:'Synthetic kitchen supplies',quantity:3,unit:'piece',unitPriceBaht:173,discountBaht:0,lineTotalBaht:519,vatBaht:0,confidence:.99,needsReview:false}],...overrides});
  const reading=normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',document},{});
  if(options.attempts)reading.purchaseEvidenceAttempts=options.attempts;
  await capture(async()=>handleExpenseImage(h.env,{...event(line),...imageEvent(id,line)},reading,'synthetic-private-image','synthetic_trace_'+id,'synthetic_hash_'+id,await actor(line)),options);
  const row=h.sqlite.prepare('SELECT * FROM expense_documents WHERE message_id=?').get(id);
  return{row,reading,document};
 }
 async function post(action,id,version,extra={},options={}){
  const line=options.line||'fixture_owner',q=new URLSearchParams({a:action,...(id?{id}:{}),...(version===undefined?{}:{v:String(version)}),...extra});
  return capture(()=>handleOnlineOrderReviewPostback(h.env,event(line,{type:'postback',postback:{data:q.toString(),...(options.date?{params:{date:options.date}}:{})}}),'synthetic_postback'),options);
 }
 async function text(value,options={}){const line=options.line||'fixture_owner';return capture(async()=>handleOnlineOrderReviewText(h.env,event(line,{message:{type:'text',id:'synthetic_text_'+(++seq),text:value}}),'synthetic_text',options.actor||await actor(line)),options);}
 const state=(id,line='fixture_owner')=>loadOwnerReview(h.env,id,{employeeId:line==='fixture_owner_two'?'TEST_OWNER_TWO':'TEST_OWNER',lineUserId:line});
 async function ready(id){
  let row=await state(id);await post('order_review_paid',id,Number(row.review_version),{paid:'yes'});
  row=await state(id);await post('order_review_date',id,Number(row.review_version),{},{date:'2026-02-14'});
  return state(id);
 }
 return{...h,messages,event,actor,capture,receive,post,text,state,ready,view:viewFromReviewRow};
}
