/** Expected row-relative formulas for a new daily entry. */
export function expectedHelperFormulae(header:number,row:number):Record<string,string>{
  const prior=row-1;
  return {
    I:`=SUM(F${row}:H${row})`,
    J:`=IFERROR(LOOKUP(2,ARRAYFORMULA(1/(($B$${header}:B${prior}=B${row})*ISNUMBER(J$${header}:J${prior}))),J$${header}:J${prior}),$E$${header})-I${row}`,
    R:`=SUM(K${row}:Q${row})`,S:`=J${row}-R${row}`,
    U:`=IF(AND(ISNUMBER(B${row}),ISNUMBER(C${row})),DATE($A$5,B${row},C${row}),"")`
  };
}

/** A sequential balance is accepted only when its predecessor is in the
 * same month and has a value; the caller checks the effective value too. */
export function isAcceptedHelperFormula(header:number,row:number,month:number,name:string,value:unknown,previous:readonly unknown[]):boolean{
  const generated=expectedHelperFormulae(header,row)[name];if(value===generated)return true;
  return name==='J'&&row>header&&value===`=J${row-1}-I${row}`&&Number(previous[1])===month&&previous[9]!==null&&previous[9]!==undefined&&previous[9]!=='';
}
