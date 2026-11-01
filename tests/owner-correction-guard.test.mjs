import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOwnerCorrection} from '../dist/expense/owner-correction-guard.js';

const snapshot={expenseId:'exp_guard',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
const draft={before:snapshot,after:{...snapshot,amountSatang:210000},field:'amountSatang'};
const evidence=()=>({ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:1,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false});
test('confirmed expense needs verified open periods and matching projection targets',()=>{
  assert.deepEqual(assessOwnerCorrection(draft,evidence()),[]);
  const e={...evidence(),sourcePeriod:'UNKNOWN',rowIdentityVerified:false,projectionTargetsVerified:false};
  assert.deepEqual(assessOwnerCorrection(draft,e),['PERIOD_UNKNOWN_OR_CLOSED','ROW_IDENTITY_UNVERIFIED','PROJECTION_TARGET_UNVERIFIED']);
});
test('multiple receipt items and in-flight sync block unsafe amount correction',()=>{
  const e={...evidence(),itemCount:3,syncInProgress:true};
  assert.deepEqual(assessOwnerCorrection(draft,e),['SYNC_IN_PROGRESS','RECEIPT_ALLOCATION_REVIEW']);
  e.receiptAllocationVerified=true;e.syncInProgress=false;assert.deepEqual(assessOwnerCorrection(draft,e),[]);
});
test('waiting drafts still require owner and snapshot, but have no posted row or period yet',()=>{
  const waiting={...draft,before:{...snapshot,status:'WAITING_CONFIRM'}};
  const e={...evidence(),ownerVerified:false,snapshotCurrent:false,sourcePeriod:'UNKNOWN',destinationPeriod:'UNKNOWN',rowIdentityVerified:false,projectionTargetsVerified:false};
  assert.deepEqual(assessOwnerCorrection(waiting,e),['OWNER_UNVERIFIED','SNAPSHOT_STALE']);
});
