import type {ReportGrid,ReportStructure} from './monthly-report-baseline';

type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const array=(v:unknown):unknown[]=>v===undefined?[]:Array.isArray(v)?v:(()=>{throw Error('MONTHLY_GRID_INVALID');})();
function scalar(value:unknown,formula:boolean):unknown{
 if(value===undefined)return null;if(!object(value))throw Error('MONTHLY_GRID_INVALID');
 const keys=['stringValue','numberValue','boolValue','formulaValue','errorValue'].filter(k=>value[k]!==undefined);
 if(keys.length!==1||keys[0]==='errorValue'||!formula&&keys[0]==='formulaValue')throw Error('MONTHLY_GRID_CELL_UNVERIFIED');
 const x=value[keys[0]!]!;if(typeof x==='number'&&!Number.isFinite(x)||typeof x!=='string'&&typeof x!=='number'&&typeof x!=='boolean')throw Error('MONTHLY_GRID_CELL_UNVERIFIED');return x;
}

/** Normalize one field-masked Sheets response. This parser alone does not
 * prove completeness: the caller must independently compare formula and
 * effective values and validate metadata/geometry before and after reading. */
export function parseMonthlyReportGrid(payload:unknown,book:string,sheetId:number,baseRows:number):ReportGrid{
 if(!object(payload)||payload.commentsViewMode!=='COMMENTS_VIEW_MODE_INCLUDED'||payload.spreadsheetId!==book||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(baseRows)||baseRows<4||!Array.isArray(payload.sheets)||payload.sheets.length!==1||!object(payload.sheets[0]))throw Error('MONTHLY_GRID_INVALID');
 const sheet=payload.sheets[0],p=sheet.properties;if(!object(p)||p.sheetId!==sheetId||p.title!=='รายวันต่อเนื่อง_แบบร่าง'||!object(p.gridProperties))throw Error('MONTHLY_GRID_IDENTITY');
 const {rowCount,columnCount,...otherGrid}=p.gridProperties;if(!Number.isSafeInteger(rowCount)||Number(rowCount)<baseRows||Number(rowCount)>5000||!Number.isSafeInteger(columnCount)||Number(columnCount)<29||Number(columnCount)>100)throw Error('MONTHLY_GRID_DIMENSIONS');
 const rows=Number(rowCount),columns=Number(columnCount),data=array(sheet.data);if(data.length!==1||!object(data[0]))throw Error('MONTHLY_GRID_INVALID');
 const g=data[0];if(Number(g.startRow??0)!==0||Number(g.startColumn??0)!==0)throw Error('MONTHLY_GRID_INVALID');
 const rowData=array(g.rowData);if(rowData.length>rows)throw Error('MONTHLY_GRID_INVALID');
 const formula:unknown[][]=[],effective:unknown[][]=[],notes:unknown[][]=[],formats:unknown[][]=[],validations:unknown[][]=[],extras:unknown[][]=[];
 for(const [i,raw] of rowData.entries()){
  if(!object(raw))throw Error('MONTHLY_GRID_INVALID');const values=array(raw.values);if(values.length>columns)throw Error('MONTHLY_GRID_INVALID');
  for(const [j,cell] of values.entries()){
   if(!object(cell))throw Error('MONTHLY_GRID_INVALID');for(const matrix of [formula,effective,notes,formats,validations,extras])matrix[i]??=[];
   formula[i]![j]=scalar(cell.userEnteredValue,true);effective[i]![j]=scalar(cell.effectiveValue,false);
   if(cell.note!==undefined&&typeof cell.note!=='string'||cell.userEnteredFormat!==undefined&&!object(cell.userEnteredFormat)||cell.dataValidation!==undefined&&!object(cell.dataValidation))throw Error('MONTHLY_GRID_INVALID');
   notes[i]![j]=cell.note??null;formats[i]![j]=cell.userEnteredFormat??null;validations[i]![j]=cell.dataValidation??null;
   const rest:Obj={};for(const key of ['formattedValue','effectiveFormat','hyperlink','textFormatRuns','pivotTable','dataSourceTable','dataSourceFormula','chipRuns'])if(cell[key]!==undefined)rest[key]=cell[key];extras[i]![j]=Object.keys(rest).length?rest:null;
  }
 }
 const rowMeta=array(g.rowMetadata),colMeta=array(g.columnMetadata);if(rowMeta.length>rows||colMeta.length>columns)throw Error('MONTHLY_GRID_INVALID');
 const anchors=array(sheet.commentAnchors),anchorIds=new Set<string>();
 for(const anchor of anchors){
  if(!object(anchor)||typeof anchor.anchorId!=='string'||!anchor.anchorId||anchorIds.has(anchor.anchorId)||!object(anchor.range))throw Error('MONTHLY_GRID_ANCHOR_UNVERIFIED');
  anchorIds.add(anchor.anchorId);const range=anchor.range;
  if((range.sheetId??0)!==sheetId)throw Error('MONTHLY_GRID_ANCHOR_UNVERIFIED');
  for(const [start,end,limit] of [['startRowIndex','endRowIndex',rows],['startColumnIndex','endColumnIndex',columns]] as const){
   const a=range[start]??0,b=range[end]??limit;if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||Number(a)<0||Number(b)>limit||Number(a)>=Number(b))throw Error('MONTHLY_GRID_ANCHOR_UNVERIFIED');
  }
 }
 const {sheetId:_id,title:_title,gridProperties:_grid,...otherProperties}=p;
 const structure:ReportStructure={sheetId,title:'รายวันต่อเนื่อง_แบบร่าง',properties:{...otherProperties,gridProperties:otherGrid,spreadsheetProperties:payload.properties??null,namedRanges:array(payload.namedRanges),spreadsheetDeveloperMetadata:array(payload.developerMetadata),dataSources:array(payload.dataSources),dataSourceSchedules:array(payload.dataSourceSchedules),bandedRanges:array(sheet.bandedRanges),charts:array(sheet.charts),slicers:array(sheet.slicers),sheetDeveloperMetadata:array(sheet.developerMetadata),tables:array(sheet.tables),rowGroups:array(sheet.rowGroups),columnGroups:array(sheet.columnGroups),commentAnchors:anchors,commentAnchorEvidence:'COMMENTS_INCLUDED_V1'},mergedRanges:array(sheet.merges),protectedRanges:array(sheet.protectedRanges),conditionalFormats:array(sheet.conditionalFormats),filterViews:array(sheet.filterViews),basicFilter:sheet.basicFilter===undefined?null:object(sheet.basicFilter)?sheet.basicFilter:(()=>{throw Error('MONTHLY_GRID_INVALID');})(),rowMetadata:Array.from({length:baseRows},(_,i)=>rowMeta[i]??null),columnMetadata:Array.from({length:columns},(_,i)=>colMeta[i]??null)};
 return {rows,columns,formula,effective,notes,formats,validations,extras,structure};
}
