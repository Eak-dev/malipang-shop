import type {Env} from '../types';
/** Separate per-sheet locks cannot coordinate if two configured names resolve
 * to the same tab. This is a conservative configuration check, not evidence
 * that people or older workers refrain from editing. */
export function sheetScopesDistinct(env:Env):boolean{
 const names=[env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'];
 if(names.some(v=>typeof v!=='string'||!v.trim()))return false;const canonical=names.map(v=>v.normalize('NFKC').trim().toLocaleLowerCase('en-US'));return new Set(canonical).size===canonical.length;
}
