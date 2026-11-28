// Test-only local identity ledger. This is not cross-machine durability and is
// not a production gate. The caller must retain this private directory.
import {constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,fstatSync,statSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const hex=/^[0-9a-f]{64}$/,uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function localIdentityStore(directory,{onCreated=()=>{},syncFile=fsyncSync,syncDirectory=fsyncSync}={}){
 return {async claim(scope){
  if(!hex.test(scope)||typeof directory!=='string'||!directory.startsWith('/')||resolve(directory)!==directory||realpathSync(directory)!==directory)throw Error('LOCAL_IDENTITY_UNVERIFIED');
  const st=statSync(directory);if(!st.isDirectory()||(st.mode&0o077)!==0||typeof process.getuid==='function'&&st.uid!==process.getuid())throw Error('LOCAL_IDENTITY_UNVERIFIED');
  const filename=join(directory,'serial-round-identity.json'),flags=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW;
  let fd;try{fd=openSync(filename,flags,0o600);}catch(error){
   if(error?.code!=='EEXIST')throw Error('LOCAL_IDENTITY_UNVERIFIED');
   let input;try{const read=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=fstatSync(read);if(!info.isFile()||info.size>2048||info.nlink!==1||(info.mode&0o077)!==0||typeof process.getuid==='function'&&info.uid!==process.getuid())throw Error('invalid');input=JSON.parse(readFileSync(read,'utf8'));}finally{closeSync(read);}}catch{throw Error('LOCAL_IDENTITY_UNVERIFIED');}
   if(!input||Object.keys(input).sort().join(',')!=='roundId,schema,scope'||input.schema!=='MALIPANG_LOCAL_ROUND_IDENTITY_V1'||!uuid.test(input.roundId)||input.scope!==scope)throw Error('LOCAL_IDENTITY_UNVERIFIED');
   return {state:'EXISTING',roundId:input.roundId};
  }
  const record={schema:'MALIPANG_LOCAL_ROUND_IDENTITY_V1',roundId:randomUUID(),scope};
  try{onCreated();writeFileSync(fd,JSON.stringify(record)+'\n');syncFile(fd);}finally{closeSync(fd);}
  const dirfd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{syncDirectory(dirfd);}finally{closeSync(dirfd);}
  return {state:'FRESH',roundId:record.roundId};
 }};
}
