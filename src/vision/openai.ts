import { extractJsonObject } from "../shared/json";
import type { Env,ExpenseDocumentItem,PurchaseDocument,VisionResult } from "../types";
import { fetchWithTimeout } from "../shared/async";
import { arrayBufferToBase64 } from "../shared/base64";
import { numberEnv } from "../shared/env";
import type { BankSlipDocument } from "../types";
import { parseAttendanceOverlay } from "../domain/attendance-overlay";
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
  const itemSchema={type:"object",properties:{sellerKey:{type:"string"},productCode:{type:"string"},description:{type:"string"},quantity:{type:["number","null"]},unit:{type:"string"},unitPriceBaht:{type:["number","null"]},discountBaht:{type:["number","null"]},lineTotalBaht:{type:["number","null"]},vatBaht:{type:["number","null"]},confidence:{type:"number"},needsReview:{type:"boolean"}},required:["sellerKey","productCode","description","quantity","unit","unitPriceBaht","discountBaht","lineTotalBaht","vatBaht","confidence","needsReview"],additionalProperties:false};
  const purchaseSchema={type:"object",properties:{documentType:{type:"string",enum:["RECEIPT","TAX_INVOICE","RECEIPT_TAX_INVOICE","ONLINE_ORDER","DELIVERY_ORDER"]},vendor:{type:"string"},legalVendorName:{type:"string"},documentNumber:{type:"string"},orderId:{type:"string"},documentDate:{type:"string"},paymentDate:{type:"string"},paymentTime:{type:"string"},currency:{type:"string"},subtotalBaht:{type:["number","null"]},shippingBaht:{type:["number","null"]},discountBaht:{type:["number","null"]},subsidyBaht:{type:["number","null"]},vatBaht:{type:["number","null"]},grossAmountBaht:{type:["number","null"]},finalPaidAmountBaht:{type:["number","null"]},paymentMethod:{type:"string"},sourceWalletCandidate:{type:"string"},suggestedDescription:{type:"string"},suggestedCategory:{type:"string",enum:["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]},confidence:{type:"number"},needsReview:{type:"boolean"},reviewReasons:{type:"array",items:{type:"string"}},items:{type:"array",items:itemSchema}},required:["documentType","vendor","legalVendorName","documentNumber","orderId","documentDate","paymentDate","paymentTime","currency","subtotalBaht","shippingBaht","discountBaht","subsidyBaht","vatBaht","grossAmountBaht","finalPaidAmountBaht","paymentMethod","sourceWalletCandidate","suggestedDescription","suggestedCategory","confidence","needsReview","reviewReasons","items"],additionalProperties:false};
  const schema={type:"object",properties:{kind:{type:"string",enum:["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","DELIVERY_ORDER","UNKNOWN"]},hour:{type:["integer","null"]},minute:{type:["integer","null"]},month:{type:["integer","null"]},day:{type:["integer","null"]},weekday:{type:["string","null"]},confidence:{type:"number"},clockFullyVisible:{type:["boolean","null"]},clockPresent:{type:["boolean","null"]},clockConfidence:{type:"number"},overlayPresent:{type:"boolean"},overlayTextWhite:{type:"boolean"},photoDate:{type:["string","null"]},photoTime:{type:["string","null"]},latitude:{type:["number","null"]},longitude:{type:["number","null"]},locationText:{type:"string"},overlayRawText:{type:"string"},overlayConfidence:{type:"number"},needsNewPhoto:{type:"boolean"},note:{type:"string"},document:{anyOf:[bankSlipSchema,purchaseSchema,{type:"null"}]}},required:["kind","hour","minute","month","day","weekday","confidence","clockFullyVisible","clockPresent","clockConfidence","overlayPresent","overlayTextWhite","photoDate","photoTime","latitude","longitude","locationText","overlayRawText","overlayConfidence","needsNewPhoto","note","document"],additionalProperties:false};
  const prompt=[
    "Inspect this MaliPang LINE image and return only the requested structured result.",
    "Classify it as CLOCK, RECEIPT, BANK_SLIP, ONLINE_ORDER, or UNKNOWN.",
    "BANK_SLIP includes a completed or attempted transfer, QR payment, bill payment, mobile-banking receipt, Paotang receipt, or G-Wallet payment screen. Bank logos, success/completed text, FROM/TO, amount, reference ID, or transaction ID are strong BANK_SLIP evidence.",
    "Never classify a banking, Paotang, or G-Wallet payment receipt as ONLINE_ORDER. ONLINE_ORDER is only a marketplace or order-summary screenshot such as Shopee or Lazada with products or an order number.",
    "For BANK_SLIP, RECEIPT, ONLINE_ORDER, or DELIVERY_ORDER, populate document. For every other kind, return document=null.",
    "For receipts, tax invoices and online orders, copy only visible facts. This must work for an unseen vendor and any layout: wrapped names, Thai or English units, non-grid rows, and columns that are visually separated. Extract every visible line item up to 40 rows; retain the product description even when it wraps across lines, and never use the vendor name as an item description. Do not truncate a long receipt. finalPaidAmountBaht is the final cash outflow after shipping, discounts, vouchers and subsidies. Do not use expected delivery as paymentDate. DELIVERY_ORDER is supporting evidence and needsReview=true unless visible payment evidence is present.",
    "For each purchase item, populate description from the printed product/service text. If that text is unclear, leave description empty and set needsReview=true; do not invent it from the vendor, category, totals, or a product code. Copy visible quantity, unit, unit price, discount and line total independently. A document-level discount, subsidy, shipping or tax adjustment is not a line-item allocation.",
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
    "For a CLOCK attendance photo, inspect the entire image including every corner for a camera overlay printed in white text. Its position may vary.",
    "The authoritative attendance data is the white overlay's date, time, latitude, longitude, and location text. The physical clock digits are never the attendance time.",
    "Set overlayTextWhite=true only when the timestamp/location/GPS text itself is visibly white. White LED digits inside the physical clock do not count as the overlay.",
    "Normalize the overlay date to Gregorian YYYY-MM-DD. Convert Buddhist Era years by subtracting 543 and expand a visible year 26 to 2026. Normalize the overlay time to 24-hour HH:mm:ss when seconds are visible, otherwise HH:mm.",
    "Extract signed decimal GPS coordinates from the visible overlay. Convert forms such as 13.8968095N 100.6083093E to positive decimal latitude and longitude. Do not geocode an address or invent coordinates.",
    "Copy every visible white-overlay timestamp and location line into overlayRawText. Copy the human-readable address or place name into locationText; this field is required for attendance and must not come from geocoding.",
    "The physical MaliPang clock is supporting shop evidence only. Set clockPresent and clockConfidence from its distinctive appearance; do not use or copy its displayed time/date into photoDate or photoTime.",
    "For CLOCK return hour, minute, month, day, and weekday as null because wall-clock digits are diagnostic only and are not used for attendance.",
    "A timestamp watermark or phone overlay is not by itself evidence that the physical clock is present; validate overlay and clock evidence independently.",
    "Never infer missing fields from current time, LINE time, metadata, address geocoding, or context. Use null/false and needsNewPhoto=true when required overlay or clock evidence is unclear.",
    "Set note to an empty string when the image is clear. Use note only for visible uncertainty or a specific problem that requires review."
  ].join("\n");
  return{model,store:false,max_output_tokens:4200,text:{format:{type:"json_schema",name:"malipang_image_read",strict:true,schema}},input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:`data:image/jpeg;base64,${arrayBufferToBase64(image)}`,detail:"high"}]}]};
}
function normalizeBankSlipDocument(value:unknown):BankSlipDocument|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const obj=value as Record<string,unknown>,text=(v:unknown)=>String(v??"").trim(),numberOrNull=(v:unknown):number|null=>v==null||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  if(text(obj.documentType)!=="BANK_SLIP")return null;
  const channel=text(obj.channel)==="G_WALLET"?"G_WALLET":"BANK",rawInstitution=text(obj.institution),institution=channel==="G_WALLET"&&!/(?:paotang|g[- ]?wallet|เป๋าตัง)/i.test(rawInstitution)?`G-Wallet${rawInstitution?` (${rawInstitution})`:""}`:rawInstitution,transactionTypes=["TRANSFER","PAYMENT","WALLET_PAYMENT","TOPUP","UNKNOWN"] as const,statuses=["SUCCESS","FAILED","PENDING","UNKNOWN"] as const;
  const transactionType=transactionTypes.includes(text(obj.transactionType) as typeof transactionTypes[number])?text(obj.transactionType) as BankSlipDocument["transactionType"]:"UNKNOWN";
  const transactionStatus=statuses.includes(text(obj.transactionStatus) as typeof statuses[number])?text(obj.transactionStatus) as BankSlipDocument["transactionStatus"]:"UNKNOWN";
  const printedYear=text(obj.printedYear),yearDigits=printedYear.match(/\d{2,4}/)?.[0]||"",rawDate=text(obj.paymentDate),dateMatch=/^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);let paymentDate=rawDate;
  if(dateMatch&&yearDigits){const visible=Number(yearDigits),year=yearDigits.length===2?(visible<=79?2000+visible:1900+visible):visible>=2400?visible-543:visible;paymentDate=`${year.toString().padStart(4,"0")}-${dateMatch[2]}-${dateMatch[3]}`;}
  const rawCurrency=text(obj.currency).toUpperCase(),currency=["THB","BAHT","บาท","฿"].includes(rawCurrency)?"THB":rawCurrency||"THB";
  return{documentType:"BANK_SLIP",channel,institution,transactionType,transactionStatus,printedYear,paymentDate,paymentTime:text(obj.paymentTime),referenceId:text(obj.referenceId),sender:text(obj.sender),senderAccountMasked:text(obj.senderAccountMasked),recipient:text(obj.recipient),recipientAccountMasked:text(obj.recipientAccountMasked),merchant:text(obj.merchant),grossAmountBaht:numberOrNull(obj.grossAmountBaht),discountAmountBaht:numberOrNull(obj.discountAmountBaht),paidAmountBaht:numberOrNull(obj.paidAmountBaht),currency,suggestedDescription:text(obj.suggestedDescription),suggestedCategory:text(obj.suggestedCategory)||"general",confidence:Number(obj.confidence||0),needsReview:Boolean(obj.needsReview),note:text(obj.note)};
}
function normalizePurchaseDocument(value:unknown):PurchaseDocument|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const obj=value as Record<string,unknown>,text=(v:unknown)=>String(v??"").trim(),money=(v:unknown):number|null=>v==null||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  const types=["RECEIPT","TAX_INVOICE","RECEIPT_TAX_INVOICE","ONLINE_ORDER","DELIVERY_ORDER"] as const,type=text(obj.documentType);
  if(!types.includes(type as typeof types[number]))return null;
  const category=text(obj.suggestedCategory)||"general",items=Array.isArray(obj.items)?obj.items.map(item=>{
    const row=item&&typeof item==="object"?item as Record<string,unknown>:{};
    // The fallback is deliberately generic: visible item text wins, then a
    // visible document-level description, then a printed product code.  A
    // vendor is never substituted for a product description.
    const productCode=text(row.productCode),visibleDescription=text(row.description),description=visibleDescription||text(obj.suggestedDescription)||productCode;
    return{sellerKey:text(row.sellerKey),productCode,description,quantity:money(row.quantity),unit:text(row.unit),unitPriceBaht:money(row.unitPriceBaht),discountBaht:money(row.discountBaht),lineTotalBaht:money(row.lineTotalBaht),vatBaht:money(row.vatBaht),confidence:Number(row.confidence||0),needsReview:Boolean(row.needsReview)||!visibleDescription} satisfies ExpenseDocumentItem;
  }).filter(item=>item.description):[];
  return{documentType:type as PurchaseDocument["documentType"],vendor:text(obj.vendor),legalVendorName:text(obj.legalVendorName),documentNumber:text(obj.documentNumber),orderId:text(obj.orderId),documentDate:text(obj.documentDate),paymentDate:text(obj.paymentDate),paymentTime:text(obj.paymentTime),currency:text(obj.currency).toUpperCase()||"THB",subtotalBaht:money(obj.subtotalBaht),shippingBaht:money(obj.shippingBaht),discountBaht:money(obj.discountBaht),subsidyBaht:money(obj.subsidyBaht),vatBaht:money(obj.vatBaht),grossAmountBaht:money(obj.grossAmountBaht),finalPaidAmountBaht:money(obj.finalPaidAmountBaht),paymentMethod:text(obj.paymentMethod),sourceWalletCandidate:text(obj.sourceWalletCandidate),suggestedDescription:text(obj.suggestedDescription),suggestedCategory:category,confidence:Number(obj.confidence||0),needsReview:Boolean(obj.needsReview),reviewReasons:Array.isArray(obj.reviewReasons)?obj.reviewReasons.map(text).filter(Boolean):[],items};
}
export function normalizeOpenAIVisionResult(obj:Record<string,unknown>,raw:unknown):VisionResult{
  const num=(v:unknown):number|null=>v==null?null:Number.isFinite(Number(v))?Number(v):null;
  const nullableText=(v:unknown):string|null=>{
    if(v==null)return null;
    const value=String(v).trim();
    return !value||["null","unknown","n/a"].includes(value.toLowerCase())?null:value;
  };
  const kinds=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","DELIVERY_ORDER","UNKNOWN"];
  const document=normalizeBankSlipDocument(obj.document)||normalizePurchaseDocument(obj.document),reportedKind=kinds.includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN",kind=document?.documentType==="BANK_SLIP"?"BANK_SLIP":document?.documentType==="DELIVERY_ORDER"?"DELIVERY_ORDER":document?.documentType==="ONLINE_ORDER"?"ONLINE_ORDER":document?"RECEIPT":reportedKind;
  const overlayRawText=String(obj.overlayRawText||"").trim(),parsedOverlay=parseAttendanceOverlay(overlayRawText),photoDate=nullableText(obj.photoDate)||parsedOverlay.photoDate,photoTime=nullableText(obj.photoTime)||parsedOverlay.photoTime,latitude=num(obj.latitude)??parsedOverlay.latitude,longitude=num(obj.longitude)??parsedOverlay.longitude;
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:nullableText(obj.weekday),confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,clockPresent:typeof obj.clockPresent==="boolean"?obj.clockPresent:null,clockConfidence:Number(obj.clockConfidence||0),overlayPresent:Boolean(obj.overlayPresent),overlayTextWhite:Boolean(obj.overlayTextWhite),photoDate,photoTime,latitude,longitude,locationText:String(obj.locationText||"").trim(),overlayRawText,overlayConfidence:Number(obj.overlayConfidence||0),needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||"").trim(),provider:"openai",raw,document};
}
export async function readImageWithOpenAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  if(!env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY missing");
  const payload=buildOpenAIVisionPayload(env.OPENAI_MODEL,image);
  const res=await fetchWithTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify(payload)},numberEnv(env.VISION_TIMEOUT_MS,45000),"OpenAI vision");if(!res.ok)throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const raw=await res.json(),obj=extractJsonObject(outputText(raw))||{};
  return normalizeOpenAIVisionResult(obj,raw);
}
