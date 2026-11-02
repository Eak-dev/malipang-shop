/**
 * Google Sheets extends these verified daily ranges when rows are inserted.
 * Normalize only that endpoint, while refusing a shortened or inconsistent
 * range. Every other character, including report exceptions, stays hashed.
 */
export function normalizeOwnerCorrectionFormula(formula:string,minimumEndRow:number):{normalized:string;endRow:number|null}|null{
  if(typeof formula!=="string"||!Number.isSafeInteger(minimumEndRow)||minimumEndRow<5)return null;
  let bad=false;const ends=new Set<number>();
  const normalized=formula.replace(/('รายวัน'!\$?[A-Z]+\$?5:\$?[A-Z]+\$?)(\d+)/g,(_match,prefix:string,last:string)=>{
    const end=Number(last);if(!Number.isSafeInteger(end)||end<minimumEndRow)bad=true;ends.add(end);return `${prefix}<ROW_END>`;
  });
  if(bad||ends.size>1)return null;
  return {normalized,endRow:ends.size?[...ends][0]!:null};
}
