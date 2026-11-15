import {withTimeout} from '../shared/async';

// Large value-range responses are allowed, but never buffer an unlimited body.
const MAX_SHEETS_BODY_BYTES=16*1024*1024;
export async function readSheetsBody(response:Response,remainingMs:number,label:string):Promise<Uint8Array>{
 if(!response.body)return new Uint8Array();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,complete=false;
 const read=async()=>{
  while(true){const part=await reader.read();if(part.done){complete=true;break;}size+=part.value.byteLength;if(size>MAX_SHEETS_BODY_BYTES)throw Error('SHEETS_RESPONSE_TOO_LARGE');chunks.push(part.value);}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
 };
 try{return await withTimeout(read(),Math.max(1,Math.floor(remainingMs)),label);}
 finally{if(!complete)try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,0))]);}catch{}try{reader.releaseLock();}catch{}}
}
