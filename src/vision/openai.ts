import { extractJsonObject } from "../shared/json";
import type { Env,VisionResult } from "../types";
import { fetchWithTimeout } from "../shared/async";
import { arrayBufferToBase64 } from "../shared/base64";
import { numberEnv } from "../shared/env";
import type { BankSlipDocument } from "../types";
function outputText(data:unknown):string{const d=data as{output_text?:string;output?:Array<{content?:Array<{text?:string}>}>};return typeof d.output_text==="string"?d.output_text:d.output?.flatMap(o=>o.content||[]).map(c=>c.text||"").join("")||"";}
export function buildOpenAIVisionPayload(model:string,image:ArrayBuffer):unknown{
  const bankSlipSchema={type:"object",properties:{
    documentType:{type:"string",enum:["BANK_SLIP"]},channel:{type:"string",enum:["BANK","G_WALLET"]},institution:{type:"string"},
    transactionType:{type:"string",enum:["TRANSFER","PAYMENT","WALLET_PAYMENT","TOPUP","UNKNOWN"]},transactionStatus:{type:"string",enum:["SUCCESS","FAILED","PENDING","UNKNOWN"]},
    printedYear:{type:"string"},paymentDate:{type:"string"},paymentTime:{type:"string"},referenceId:{type:"string"},sender:{type:"string"},senderAccountMasked:{type:"string"},recipient:{type:"string"},recipientAccountMasked:{type:"string"},merchant:{type:"string"},
    grossAmountBaht:{type:["number","null"]},discountAmountBaht:{type:["number","null"]},paidAmountBaht:{type:["number","null"]},currency:{type:"string"},
    suggestedDescription:{type:"string"},suggestedCategory:{type:"string",enum:["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]},
    confidence:{type:"number"},needsReview:{type:"boolean"},note:{type:"string"}
  },required:["documentType","channel","institution","transactionType","transactionStatus","printedYear","paymentDate","paymentTime","referenceId","sender","senderAccountMasked","recipient","recipientAccountMasked","merchant","grossAmountBaht","discountAmountBaht","paidAmountBaht","currency","suggestedDescription","suggestedCategory","confidence","needsReview","note"],additionalProperties:false};
  const schema={type:"object",properties:{kind:{type:"string",enum:["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"]},hour:{type:["integer","null"]},minute:{type:["integer","null"]},month:{type:["integer","null"]},day:{type:["integer","null"]},weekday:{type:["string","null"]},confidence:{type:"number"},clockFullyVisible:{type:["boolean","null"]},needsNewPhoto:{type:"boolean"},note:{type:"string"},document:{anyOf:[bankSlipSchema,{type:"null"}]}},required:["kind","hour","minute","month","day","weekday","confidence","clockFullyVisible","needsNewPhoto","note","document"],additionalProperties:false};
  const prompt=[
    "Inspect this MaliPang LINE image and return only the requested structured result.",
    "Classify it as CLOCK, RECEIPT, BANK_SLIP, ONLINE_ORDER, or UNKNOWN.",
    "BANK_SLIP includes a completed or attempted transfer, QR payment, bill payment, mobile-banking receipt, Paotang receipt, or G-Wallet payment screen. Bank logos, success/completed text, FROM/TO, amount, reference ID, or transaction ID are strong BANK_SLIP evidence.",
    "Never classify a banking, Paotang, or G-Wallet payment receipt as ONLINE_ORDER. ONLINE_ORDER is only a marketplace or order-summary screenshot such as Shopee or Lazada with products or an order number.",
    "For BANK_SLIP, populate document. For every other kind, return document=null.",
    "For BANK_SLIP, extract only visible values: institution, transaction type and status, date, time, reference ID, sender, recipient or merchant, masked account identifiers, and amounts.",
    "Copy the year exactly as printed into printedYear before normalizing it. Examples: 26, 2026, or 2569.",
    "Normalize paymentDate to YYYY-MM-DD. A visible two-digit year 00-79 means 2000-2079, so 26 means 2026. Convert a visible Buddhist Era year such as 2569 to Gregorian by subtracting 543. Normalize paymentTime to 24-hour HH:mm.",
    "For Thai-baht receipts always return currency=THB, even when the image prints Baht, บาท, or the baht symbol.",
    "Set transactionStatus=SUCCESS only when the image visibly says completed or successful. Do not infer success from layout alone.",
    "paidAmountBaht is the actual amount leaving the wallet or account. For subsidy receipts, keep grossAmountBaht and discountAmountBaht separately and set paidAmountBaht to the final amount actually paid. Example: price 40, subsidy 24, paid 16 means paidAmountBaht=16.",
    "Use channel=G_WALLET for Paotang or G-Wallet receipts; otherwise use BANK.",
    "When the recipient area shows both a shop or business display name and a legal account-holder name, put the shop display name in merchant and the account-holder name in recipient.",
    "For a visible merchant, suggestedDescription should be a short expense label using the merchant name. For a person-to-person transfer, use 'Transfer to <recipient>' and suggestedCategory=general because the purpose is not visible.",
    "Choose suggestedCategory only from the schema list. Mark needsReview=true when purpose, category, reference ID, date, paid amount, status, or counterparty is uncertain.",
    "The physical MaliPang shop wall clock is wide and black, has large white LED time digits, a Mon-Sun list on the left, and green temperature/month/day digits on the right.",
    "For CLOCK, read only visible pixels: large white center digits are hour/minute, green above M is month, and green above D is day.",
    "Locate the four large white seven-segment digits and read them from left to right before producing the answer.",
    "Treat curved, diagonal, or uneven glare and reflections as noise. A real LED segment is a straight bar aligned with the other segments in that digit.",
    "Double-check 5 versus 9: digit 5 has the upper-left vertical segment on and upper-right vertical segment off; digit 9 has both upper vertical segments on.",
    "Silently inspect the clock digits a second time. If the two readings disagree, return null for the unclear field and needsNewPhoto=true instead of guessing.",
    "Always return weekday=null. Weekday OCR is not trusted and is not used for attendance.",
    "A timestamp watermark or phone overlay is not evidence that the physical clock is present.",
    "Never infer missing fields from current time, LINE time, metadata, or context. Use null and needsNewPhoto=true when any required clock field is unclear.",
    "Set note to an empty string when the image is clear. Use note only for visible uncertainty or a specific problem that requires review."
  ].join("\n");
  return{model,store:false,max_output_tokens:650,text:{format:{type:"json_schema",name:"malipang_image_read",strict:true,schema}},input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:`data:image/jpeg;base64,${arrayBufferToBase64(image)}`,detail:"high"}]}]};
}
function normalizeBankSlipDocument(value:unknown):BankSlipDocument|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const obj=value as Record<string,unknown>,text=(v:unknown)=>String(v??"").trim(),numberOrNull=(v:unknown):number|null=>v==null||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  if(text(obj.documentType)!=="BANK_SLIP")return null;
  const channel=text(obj.channel)==="G_WALLET"?"G_WALLET":"BANK",transactionTypes=["TRANSFER","PAYMENT","WALLET_PAYMENT","TOPUP","UNKNOWN"] as const,statuses=["SUCCESS","FAILED","PENDING","UNKNOWN"] as const;
  const transactionType=transactionTypes.includes(text(obj.transactionType) as typeof transactionTypes[number])?text(obj.transactionType) as BankSlipDocument["transactionType"]:"UNKNOWN";
  const transactionStatus=statuses.includes(text(obj.transactionStatus) as typeof statuses[number])?text(obj.transactionStatus) as BankSlipDocument["transactionStatus"]:"UNKNOWN";
  const printedYear=text(obj.printedYear),yearDigits=printedYear.match(/\d{2,4}/)?.[0]||"",rawDate=text(obj.paymentDate),dateMatch=/^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);let paymentDate=rawDate;
  if(dateMatch&&yearDigits){const visible=Number(yearDigits),year=yearDigits.length===2?(visible<=79?2000+visible:1900+visible):visible>=2400?visible-543:visible;paymentDate=`${year.toString().padStart(4,"0")}-${dateMatch[2]}-${dateMatch[3]}`;}
  const rawCurrency=text(obj.currency).toUpperCase(),currency=["THB","BAHT","บาท","฿"].includes(rawCurrency)?"THB":rawCurrency||"THB";
  return{documentType:"BANK_SLIP",channel,institution:text(obj.institution),transactionType,transactionStatus,printedYear,paymentDate,paymentTime:text(obj.paymentTime),referenceId:text(obj.referenceId),sender:text(obj.sender),senderAccountMasked:text(obj.senderAccountMasked),recipient:text(obj.recipient),recipientAccountMasked:text(obj.recipientAccountMasked),merchant:text(obj.merchant),grossAmountBaht:numberOrNull(obj.grossAmountBaht),discountAmountBaht:numberOrNull(obj.discountAmountBaht),paidAmountBaht:numberOrNull(obj.paidAmountBaht),currency,suggestedDescription:text(obj.suggestedDescription),suggestedCategory:text(obj.suggestedCategory)||"general",confidence:Number(obj.confidence||0),needsReview:Boolean(obj.needsReview),note:text(obj.note)};
}
export function normalizeOpenAIVisionResult(obj:Record<string,unknown>,raw:unknown):VisionResult{
  const num=(v:unknown):number|null=>v==null?null:Number.isFinite(Number(v))?Number(v):null;
  const nullableText=(v:unknown):string|null=>{
    if(v==null)return null;
    const value=String(v).trim();
    return !value||["null","unknown","n/a"].includes(value.toLowerCase())?null:value;
  };
  const kinds=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"];
  const document=normalizeBankSlipDocument(obj.document),reportedKind=kinds.includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN",kind=document?"BANK_SLIP":reportedKind;
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:nullableText(obj.weekday),confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||"").trim(),provider:"openai",raw,document};
}
export async function readImageWithOpenAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  if(!env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY missing");
  const payload=buildOpenAIVisionPayload(env.OPENAI_MODEL,image);
  const res=await fetchWithTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify(payload)},numberEnv(env.VISION_TIMEOUT_MS,45000),"OpenAI vision");if(!res.ok)throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const raw=await res.json(),obj=extractJsonObject(outputText(raw))||{};
  return normalizeOpenAIVisionResult(obj,raw);
}
