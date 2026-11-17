export type LedgerReportTitles={rawNew:string;detailNew:string;rawCombined:string;detailCombined:string};
export type LedgerReportBounds=LedgerReportTitles & {rawOldRows:number;rawNewRows:number;detailOldRows:number;detailNewRows:number};
export function combinedLedgerSpillFormulas(input:LedgerReportBounds):{raw:string;detail:string;rawRows:number;detailRows:number};
export function rewriteLedgerConsumerFormula(original:string,input:LedgerReportTitles):string;
