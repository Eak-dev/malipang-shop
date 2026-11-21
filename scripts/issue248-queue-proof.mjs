import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortObject(value[k])]));
  return value;
}
function snapshot(doc) {
  if (doc?.success!==true || !doc.result || typeof doc.result!=='object') throw Error('QUEUE_UNAVAILABLE');
  const q=doc.result, s=q.settings;
  if (!/^[a-f0-9]{32}$/.test(q.queue_id) || q.queue_name!=='malipang-jobs' || !s || typeof s!=='object' || Array.isArray(s) || !Number.isSafeInteger(s.message_retention_period) || s.message_retention_period<1 || !Array.isArray(q.consumers) || !Array.isArray(q.producers) || q.consumers.length<1 || q.consumers_total_count!==q.consumers.length || q.producers_total_count!==q.producers.length) throw Error('QUEUE_CONFIG_UNVERIFIED');
  const paused=own(s,'delivery_paused') ? s.delivery_paused : 'MISSING';
  if (paused!=='MISSING' && typeof paused!=='boolean') throw Error('QUEUE_PAUSED_UNCLASSIFIED');
  const {delivery_paused:_,...rest}=s;
  const consumers=q.consumers.map(c=>{if(!c || typeof c!=='object' || typeof c.consumer_id!=='string' || typeof c.type!=='string' || !own(c,'dead_letter_queue') || !c.settings || typeof c.settings!=='object') throw Error('CONSUMER_UNVERIFIED');return {consumer_id:c.consumer_id,type:c.type,script:c.script??null,script_name:c.script_name??null,dead_letter_queue:c.dead_letter_queue,settings:c.settings};});
  const producers=q.producers.map(p=>{if(!p || typeof p!=='object' || typeof p.type!=='string') throw Error('PRODUCER_UNVERIFIED');return p;});
  return {paused,config:sortObject({queue_id:q.queue_id,queue_name:q.queue_name,settings:rest,consumers,producers})};
}
export function pre(doc) {const a=snapshot(doc);if(a.paused!==false)throw Error('PRE_NOT_ACTIVE');return a;}
export function compare(before,after) {const a=pre(before), b=snapshot(after);if(JSON.stringify(a.config)!==JSON.stringify(b.config))throw Error('QUEUE_CONFIG_CHANGED');if(b.paused===true)throw Error('QUEUE_PAUSED_BY_UNKNOWN_ACTOR');return b.paused==='MISSING'?'PATCH_ONCE':'ACTIVE';}
export function verified(before,after){const a=pre(before),b=snapshot(after);if(JSON.stringify(a.config)!==JSON.stringify(b.config)||b.paused!==false)throw Error('QUEUE_READBACK_NOT_VERIFIED');return 'VERIFIED';}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {const [mode, beforePath,afterPath]=process.argv.slice(2);const before=JSON.parse(readFileSync(beforePath,'utf8'));const action=mode==='pre'?pre(before).config.queue_id:mode==='compare'?compare(before,JSON.parse(readFileSync(afterPath,'utf8'))):mode==='verify'?verified(before,JSON.parse(readFileSync(afterPath,'utf8'))):(()=>{throw Error('INVALID_MODE')})();process.stdout.write(`${action}\n`);}catch(e){process.stderr.write(`${e.message}\n`);process.exitCode=1;}
}
