import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parseMonthlyReportGrid}=require('../dist/sheets/monthly-report-grid.js'),{reportBaselineDigest}=require('../dist/sheets/monthly-report-baseline.js');
const client=require('../dist/sheets/client.js'),auth=require('../dist/sheets/google-auth.js');
function payload(rows=5){return {spreadsheetId:'book',sheets:[{properties:{sheetId:7,title:'รายวันต่อเนื่อง_แบบร่าง',gridProperties:{rowCount:rows,columnCount:29,frozenRowCount:3}},data:[{rowData:[{values:[{userEnteredValue:{stringValue:'=literal'},effectiveValue:{stringValue:'=literal'},note:'test note',userEnteredFormat:{textFormat:{bold:true}}}]}]}]}]};}
test('normalizes typed grid fields and retains original row metadata extent',async()=>{
 const base=parseMonthlyReportGrid(payload(),'book',7,5),expanded=parseMonthlyReportGrid(payload(7),'book',7,5);assert.equal(base.formula[0][0],'=literal');assert.equal(base.effective[0][0],'=literal');assert.equal(base.notes[0][0],'test note');assert.equal(base.structure.rowMetadata.length,5);assert.deepEqual(base.structure,expanded.structure);assert.equal((await reportBaselineDigest(base)).length,64);
});
test('rejects wrong workbook, missing grid, unexpected range and error values',()=>{
 for(const mode of ['book','sheet','grid','range','error']){const p=payload();if(mode==='book')p.spreadsheetId='other';if(mode==='sheet')p.sheets[0].properties.sheetId=8;if(mode==='grid')delete p.sheets[0].data;if(mode==='range')p.sheets[0].data[0].startRow=1;if(mode==='error')p.sheets[0].data[0].rowData[0].values[0].effectiveValue={errorValue:{type:'ERROR'}};assert.throws(()=>parseMonthlyReportGrid(p,'book',7,5),/MONTHLY_GRID/);}
});
test('provider sparse blank rows and note-only cells normalize without losing content',async()=>{
 const p=payload();p.sheets[0].data[0].rowData=[{}, {}, {values:[{}, {userEnteredValue:{formulaValue:'=""'}}, {note:'synthetic note'}, {userEnteredFormat:{numberFormat:{type:'NUMBER'}}}]}];
 const g=parseMonthlyReportGrid(p,'book',7,5);assert.equal(g.formula[2][1],'=""');assert.equal(g.effective[2][1],null);assert.equal(g.notes[2][2],'synthetic note');assert.equal(g.formats[2][3].numberFormat.type,'NUMBER');assert.equal((await reportBaselineDigest(g)).length,64);
});
test('provider reader independently crosschecks values and sheet dimensions',async()=>{for(const mode of ['ok','partial-grid','missing-range','grid-drift']){
 const oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken;let metadataReads=0;
 try{auth.getGoogleAccessToken=async()=> 'synthetic-token';globalThis.fetch=async(url)=>{const u=new URL(url),fields=u.searchParams.get('fields')??'';let body;
  if(u.pathname.includes('/values:batchGet')){const formula=u.searchParams.get('valueRenderOption')==='FORMULA';body=mode==='missing-range'&&formula?{valueRanges:[]}:{valueRanges:[{values:[['=literal']]}]};}
  else if(u.searchParams.get('includeGridData')==='true'){body=payload();if(mode==='partial-grid')body.sheets[0].data[0].rowData=[];}
  else if(fields.includes('gridProperties')){metadataReads++;body={sheets:[{properties:{sheetId:7,title:'รายวันต่อเนื่อง_แบบร่าง',gridProperties:{rowCount:mode==='grid-drift'&&metadataReads>1?6:5,columnCount:29}}}]};}
  else throw Error('unexpected synthetic request');return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 };
 const env={DB:{},GOOGLE_SPREADSHEET_ID:'book',STABLE_SHEETS_PACING_ENABLED:'true'},run=()=>client.readMonthlyReportGrid(env,7,5,{kind:'continuous-expense'});
 if(mode==='ok'){const g=await run();assert.equal(g.formula[0][0],'=literal');}else await assert.rejects(run(),/MONTHLY_GRID_/);
 }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;}
 }});

test('PREVIEW-only diagnostics identify the exact failed grid GET without serializing provider details',async()=>{
 const modes=['GRID_METADATA_INITIAL','GRID_FULL_INITIAL','GRID_VALUES_FORMULA','GRID_VALUES_EFFECTIVE','GRID_FULL_REPEAT','GRID_METADATA_FINAL'];
 for(const mode of modes){const oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken;let metadataReads=0,fullReads=0;
  try{
   auth.getGoogleAccessToken=async()=> 'synthetic-token';
   globalThis.fetch=async(url)=>{const u=new URL(url),fields=u.searchParams.get('fields')??'';let operation,body;
    if(u.pathname.includes('/values:batchGet')){const formula=u.searchParams.get('valueRenderOption')==='FORMULA';operation=formula?'GRID_VALUES_FORMULA':'GRID_VALUES_EFFECTIVE';body={valueRanges:[{values:[['=literal']]}]};}
    else if(u.searchParams.get('includeGridData')==='true'){operation=++fullReads===1?'GRID_FULL_INITIAL':'GRID_FULL_REPEAT';body=payload();}
    else if(fields.includes('gridProperties')){operation=++metadataReads===1?'GRID_METADATA_INITIAL':'GRID_METADATA_FINAL';body={sheets:[{properties:{sheetId:7,title:'รายวันต่อเนื่อง_แบบร่าง',gridProperties:{rowCount:5,columnCount:29}}}]};}
    else throw Error('unexpected synthetic request');
    if(operation===mode)return Response.json({error:{message:'private provider body'}},{status:400});
    return Response.json(body);
   };
   const env={DB:{},GOOGLE_SPREADSHEET_ID:'book',STABLE_SHEETS_PACING_ENABLED:'true'},run=diagnostic=>client.readMonthlyReportGrid(env,7,5,{kind:'continuous-expense'},diagnostic);
   await assert.rejects(run(true),error=>{assert.ok(error instanceof client.MonthlyGridReadError);assert.equal(error.operation,mode);assert.ok(error.original instanceof client.SheetsHttpError);assert.equal(error.original.status,400);assert.doesNotMatch(error.message,/private/);return true;});
   metadataReads=0;fullReads=0;await assert.rejects(run(false),error=>error instanceof client.SheetsHttpError&&error.status===400);
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;}
 }
});
