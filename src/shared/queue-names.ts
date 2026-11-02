import type {Env} from "../types";

// D1 is environment-local. Preserve the historic key expected by existing
// failed-job, notification and replay queries even if physical queues differ.
export const LOGICAL_JOB_QUEUE_NAME="malipang-jobs";
export const PRODUCTION_JOB_QUEUE_NAME="malipang-jobs";
export const PRODUCTION_DLQ_NAME="malipang-jobs-dlq";
export type QueueKind="JOB"|"DLQ";
export interface QueueNames{job:string;dlq:string}
const namePattern=/^[a-z0-9][a-z0-9-]{0,62}$/;

/** No partial/invalid config may route a queue message to the wrong consumer. */
export function resolveQueueNames(env:Pick<Env,"APP_ENV"|"JOB_QUEUE_NAME"|"JOB_DLQ_NAME">):QueueNames|null{
  if(typeof env.APP_ENV!=="string"||!/^[a-z][a-z0-9-]{0,31}$/.test(env.APP_ENV))return null;
  const job=env.JOB_QUEUE_NAME,dlq=env.JOB_DLQ_NAME;
  if(job===undefined&&dlq===undefined){
    // Preserve existing production; every other environment must explicitly
    // name its separate physical queues.
    if(env.APP_ENV!=="production")return null;
    return {job:PRODUCTION_JOB_QUEUE_NAME,dlq:PRODUCTION_DLQ_NAME};
  }
  if(typeof job!=="string"||typeof dlq!=="string"||!namePattern.test(job)||!namePattern.test(dlq)||job===dlq)return null;
  if(env.APP_ENV!=="production"&&[job,dlq].some(name=>name===PRODUCTION_JOB_QUEUE_NAME||name===PRODUCTION_DLQ_NAME))return null;
  return {job,dlq};
}

export function classifyQueue(env:Pick<Env,"APP_ENV"|"JOB_QUEUE_NAME"|"JOB_DLQ_NAME">,queue:string):QueueKind|null{
  const names=resolveQueueNames(env);return !names?null:queue===names.job?"JOB":queue===names.dlq?"DLQ":null;
}
