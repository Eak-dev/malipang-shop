export function arrayBufferToBase64(data:ArrayBuffer):string{
  const input=new Uint8Array(data),chunkSize=0x8000;
  let binary="";
  for(let offset=0;offset<input.length;offset+=chunkSize){
    binary+=String.fromCharCode(...input.subarray(offset,Math.min(offset+chunkSize,input.length)));
  }
  return btoa(binary);
}
