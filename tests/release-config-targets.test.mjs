// #296 step 4d: the continuous tab targets. Mirrors the checks in
// src/sheets/report-view-bootstrap.ts so a wrong value fails CI instead of
// failing the VIEWS action during the cutover night.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
const IDS=['CONTINUOUS_DAILY_SHEET_ID','CONTINUOUS_RAW_SHEET_ID','CONTINUOUS_DETAIL_SHEET_ID','CONTINUOUS_RAW_VIEW_ID','CONTINUOUS_DETAIL_VIEW_ID'];
const NAMES=['CONTINUOUS_DAILY_SHEET','CONTINUOUS_RAW_SHEET','CONTINUOUS_DETAIL_SHEET'];
test('continuous targets: five distinct sheet IDs and three new, distinct tab names',()=>{
  if(![...IDS,...NAMES].some(k=>k in vars))return;
  for(const k of IDS){
    assert.match(vars[k]??'',/^(0|[1-9]\d*)$/,`${k} must be the owner's non-negative integer, not a placeholder`);
    assert.ok(Number(vars[k])<=2147483647,k);
  }
  assert.equal(new Set(IDS.map(k=>vars[k])).size,IDS.length,'sheet IDs must be distinct');
  for(const k of NAMES){const v=vars[k];assert.equal(typeof v,'string',k);assert.ok(v.length>0&&v===v.trim()&&v.length<=100,k);}
  const names=[...NAMES.map(k=>vars[k]),'V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL'];
  assert.equal(new Set(names).size,names.length,'tab names must be distinct');
  for(const old of [vars.SHEET_EXPENSE_DAILY,vars.SHEET_EXPENSE_RAW,vars.SHEET_PURCHASE_DETAILS])assert.equal(names.includes(old),false,`must not reuse ${old}`);
  // VIEWS requires these exact legacy names (report-view-bootstrap.ts).
  assert.equal(vars.SHEET_EXPENSE_RAW,'V52_EXPENSE_RAW');assert.equal(vars.SHEET_PURCHASE_DETAILS,'รายละเอียดการซื้อ');
});
