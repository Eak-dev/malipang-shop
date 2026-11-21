/** Local/read-only proof helper: callers must independently authenticate the
 * private baseline and each immutable receipt before trusting this result. */
/** Row metadata must be normalized to the original baseline extent by the
 * provider reader; grid rowCount is tracked separately and may grow. */
export type ReportStructure={sheetId:number;title:string;properties:Record<string,unknown>;mergedRanges:unknown[];protectedRanges:unknown[];conditionalFormats:unknown[];filterViews:unknown[];basicFilter:Record<string,unknown>|null;rowMetadata:unknown[];columnMetadata:unknown[]};
export type ReportGrid={rows:number;columns:number;formula:unknown[][];effective:unknown[][];notes:unknown[][];formats:unknown[][];validations:unknown[][];extras:unknown[][];structure:ReportStructure};
export type ReportReceipt={row:number;marker:string;formulaDigest:string;effectiveDigest:string;notesDigest:string;formatDigest:string;validationDigest:string;extrasDigest:string;spareFormulaDigest:string;spareEffectiveDigest:string;spareNotesDigest:string;spareFormatDigest:string;spareValidationDigest:string;spareExtrasDigest:string};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const validDigest=(s:string)=>/^[0-9a-f]{64}$/.test(s);
function canonical(v:unknown):unknown{if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object'){const r:Record<string,unknown>={};for(const key of Object.keys(v).sort()){const value=(v as Record<string,unknown>)[key];if(value!==undefined)r[key]=canonical(value);}return r;}throw Error('MONTHLY_STRUCTURE_INVALID');}
async function sha(value:unknown):Promise<string>{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))));return Array.from(new Uint8Array(d),v=>v.toString(16).padStart(2,'0')).join('');}
function cells(grid:unknown[][],row:number,width:number):unknown[]{return Array.from({length:width},(_,col)=>blank(grid[row]?.[col])?null:grid[row]?.[col]);}
function valid(g:ReportGrid):boolean{const s=g.structure;return Number.isSafeInteger(g.rows)&&g.rows>=4&&g.rows<=5000&&Number.isSafeInteger(g.columns)&&g.columns>=29&&g.columns<=100&&[g.formula,g.effective,g.notes,g.formats,g.validations,g.extras].every(x=>Array.isArray(x)&&x.length<=g.rows&&x.every(row=>Array.isArray(row)&&row.length<=g.columns))&&[g.formula,g.effective,g.notes].every(matrix=>matrix.every(row=>row.every(v=>v===null||v===undefined||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))))&&g.notes.every(row=>row.every(v=>blank(v)||typeof v==='string'))&&!!s&&Number.isSafeInteger(s.sheetId)&&s.sheetId>=0&&s.title==='รายวันต่อเนื่อง_แบบร่าง'&&!!s.properties&&typeof s.properties==='object'&&!Array.isArray(s.properties)&&[s.mergedRanges,s.protectedRanges,s.conditionalFormats,s.filterViews,s.rowMetadata,s.columnMetadata].every(Array.isArray)&&(s.basicFilter===null||!!s.basicFilter&&typeof s.basicFilter==='object'&&!Array.isArray(s.basicFilter));}
export async function reportBaselineDigest(g:ReportGrid):Promise<string>{
 if(!valid(g))throw Error('MONTHLY_BASELINE_INVALID');
 return sha([g.rows,g.columns,...[g.formula,g.effective,g.notes,g.formats,g.validations,g.extras].map(grid=>Array.from({length:g.rows},(_,i)=>cells(grid,i,g.columns))),g.structure]);
}
export async function reportRowDigests(g:ReportGrid,row:number):Promise<{formulaDigest:string;effectiveDigest:string;notesDigest:string;formatDigest:string;validationDigest:string;extrasDigest:string}>{
 if(!valid(g)||!Number.isSafeInteger(row)||row<4||row>g.rows)throw Error('MONTHLY_ROW_INVALID');
 return {formulaDigest:await sha(cells(g.formula,row-1,g.columns)),effectiveDigest:await sha(cells(g.effective,row-1,g.columns)),notesDigest:await sha(cells(g.notes,row-1,g.columns)),formatDigest:await sha(cells(g.formats,row-1,g.columns)),validationDigest:await sha(cells(g.validations,row-1,g.columns)),extrasDigest:await sha(cells(g.extras,row-1,g.columns))};
}
/** A new spare row may inherit provider formats, but may not contain any
 * value, formula, note, chip, rich text, pivot or data-source payload. */
