const groups:Record<string,number>={rent:0,staff:1,ingredients:2,fillings:3,packaging:4,utilities:5,gas:6,transport:7,equipment:8,marketing:9,general:10,bank_fee:10,cleaning:11};

/** The legacy report puts bank fees in its remainder instead of general. */
export function ownerCorrectionReportGroup(category:string,date:string):number|undefined{
  return date<"2026-08-01"&&category==="bank_fee"?11:groups[category];
}
