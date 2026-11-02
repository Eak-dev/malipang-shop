export class OperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new OperationTimeoutError(label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Bound both bytes and wall-clock time after response headers have arrived.
 * Cancellation is best effort and is deliberately not awaited on timeout. */
export async function readBoundedJson(response:{body:ReadableStream<Uint8Array>|null},maxBytes:number,timeoutMs:number,label:string):Promise<unknown>{
  if(!response.body||!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error(`${label} unavailable`);
  const reader=response.body.getReader();
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  const read=async()=>{
    const parts:Uint8Array[]=[];let length=0;
    try{
      while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>maxBytes)throw new Error(`${label} too large`);parts.push(part.value);}
      const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
    }catch(error){cancel();throw error;}finally{reader.releaseLock();}
  };
  try{return await withTimeout(read(),timeoutMs,label);}catch(error){cancel();throw error;}
}
