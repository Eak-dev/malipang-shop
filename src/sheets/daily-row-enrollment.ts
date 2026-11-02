/** Prototype-only enrollment approval verifier. It does not read Sheets, acquire
 * a fence, provision protections, create metadata, or perform any writes.
 * The public key and fresh SourceExpense records MUST come from independent,
 * authenticated trusted services, never an untrusted request. */
export interface EnrollmentEntry {
 expenseId:string; expenseVersion:number; postingDate:string; amountSatang:number; paymentKey:string;
 expenseStatus:'CONFIRMED'; sourceWallet:string; category:string; description:string; messageId:string;
 rowNumber:number; metadataId:number;
 literals:Readonly<Record<number,string|number|boolean>>;
 formulas:Readonly<Record<number,string>>;
 headerDigest:string;
}
export interface EnrollmentApproval {
 version:'daily-row-enrollment-v1'; approvalId:string; reviewerId:string;
 spreadsheetId:string; sheetId:number; leaseId:string; leaseVersion:number;
 issuedAtMs:number; expiresAtMs:number; entries:readonly EnrollmentEntry[];
}
export interface SourceExpense {expenseId:string;expenseVersion:number;postingDate:string;amountSatang:number;paymentKey:string;expenseStatus:string;sourceWallet:string;category:string;description:string;messageId:string}
export interface EnrollmentContext {
 spreadsheetId:string;sheetId:number;leaseId:string;leaseVersion:number;nowMs:number;approvedPeriod:string;
 /** Complete and fresh authoritative D1 records for exactly the approved IDs. */
 sourceExpenses:readonly SourceExpense[];
}
const formulaColumns=[8,9,17,18,20];
const literalColumns=Array.from({length:25},(_,i)=>i).filter(i=>!formulaColumns.includes(i));
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v;
const nat=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function validDate(s:string):boolean{
 const p=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(!p)return false;
 const y=Number(p[1]),m=Number(p[2]),d=Number(p[3]),t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()+1===m&&t.getUTCDate()===d;
}
/** Stable signed representation with no property-order or extra-field ambiguity. */
export function encodeEnrollmentApproval(a:EnrollmentApproval):Uint8Array{
 const entries=a.entries.map(e=>[e.expenseId,e.expenseVersion,e.postingDate,e.amountSatang,e.paymentKey,e.expenseStatus,e.sourceWallet,e.category,e.description,e.messageId,e.rowNumber,e.metadataId,e.headerDigest,literalColumns.map(i=>e.literals[i]),formulaColumns.map(i=>e.formulas[i])]);
 return new TextEncoder().encode(JSON.stringify([a.version,a.approvalId,a.reviewerId,a.spreadsheetId,a.sheetId,a.leaseId,a.leaseVersion,a.issuedAtMs,a.expiresAtMs,entries]));
}
/** Signature means only that the signer approved this exact data. It neither
 * establishes that the signer verified the mapping nor proves a live fence. */
export async function verifyEnrollmentApproval(a:EnrollmentApproval,signature:Uint8Array,approvalKey:CryptoKey,c:EnrollmentContext):Promise<boolean>{try{
 if(a.version!=='daily-row-enrollment-v1'||!id(a.approvalId)||!id(a.reviewerId)||!id(a.spreadsheetId)||!id(a.leaseId)||!nat(a.sheetId)||!nat(a.leaseVersion)||!nat(a.issuedAtMs)||!nat(a.expiresAtMs)||!nat(c.nowMs)||!/^\d{4}-\d{2}$/.test(c.approvedPeriod)||a.issuedAtMs>c.nowMs||a.expiresAtMs<=c.nowMs||a.expiresAtMs-a.issuedAtMs>900000||a.spreadsheetId!==c.spreadsheetId||a.sheetId!==c.sheetId||a.leaseId!==c.leaseId||a.leaseVersion!==c.leaseVersion||!Array.isArray(a.entries)||a.entries.length<1||a.entries.length>500||!Array.isArray(c.sourceExpenses)||c.sourceExpenses.length!==a.entries.length||signature.length!==64||approvalKey.type!=='public'||approvalKey.algorithm.name!=='Ed25519'||!approvalKey.usages.includes('verify'))return false;
 const seenIds=new Set<string>(),seenMessages=new Set<string>(),seenRows=new Set<number>(),seenMetadata=new Set<number>();
 for(const e of a.entries){
  if(!id(e.expenseId)||!nat(e.expenseVersion)||e.expenseVersion<1||!validDate(e.postingDate)||e.postingDate.slice(0,7)!==c.approvedPeriod||!nat(e.amountSatang)||e.amountSatang<1||!id(e.paymentKey)||e.expenseStatus!=='CONFIRMED'||!id(e.sourceWallet)||!id(e.category)||!id(e.description)||!id(e.messageId)||!nat(e.rowNumber)||e.rowNumber<6||!nat(e.metadataId)||e.metadataId<1||!/^([0-9a-f]{64})$/.test(e.headerDigest)||!e.literals||typeof e.literals!=='object'||Array.isArray(e.literals)||Object.keys(e.literals).length!==literalColumns.length||literalColumns.some(i=>!Object.hasOwn(e.literals,i)||!['string','number','boolean'].includes(typeof e.literals[i])||(typeof e.literals[i]==='number'&&!Number.isFinite(e.literals[i])))||!e.formulas||typeof e.formulas!=='object'||Array.isArray(e.formulas)||Object.keys(e.formulas).length!==formulaColumns.length||formulaColumns.some(i=>typeof e.formulas[i]!=='string'||!e.formulas[i]!.startsWith('='))||seenIds.has(e.expenseId)||seenMessages.has(e.messageId)||seenRows.has(e.rowNumber)||seenMetadata.has(e.metadataId))return false;
  seenIds.add(e.expenseId);seenMessages.add(e.messageId);seenRows.add(e.rowNumber);seenMetadata.add(e.metadataId);
  const source=c.sourceExpenses.filter(s=>s.expenseId===e.expenseId);if(source.length!==1)return false;const s=source[0]!;
  if(s.expenseVersion!==e.expenseVersion||s.postingDate!==e.postingDate||s.amountSatang!==e.amountSatang||s.paymentKey!==e.paymentKey||s.expenseStatus!==e.expenseStatus||s.sourceWallet!==e.sourceWallet||s.category!==e.category||s.description!==e.description||s.messageId!==e.messageId)return false;
 }
 return await crypto.subtle.verify('Ed25519',approvalKey,signature,encodeEnrollmentApproval(a));
 }catch{return false;}}
