import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{verifyMonthlyIncidentOverlay}=require('../dist/sheets/monthly-incident-overlay.js'),{reportBaselineDigest,reportRowDigests,spareReportRowDigests}=require('../dist/sheets/monthly-report-baseline.js'),{dailySnapshotDigest,dailyPayloadDigest}=require('../dist/sheets/continuous-daily-write-evidence.js'),{encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{appendDailyRowFormulas}=require('../dist/sheets/append-daily-template.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js');
const blank=()=>Array(29).fill(null),structure={sheetId:7,title:'รายวันต่อเนื่อง_แบบร่าง',properties:{},mergedRanges:[],protectedRanges:[],conditionalFormats:[],filterViews:[],basicFilter:null,rowMetadata:[],columnMetadata:[]};
function grid(rows){return {rows,columns:29,formula:Array.from({length:rows},blank),effective:Array.from({length:rows},blank),notes:Array.from({length:rows},blank),formats:Array.from({length:rows},blank),validations:Array.from({length:rows},blank),extras:Array.from({length:rows},blank),structure:structuredClone(structure)};}
async function fixture(){
 const coords={sheetId:7,row:5,rowCount:5,columnCount:29},before=grid(5);Object.assign(before.formula[4],continuousDailyHelperFormulas(5));
 const payload=encodeAtomicDailyPayload({expenseId:'exp_fixture',postingYear:2026,postingMonth:11,postingDay:21,description:'fixture',amountColumn:'H',amountSatang:123,category:'ingredients',wallet:'บัญชีร้าน',operationMarker:'INSERT_'+'a'.repeat(32)}),beforeDigest=await dailySnapshotDigest(before,coords),payloadDigest=await dailyPayloadDigest(payload);
 const base=grid(7);Object.assign(base.formula[4],appendDailyRowFormulas());base.formula[4][24]=base.effective[4][24]=payload;Object.assign(base.formula[5],continuousDailyHelperFormulas(6));
 const current=structuredClone(base);current.rows=9;for(const k of ['formula','effective','notes','formats','validations','extras'])current[k].push(blank(),blank());current.formula[7][3]=current.effective[7][3]='report fixture';const marker='MRP1_'+'b'.repeat(32);current.notes[7][19]=marker;
 const receipt={row:8,marker,...await reportRowDigests(current,8),...await spareReportRowDigests(current,9)};return {base,current,baselineDigest:await reportBaselineDigest(base),receipts:[receipt],coords,payload,beforeDigest,payloadDigest};
}
test('read-only overlay preserves the original positive insert proof',async()=>{const x=await fixture();assert.equal(await verifyMonthlyIncidentOverlay(x),true);});
test('overlay cannot hide a changed original row, unknown tail, forged receipt or changed incident digest',async()=>{for(const mode of ['original','unknown-tail','receipt','incident-digest','extra-tail','sheet']){const x=await fixture();
 if(mode==='original')x.current.formula[4][24]='changed';if(mode==='unknown-tail')x.current.notes[8][1]='new note';if(mode==='receipt')x.receipts[0].formulaDigest='0'.repeat(64);if(mode==='incident-digest')x.beforeDigest='0'.repeat(64);if(mode==='extra-tail')x.base.formula[6][0]=9;if(mode==='sheet')x.base.structure.sheetId=8;
 assert.equal(await verifyMonthlyIncidentOverlay(x),false,mode);
 }});