export async function spareReportRowDigests(g:ReportGrid,row:number):Promise<Pick<ReportReceipt,'spareFormulaDigest'|'spareEffectiveDigest'|'spareNotesDigest'|'spareFormatDigest'|'spareValidationDigest'|'spareExtrasDigest'>|null>{
 if(!valid(g)||!Number.isSafeInteger(row)||row<4||row>g.rows)return null;
 for(let c=0;c<g.columns;c++){
  if(!blank(g.formula[row-1]?.[c])||!blank(g.effective[row-1]?.[c])||!blank(g.notes[row-1]?.[c]))return null;
  const extra=g.extras[row-1]?.[c];if(!blank(extra)&&(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.keys(extra).some(k=>k!=='effectiveFormat')))return null;
 }
 const x=await reportRowDigests(g,row);return {spareFormulaDigest:x.formulaDigest,spareEffectiveDigest:x.effectiveDigest,spareNotesDigest:x.notesDigest,spareFormatDigest:x.formatDigest,spareValidationDigest:x.validationDigest,spareExtrasDigest:x.extrasDigest};
}
/** Reconstruct the private pre-report base from the unchanged prefix. Its
 * digest is meaningful only when the caller has authenticated the run. */
export async function reconstructReportBaseline(current:ReportGrid,baseRows:number,expectedDigest:string):Promise<ReportGrid|null>{
 if(!valid(current)||!Number.isSafeInteger(baseRows)||baseRows<4||baseRows>current.rows||!validDigest(expectedDigest)||current.structure.rowMetadata.length!==baseRows)return null;
 const base:ReportGrid={...current,rows:baseRows,formula:current.formula.slice(0,baseRows),effective:current.effective.slice(0,baseRows),notes:current.notes.slice(0,baseRows),formats:current.formats.slice(0,baseRows),validations:current.validations.slice(0,baseRows),extras:current.extras.slice(0,baseRows)};
 return await reportBaselineDigest(base)===expectedDigest?base:null;
}
/** Verify exact baseline and appended receipts, without accepting unexplained
 * cells. Native rows must be added after the original grid, never inside it.
 * This is not source/incident/receipt authentication and has no write path. */
export async function verifyReportBaselineOverlay(base:ReportGrid,current:ReportGrid,expectedBaseline:string,receipts:readonly ReportReceipt[]):Promise<boolean>{
 if(!valid(base)||!valid(current)||!validDigest(expectedBaseline)||await reportBaselineDigest(base)!==expectedBaseline||current.rows!==base.rows+2*receipts.length||current.columns!==base.columns||await sha(base.structure)!==await sha(current.structure))return false;
 const byRow=new Map<number,ReportReceipt>(),spares=new Set<number>(),markers=new Set<string>();
 for(const [index,r] of receipts.entries()){
  if(r.row!==base.rows+1+2*index)return false;
  if(!Number.isSafeInteger(r.row)||r.row<=base.rows||r.row+1>current.rows||!/^MRP1_[0-9a-f]{32}$/.test(r.marker)||![r.formulaDigest,r.effectiveDigest,r.notesDigest,r.formatDigest,r.validationDigest,r.extrasDigest,r.spareFormulaDigest,r.spareEffectiveDigest,r.spareNotesDigest,r.spareFormatDigest,r.spareValidationDigest,r.spareExtrasDigest].every(validDigest)||byRow.has(r.row)||spares.has(r.row)||byRow.has(r.row+1)||spares.has(r.row+1)||markers.has(r.marker))return false;
  if(current.notes[r.row-1]?.[19]!==r.marker||!blank(current.formula[r.row-1]?.[19])||!blank(current.effective[r.row-1]?.[19]))return false;
  const digests=await reportRowDigests(current,r.row);if(digests.formulaDigest!==r.formulaDigest||digests.effectiveDigest!==r.effectiveDigest||digests.notesDigest!==r.notesDigest||digests.formatDigest!==r.formatDigest||digests.validationDigest!==r.validationDigest||digests.extrasDigest!==r.extrasDigest)return false;
  const spare=await spareReportRowDigests(current,r.row+1);if(!spare||Object.keys(spare).some(k=>spare[k as keyof typeof spare]!==r[k as keyof typeof spare]))return false;
  byRow.set(r.row,r);spares.add(r.row+1);markers.add(r.marker);
 }
 for(let row=0;row<current.rows;row++){
  if(byRow.has(row+1)||spares.has(row+1))continue;
  for(let col=0;col<current.columns;col++){
   const bf=row<base.rows?base.formula[row]?.[col]:null,be=row<base.rows?base.effective[row]?.[col]:null;
   const bn=row<base.rows?base.notes[row]?.[col]:null;
   if(!same(bf,current.formula[row]?.[col])||!same(be,current.effective[row]?.[col])||!same(bn,current.notes[row]?.[col]))return false;
   for(const key of ['formats','validations','extras'] as const){const previous=row<base.rows?base[key][row]?.[col]:null,next=current[key][row]?.[col];if(JSON.stringify(canonical(blank(previous)?null:previous))!==JSON.stringify(canonical(blank(next)?null:next)))return false;}
  }
 }
 return true;
}
