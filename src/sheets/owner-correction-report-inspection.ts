import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {batchGetSheetFormulaValues,getSheetValues} from "./client";
import {correctionReportDeduplicationSafe} from "./owner-correction-report-dedupe";
import {normalizeOwnerCorrectionFormula} from "./owner-correction-formula";

// Fingerprint of the verified current formula, with only extending daily
// range endpoints normalized. Other edits require a fresh assessment.
const knownFormulaSha256="afaf2261f5e34ea65ce876ef731e34c1b30555cf9dbd6be97c7ab91863102754";
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
  const original=formula[0][0]![0] as string,normalized=normalizeOwnerCorrectionFormula(original,3421);
  if(!normalized||normalized.endRow===null||original.includes(before.expenseId)||original.includes(after.expenseId)||JSON.stringify(first)!==JSON.stringify(second)||await ports.digest(normalized.normalized)!==knownFormulaSha256)return false;
  return correctionReportDeduplicationSafe(before,after,first[1]);
}
