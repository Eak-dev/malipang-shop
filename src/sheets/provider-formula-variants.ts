/** The report manifest stores the hash of the originally requested formula.
 * Sheets may remove optional quotes around these exact ASCII sheet names.
 * Reconstruct only those bounded quote variants, never text inside literals.
 * A variant is useful only when its complete SHA-256 matches the manifest. */
const names=['V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL','V52_EXPENSE_RAW'] as const;

function quoteUnquotedReference(formula:string,name:string):string{
 const pattern=new RegExp(`(^|[=,(+*/^<> \\t:;\\-])(${name})!`,'g');
 let result='',outside='',inString=false,inSheet=false;
 const flush=()=>{result+=outside.replace(pattern,"$1'$2'!");outside='';};
 for(let i=0;i<formula.length;i++){
  const ch=formula[i]!;
  if(ch==="'"&&!inString){
   if(inSheet&&formula[i+1]==="'"){result+="''";i++;continue;}
   if(inSheet){inSheet=false;result+="'";}else{flush();inSheet=true;result+="'";}
   continue;
  }
  if(inSheet){result+=ch;continue;}
  if(ch==='"'){
   if(inString&&formula[i+1]==='"'){result+='""';i++;continue;}
   if(inString){inString=false;result+='"';}else{flush();inString=true;result+='"';}
  }else if(inString)result+=ch;
  else outside+=ch;
 }
 flush();return result;
}

export function knownProviderFormulaVariants(formula:string):string[]{
 let variants=[formula];
 for(const name of names)variants=variants.concat(variants.map(x=>quoteUnquotedReference(x,name)));
 return [...new Set(variants)];
}

export function knownProviderFormulaEquivalent(observed:unknown,expected:string):boolean{
 if(typeof observed!=='string')return false;
 const candidates=new Set(knownProviderFormulaVariants(expected));
 return knownProviderFormulaVariants(observed).some(x=>candidates.has(x));
}
