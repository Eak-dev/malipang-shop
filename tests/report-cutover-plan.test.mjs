import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {planContinuousReportCutover,planManualDailyBudgetUpgrade,reportFormulaCompareAndSwapRequests}=require('../dist/sheets/report-cutover-plan.js');
const {continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js');

const titles={rawNew:'raw_new',detailNew:'detail_new',rawCombined:'raw_all',detailCombined:'detail_all'};
const old="'รายวัน'";
function ownerCash(row,column){
 const day=`A${row}`,gate=`OR(${day}="",${day}>$E$2)`,modern='OR($B$2="2026-11",$B$2="2026-12")';
 const sum=(amount,wallet,exclude)=>`SUMIFS(${old}!$${amount}$5:$${amount}$4464,${old}!$U$5:$U$4464,${day}${wallet?`,${old}!$W$5:$W$4464,"${wallet}"`:''}${exclude?`,${old}!$V$5:$V$4464,"<>personal_use"`:''})`;
 const wallet=column==='B'?'CASH_DRAWER':column==='C'?'SHOP_BANK':column==='D'?'CARD_*':null;
 const clean=`SUMIFS('97_EXPENSE_CLEAN'!$D$2:$D$4500,'97_EXPENSE_CLEAN'!$A$2:$A$4500,${day}${wallet?`,'97_EXPENSE_CLEAN'!$E$2:$E$4500,"${wallet}"`:''}${column==='B'?`,'97_EXPENSE_CLEAN'!$H$2:$H$4500,"<>ACCUMULATED_CASH"`:''})`;
 const previous=exclude=>column==='F'?`${sum('I',null,exclude)}+${sum('R',null,exclude)}`:sum(column==='D'?'R':'I',column==='B'?'ทอน/หน้าร้าน':column==='C'?'บัญชีร้าน':null,exclude);
 const wrap=x=>`IF(${gate},"",${x})`;
 return `=IF($B$2="2026-10",IF(${modern},${wrap(clean)},${wrap(previous(true))}),IF(${modern},${wrap(clean)},${wrap(previous(false))}))`;
}
function fixture(){
 const sheet=(sheetId,sheetName,rowCount,columnCount)=>({sheetId,sheetName,rowCount,columnCount,formula:Array.from({length:rowCount},()=>[])});
 const s={monthClose:sheet(1,'04_OWNER_MONTH_CLOSE',100,23),clean:sheet(2,'97_EXPENSE_CLEAN',10,8),formulaReview:sheet(3,'98_FORMULA_REVIEW',10,6),ownerCash:sheet(4,'34_OWNER_DAILY_CASH',90,10),flow:sheet(5,'35_EXPENSE_FLOW_CHECK',80,7),recon:sheet(6,'30_RECON_DAILY',10,20)};
 s.monthClose.formula[2][2]='=SUM(V52_EXPENSE_RAW!D2:D1000)';
 s.monthClose.formula[3][2]="=SUM('รายละเอียดการซื้อ'!L2:L1000)";
 s.clean.formula[1][0]='=LET(ids,V52_EXPENSE_RAW!A2:A,dt,V52_EXPENSE_RAW!B2:B,raw,FILTER(ids,dt>=DATE(2026,8,1)),raw)';
 s.clean.formula[1][7]='=SUM(V52_EXPENSE_RAW!R2:R1000)';
 s.formulaReview.formula[2][5]='=SUM(V52_EXPENSE_RAW!R2:R1000)';
 for(let row=46;row<=76;row++)for(const [col,name] of [[2,'B'],[3,'C'],[4,'D'],[6,'F']])s.ownerCash.formula[row-1][col-1]=ownerCash(row,name);
 for(let row=5;row<=65;row++){
  s.flow.formula[row-1][1]=`=IF(OR(A${row}="",A${row}>TODAY()),"",SUMIF(${old}!$U$5:$U$4464,A${row},${old}!$I$5:$I$4464)+SUMIF(${old}!$U$5:$U$4464,A${row},${old}!$R$5:$R$4464))`;
  s.flow.formula[row-1][5]=`=IF(OR(A${row}="",A${row}>TODAY()),"",COUNTIFS(${old}!$U$5:$U$4464,A${row},${old}!$D$5:$D$4464,"<>"))`;
 }
 s.recon.formula[3][19]=`=ROUND(SUMIFS('97_EXPENSE_CLEAN'!D2:D4500,'97_EXPENSE_CLEAN'!A2:A4500,d)-SUMIFS('รายวัน'!I5:I4464,'รายวัน'!U5:U4464,d,'รายวัน'!W5:W4464,"ทอน/หน้าร้าน"),2)`;
 return s;
}
test('plans each affected report cell with exact preimage and one-cell conditional writes',()=>{
 const snapshots=fixture(),changes=planContinuousReportCutover(snapshots,titles);
 assert.equal(changes.length,252);
 assert.equal(new Set(changes.map(x=>`${x.sheetId}:${x.row}:${x.column}`)).size,252);
 const clean=changes.find(x=>x.sheetName==='97_EXPENSE_CLEAN'&&x.row===2&&x.column===1);
 assert.match(clean.after,/MATCH\("MALIPANG_EXPENSE:"&ids/);
 assert.match(clean.after,/'raw_all'!A2:A/);
 const req=reportFormulaCompareAndSwapRequests(changes),one=req.find(x=>x.findReplace.range.sheetId===2&&x.findReplace.range.startColumnIndex===0);
 assert.equal(req.length,252);assert.equal(one.findReplace.find,clean.before);assert.equal(one.findReplace.replacement,clean.after);
 assert.equal(one.findReplace.matchEntireCell,true);assert.equal(one.findReplace.includeFormulas,true);assert.equal(one.findReplace.range.endRowIndex-one.findReplace.range.startRowIndex,1);
});
test('changed preimages, incomplete sheets and duplicated coordinates are rejected',()=>{
 const broken=fixture();broken.flow.formula[4][1]='=0';assert.throws(()=>planContinuousReportCutover(broken,titles),/PREIMAGE/);
 const missing=fixture();missing.recon.columnCount=19;assert.throws(()=>planContinuousReportCutover(missing,titles),/SNAPSHOT/);
 const changes=planContinuousReportCutover(fixture(),titles);assert.throws(()=>reportFormulaCompareAndSwapRequests([changes[0],changes[0]]),/DUPLICATE/);
});
test('manual budget migration accepts only the exact default of each physical row',()=>{
 const s={sheetId:7,sheetName:'รายวันต่อเนื่อง_แบบร่าง',rowCount:10,columnCount:29,formula:Array.from({length:10},()=>[])};
 for(let row=4;row<=10;row++)s.formula[row-1][9]=continuousDailyHelperFormulas(row)[9];
 const changes=planManualDailyBudgetUpgrade(s),requests=reportFormulaCompareAndSwapRequests(changes);
 assert.equal(changes.length,7);assert.equal(requests.length,7);
 assert.equal(requests[0].findReplace.range.startRowIndex,3);assert.equal(requests[0].findReplace.range.startColumnIndex,9);
 assert.match(changes[0].after,/INDEX\(I:I,ROW\(\)\)/);
 s.formula[5][9]=continuousDailyHelperFormulas(5)[9];
 assert.throws(()=>planManualDailyBudgetUpgrade(s),/PREIMAGE/);
});
