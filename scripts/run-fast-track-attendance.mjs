import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const base=process.env.MALIPANG_UAT_BASE_URL;
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
const fixtureDir=process.env.MALIPANG_CLOCK_FIXTURE_DIR;
if(!base||!tokenFile||!fixtureDir)throw new Error('MALIPANG_UAT_BASE_URL, MALIPANG_ADMIN_TOKEN_FILE, and MALIPANG_CLOCK_FIXTURE_DIR are required');
const token=(await readFile(resolve(tokenFile),'utf8')).trim();
const cases=[
  {id:'UAT-A01',file:'photo-05.jpg',employee:'UATIPH',message:'uat_a01_iphone_in',receivedAt:'2026-07-21T21:26:39.000Z',expected:'IN'},
  {id:'UAT-A02',file:'photo-04.jpg',employee:'UATIPH',message:'uat_a02_iphone_out',receivedAt:'2026-07-22T00:03:55.000Z',expected:'OUT'},
  {id:'UAT-A03',file:'photo-03.jpg',employee:'UATAND',message:'uat_a03_android_in',receivedAt:'2026-07-20T10:33:23.000Z',expected:'IN'},
  {id:'UAT-A04',file:'photo-03.jpg',employee:'UATAND',message:'uat_a03_android_in',receivedAt:'2026-07-20T10:33:23.000Z',expected:'DUPLICATE_MESSAGE'},
  {id:'UAT-A05',file:'photo-03.jpg',employee:'UATAND',message:'uat_a05_duplicate_image',receivedAt:'2026-07-20T10:33:23.000Z',expected:'DUPLICATE_IMAGE'},
  {id:'UAT-A06',file:'photo-06.jpg',employee:'UATAND',message:'uat_a06_gps_missing',receivedAt:'2026-07-21T10:16:00.000Z',expected:'GPS_MISSING'},
  {id:'UAT-A07',file:'photo-07.jpg',employee:'UATAND',message:'uat_a07_gps_missing',receivedAt:'2026-07-21T21:10:00.000Z',expected:'GPS_MISSING'},
  {id:'UAT-A08',file:'photo-01.jpg',employee:'UATAND',message:'uat_a08_stale_iphone',receivedAt:'2026-07-21T10:25:56.000Z',expected:'PHOTO_TIME_TOO_OLD'},
  {id:'UAT-A09',file:'photo-03.jpg',employee:'UATAND',message:'uat_a09_stale_android',receivedAt:'2026-07-20T10:43:23.000Z',expected:'PHOTO_TIME_TOO_OLD'},
  {id:'UAT-A10',file:'photo-04.jpg',employee:'UATAND',message:'uat_a10_outside_radius',receivedAt:'2026-07-22T00:03:55.000Z',radius:10,expected:'OUTSIDE_STORE_RADIUS'},
  {id:'UAT-A11',file:'photo-01.jpg',employee:'UATAND',message:'uat_a11_outside_radius',receivedAt:'2026-07-21T10:15:56.000Z',radius:1,expected:'OUTSIDE_STORE_RADIUS'},
  {id:'UAT-A12',file:'photo-01.jpg',employee:'UATMISS',message:'uat_a12_missing_punch',receivedAt:'2026-07-21T10:15:56.000Z',expected:'MISSING_PUNCH'}
];
const results=[];
for(const item of cases){
  const image=await readFile(resolve(fixtureDir,item.file));
  const query=new URLSearchParams({caseId:`uat_${item.id.toLowerCase().replaceAll('-','_')}`,messageId:item.message,employeeId:item.employee,receivedAt:item.receivedAt});
  if(item.radius)query.set('allowedRadiusM',String(item.radius));
  const response=await fetch(`${base}/admin/uat/attendance?${query}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'image/jpeg'},body:image});
  const data=await response.json();
  const code=data.validation?.validationCode;
  const event=data.d1?.event;
  let passed=false,actual=code||data.error||`HTTP ${response.status}`;
  if(item.expected==='IN'||item.expected==='OUT'){actual=event?.punch_type||code;passed=response.ok&&code==='OK'&&event?.punch_type===item.expected;}
  else if(item.expected==='DUPLICATE_MESSAGE'){actual=`beforeMessage=${data.d1?.beforeMessage}`;passed=response.ok&&code==='OK'&&data.d1?.beforeMessage===1;}
  else if(item.expected==='DUPLICATE_IMAGE'){actual=`beforeImage=${data.d1?.beforeImage},event=${event?'present':'none'}`;passed=response.ok&&code==='OK'&&data.d1?.beforeImage===1&&!event;}
  else if(item.expected==='MISSING_PUNCH'){actual=`${event?.punch_type||code}/${data.d1?.daily?.pay_status||'none'}`;passed=response.ok&&code==='OK'&&event?.punch_type==='IN'&&data.d1?.daily?.time_out==null&&data.d1?.daily?.pay_status==='REVIEW';}
  else passed=response.ok&&code===item.expected&&!event;
  results.push({case:item.id,expected:item.expected,actual,pass:passed,d1:event?`${event.event_id}:${event.punch_type}`:'no new attendance event',sheets:item.expected==='IN'||item.expected==='OUT'||item.expected==='MISSING_PUNCH'?'queued':'not queued',note:item.radius?`Controlled UAT radius override ${item.radius}m`:''});
}
console.log(JSON.stringify({ok:results.every(item=>item.pass),passed:results.filter(item=>item.pass).length,total:results.length,results},null,2));
