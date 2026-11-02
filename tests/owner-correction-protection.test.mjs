import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerCorrectionCategoryProtected,ownerCorrectionSystemSheetProtected,inspectOwnerCorrectionCategoryProtection} from '../dist/sheets/owner-correction-protection.js';
const account='worker@example.invalid';
const safe=()=>({range:{sheetId:1,startRowIndex:4,startColumnIndex:21,endColumnIndex:22},warningOnly:false,requestingUserCanEdit:true,editors:{users:[account],groups:[],domainUsersCanEdit:false}});
test('only a non-warning, unbounded category protection with the worker as sole explicit editor passes',()=>{
  assert.equal(ownerCorrectionCategoryProtected(1,[safe()],account),true);
  const cases=[p=>{p.warningOnly=true},p=>{p.requestingUserCanEdit=false},p=>{p.editors.users.push('other@example.invalid')},p=>{p.editors.groups=['all@example.invalid']},p=>{p.editors.domainUsersCanEdit=true},p=>{delete p.editors},p=>{p.unprotectedRanges=[{}]},p=>{p.range.endRowIndex=5000},p=>{p.range.startRowIndex=5},p=>{p.range.startColumnIndex=22},p=>{p.range.endColumnIndex=21},p=>{p.range.startRowIndex=-1}];
  for(const mutate of cases){const p=safe();mutate(p);assert.equal(ownerCorrectionCategoryProtected(1,[p],account),false);}
  assert.equal(ownerCorrectionCategoryProtected(1,[safe(),safe()],account),false);
});
test('live protection inspection refuses missing configuration or unreadable editor details',async()=>{
  assert.equal(await inspectOwnerCorrectionCategoryProtection({},async()=>{throw Error('must not read')}),false);
  const system=id=>({range:{sheetId:id},requestingUserCanEdit:true,editors:{users:[account]}}),env={SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail',GOOGLE_SERVICE_ACCOUNT_EMAIL:account};
  assert.equal(ownerCorrectionSystemSheetProtected(2,[system(2)],account),true);
  assert.equal(ownerCorrectionSystemSheetProtected(2,[{...system(2),unprotectedRanges:[{}]}],account),false);
  const reader=async(_env,name)=>name==='daily'?{sheetId:1,ranges:[safe()]}:name==='raw'?{sheetId:2,ranges:[system(2)]}:{sheetId:3,ranges:[system(3)]};
  assert.equal(await inspectOwnerCorrectionCategoryProtection(env,reader),true);
  assert.equal(await inspectOwnerCorrectionCategoryProtection(env,async(_env,name)=>name==='detail'?{sheetId:3,ranges:[]}:reader(_env,name)),false);
  await assert.rejects(inspectOwnerCorrectionCategoryProtection(env,async()=>{throw Error('unavailable')}),/unavailable/);
});
