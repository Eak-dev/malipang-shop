import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {batchGetSheetFormulaValues,getSheetValues} from "./client";
import {correctionReportDeduplicationSafe} from "./owner-correction-report-dedupe";

// Observed 97_EXPENSE_CLEAN!A2 in the private, 2026-11-01 report test copy.
// A formula edit requires a fresh assessment; the hash is not proof of report parity.
const knownFormulaSha256="9b7f6f3649c74be7f6f1f183ce1243faa753e55bfb60d1b8aeb74f037597d6a4";
interface Ports {
  formula:(env:Env,ranges:string[])=>Promise<unknown[][][]>;
  values:(env:Env,range:string)=>Promise<unknown[][]>;
  digest:(value:string)=>Promise<string>;
}
async function digest(value:string):Promise<string>{
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}
const defaults:Ports={formula:batchGetSheetFormulaValues,values:getSheetValues,digest};

/** Read-only preflight. Revalidate before use; it is not a Sheets write lock. */
export async function inspectOwnerCorrectionReportDeduplication(env:Env,before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,ports:Ports=defaults):Promise<boolean>{
  // The observed report formula reads this exact tab; don't assume a renamed tab is equivalent.
  if(env.SHEET_EXPENSE_RAW!=="V52_EXPENSE_RAW")return false;
  const read=async()=>Promise.all([ports.formula(env,["'97_EXPENSE_CLEAN'!A2"]),ports.values(env,"'V52_EXPENSE_RAW'!A:Q")]);
  const [first,second]=[await read(),await read()];
  const formula=first[0];
  if(formula.length!==1||formula[0]?.length!==1||formula[0]?.[0]?.length!==1||typeof formula[0][0]![0]!=="string")return false;
  if(JSON.stringify(first)!==JSON.stringify(second)||await ports.digest(formula[0][0]![0] as string)!==knownFormulaSha256)return false;
  return correctionReportDeduplicationSafe(before,after,first[1]);
}
