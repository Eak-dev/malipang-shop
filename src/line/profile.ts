import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";
import type { Env } from "../types";

export interface LineUserProfile{
  displayName:string;
  pictureUrl:string;
}

function cleanText(value:unknown,max:number):string{return String(value??"").trim().slice(0,max);}

export async function getLineUserProfile(env:Env,userId:string):Promise<LineUserProfile>{
  if(!/^U[A-Za-z0-9]{20,64}$/.test(userId))throw new Error("LINE_PROFILE_USER_ID_INVALID");
  const response=await fetchWithTimeout(
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
    {method:"GET",headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`}},
    numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),
    "LINE profile"
  );
  if(!response.ok)throw new Error(`LINE_PROFILE_HTTP_${response.status}`);
  const data=await response.json() as{displayName?:unknown;pictureUrl?:unknown};
  const displayName=cleanText(data.displayName,80)||"LINE user";
  const rawPicture=cleanText(data.pictureUrl,500),pictureUrl=/^https:\/\//i.test(rawPicture)?rawPicture:"";
  return{displayName,pictureUrl};
}
