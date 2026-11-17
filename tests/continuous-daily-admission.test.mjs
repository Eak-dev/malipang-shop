import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{inspectUnwrittenPreCutover}=require('../dist/sheets/continuous-daily-admission.js'),{ledgerCarrierFormulas,ledgerCarrierMarker,encodeLedgerCarrier,ledgerCarrierDisplay}=require('../dist/sheets/atomic-expense-ledger-template.js');
function fixture(){
 const snapshot=(rows,cols)=>({rowCount:rows,columnCount:cols,formula:Array.from({length:rows},()=>Array(cols).fill(null)),effective:Array.from({length:rows},()=>Array(cols).fill(null))});
 const snapshots=[snapshot(5,25),snapshot(5,29),snapshot(3,17),snapshot(3,26),snapshot(3,20),snapshot(3,26)];
 for(const [index,kind] of [[3,'EXPENSE_RAW'],[5,'DETAIL']])for(let row=2;row<=3;row++){const marker=ledgerCarrierMarker(row);Object.assign(snapshots[index].formula[row-1],ledgerCarrierFormulas(kind,row));snapshots[index].formula[row-1][25]=snapshots[index].effective[row-1][25]=marker;}
 return {expenseId:'exp_candidate',sourceDate:'2026-11-15',postingDate:'2026-11-15',documentIds:['doc_candidate'],snapshots};
}
test('first-attempt provider proof requires all six complete sheets and no same-day financial rows',()=>{
 const x=fixture();assert.deepEqual(inspectUnwrittenPreCutover(x),{status:'CLEAR'});
 x.snapshots[0].effective[3][1]=11;x.snapshots[0].effective[3][2]=15;x.snapshots[0].effective[3][8]=1.23;x.snapshots[0].effective[3][20]=(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000;
 assert.equal(inspectUnwrittenPreCutover(x).reason,'SAME_DAY_FINANCIAL_ROW');
});
test('missing date, formula error, document match or incomplete snapshots never prove absence',()=>{
 for(const edit of [x=>{x.snapshots[0].effective[3][1]=11;x.snapshots[0].effective[3][8]=1.23;},x=>{x.snapshots[0].effective[3][8]='#ERROR!';},x=>{x.snapshots[4].effective[1][2]='doc_candidate';},x=>{x.snapshots.pop();}]){const x=fixture();edit(x);assert.equal(inspectUnwrittenPreCutover(x).status,'HOLD');}
});
test('unidentified same-day RAW row and malformed helper carrier are held',()=>{
 let x=fixture();Object.assign(x.snapshots[2].effective[1],{1:'2026-11-15',2:'legacy unidentified',3:1.23});assert.equal(inspectUnwrittenPreCutover(x).reason,'SAME_DAY_RAW_ROW');
 x=fixture();x.snapshots[3].formula[1][0]='=tampered';assert.equal(inspectUnwrittenPreCutover(x).reason,'HELPER_ROW_UNVERIFIED');
});
test('valid carrier in helper RAW is inspected by effective date, not only by ID',()=>{
 const x=fixture(),row={projection:'EXPENSE_RAW',expenseId:'exp_other',itemId:'',confirmedVersion:1,status:'CONFIRMED',cancelVersion:null,cancelledAt:'',values:['exp_other','2026-11-15','other',1.23,'transfer','SHOP_BANK','ingredients','CONFIRMED','','','','','','','','','']};
 const s=x.snapshots[3],value=encodeLedgerCarrier(row);s.formula[1][25]=s.effective[1][25]=value;ledgerCarrierDisplay(row).forEach((v,i)=>{s.effective[1][i]=v;});assert.equal(inspectUnwrittenPreCutover(x).reason,'SAME_DAY_RAW_ROW');
});
