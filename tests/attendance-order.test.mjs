import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAttendance} from '../dist/attendance/service.js';

test('sheet jobs are durable before LINE success message',async()=>{
  const order=[];
  const statement={bind(){return this;},async run(){return{meta:{changes:1}};},async first(){return null;},async all(){return{results:[],meta:{}};}};
  const env={
    DB:{prepare(){return statement;},async batch(){order.push('sync-job-d1');return[];}},
    JOB_QUEUE:{async send(){},async sendBatch(){order.push('sync-job-queue');}},
    ATTENDANCE_COORDINATOR:{idFromName(){return{};},get(){return{async fetch(){order.push('attendance-commit');return Response.json({eventId:'att_1',punchType:'IN',workDate:'2026-07-20',officialTime:'04:03',status:'NORMAL',lateMinutes:0,confirmedWageSatang:0,pendingWageSatang:0,validationCode:'OK',version:1});}};}},
    EVIDENCE:{async put(){},async get(){return null;}},R2_EVIDENCE_ENABLED:'false',SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:'production',SHADOW_LINE_OUTPUT:'false',LINE_CHANNEL_ACCESS_TOKEN:'token',EXTERNAL_API_TIMEOUT_MS:'1000',ATTENDANCE_STORE_LAT:'13.89682',ATTENDANCE_STORE_LNG:'100.60830',ATTENDANCE_ALLOWED_RADIUS_M:'120',ATTENDANCE_MAX_PHOTO_AGE_MIN:'3',ATTENDANCE_OVERLAY_MIN_CONFIDENCE:'0.9',ATTENDANCE_CLOCK_MIN_CONFIDENCE:'0.7'
  };
  const previousFetch=globalThis.fetch;globalThis.fetch=async()=>{order.push('line-push');return new Response('{}',{status:200});};
  try{
    await handleAttendance(env,{type:'message',timestamp:Date.parse('2026-07-19T21:03:00Z'),source:{type:'user',userId:'U1'},message:{id:'M1',type:'image'},webhookEventId:'W1'},{employeeId:'EMP001',staffName:'Win',lineUserId:'U1',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:50000,graceMin:10,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:false,status:'ACTIVE'},{kind:'CLOCK',hour:null,minute:null,month:null,day:null,weekday:null,confidence:.99,clockFullyVisible:true,clockPresent:true,clockConfidence:.99,overlayPresent:true,overlayTextWhite:true,photoDate:'2026-07-20',photoTime:'04:03:00',latitude:13.89682,longitude:100.60830,locationText:'Yingcharoen Market',overlayRawText:'2026-07-20 04:03 +13.89682,+100.60830',overlayConfidence:.99,needsNewPhoto:false,note:'',provider:'test',raw:null},new Uint8Array([1,2,3]).buffer,'trace_1');
  }finally{globalThis.fetch=previousFetch;}
  assert.ok(order.indexOf('sync-job-queue')>=0);
  assert.ok(order.indexOf('sync-job-queue')<order.indexOf('line-push'));
});
