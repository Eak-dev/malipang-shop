import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {evidencedOverlayTimestamp}=require('../dist/domain/attendance-overlay.js');
const {normalizeOpenAIVisionResult}=require('../dist/vision/openai.js');
const {readImageWithWorkersAI}=require('../dist/vision/workers-ai.js');
const {validateAttendancePhoto}=require('../dist/domain/attendance.js');

// Synthetic values only. The attendance timestamp must come from the white camera overlay
// text; a time the model reports without that evidence (e.g. the shop wall clock) is not used.
const rules={storeLat:13.9,storeLng:100.6,allowedRadiusM:120,maxPhotoAgeMin:3,overlayMinConfidence:0.9,clockMinConfidence:0.7};
const receivedAt='2026-11-23T02:12:30.000Z'; // 09:12:30 Bangkok
const ADDRESS='SYNTHETIC ADDRESS LINE',GPS='+13.900000,+100.600000',STAMP='23 Nov BE 2569 at 09:12:02';
const base={kind:'CLOCK',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0.95,clockFullyVisible:true,clockPresent:true,clockConfidence:0.95,
  overlayPresent:true,overlayTextWhite:true,photoDate:null,photoTime:null,latitude:null,longitude:null,locationText:'SYNTHETIC',overlayRawText:ADDRESS,overlayConfidence:0.95,needsNewPhoto:false,note:''};
const gps={latitude:13.9,longitude:100.6};
const providers={
  openai:async obj=>normalizeOpenAIVisionResult({...obj,document:null},{}),
  'workers-ai':async obj=>readImageWithWorkersAI({WORKERS_AI_MODEL:'@cf/synthetic/model',AI:{run:async()=>({result:{answer:JSON.stringify(obj)}})}},new Uint8Array([255,216,255,217]).buffer),
};
const code=v=>v.ok?'OK':v.validationCode;

// [label, model output, expected validation code]
const scenarios=[
  ['valid overlay timestamp and GPS',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'OK'],
  ['valid overlay, model leaves fields empty',{...base,...gps,overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'OK'],
  ['overlay without a timestamp (photo-07 shape)',{...base},'TIMESTAMP_FIELDS_MISSING'],
  ['only the shop clock, no overlay',{...base,overlayPresent:false,overlayTextWhite:false,overlayRawText:'',locationText:''},'TIMESTAMP_MISSING'],
  ['valid timestamp, GPS missing',{...base,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${ADDRESS}`},'GPS_MISSING'],
  ['model copies the wall clock, overlay address only',{...base,photoDate:'2026-11-23',photoTime:'09:12'},'TIMESTAMP_FIELDS_MISSING'],
  ['model copies the wall clock, overlay has GPS but no time',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12',overlayRawText:`${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['model time differs from the overlay time',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:13',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['model date differs from the overlay date',{...base,...gps,photoDate:'2026-11-22',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['model seconds differ from overlay seconds',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:40',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['overlay holds two different times',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n09:13\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['overlay holds two dates at the same time, model agrees with the first',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n22 Nov BE 2569 at 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['overlay holds two dates in different formats, model fields empty',{...base,...gps,overlayRawText:`2026/11/22 09:12:02\n${STAMP}\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['overlay holds 09:12 and 9:12 PM (AM/PM conflict)',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12',overlayRawText:`23 Nov 2026 09:12 and 9:12 PM\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['the same overlay timestamp written twice is accepted',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${STAMP}\n${GPS}\n${ADDRESS}`},'OK'],
  ['wrong time agreed by text and fields is caught by photo age',{...base,...gps,photoDate:'2026-11-23',photoTime:'08:40:00',overlayRawText:`23 Nov BE 2569 at 08:40:00\n${GPS}\n${ADDRESS}`},'PHOTO_TIME_TOO_OLD'],
  ['wrong day with right HH:mm is caught by photo age',{...base,...gps,photoDate:'2026-11-22',photoTime:'09:12:02',overlayRawText:`22 Nov BE 2569 at 09:12:02\n${GPS}\n${ADDRESS}`},'PHOTO_TIME_TOO_OLD'],
  ['wrong BE year is caught by photo age',{...base,...gps,photoDate:'2025-11-23',photoTime:'09:12:02',overlayRawText:`23 Nov BE 2568 at 09:12:02\n${GPS}\n${ADDRESS}`},'PHOTO_TIME_TOO_OLD'],
  ['unsupported overlay format is not guessed',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`23 พ.ย. 2569 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['GPS outside the store radius still rejected',{...base,latitude:13.95,longitude:100.6,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n+13.950000,+100.600000\n${ADDRESS}`},'OUTSIDE_STORE_RADIUS'],
  ['low clock confidence still rejected first',{...base,...gps,clockConfidence:0.5,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'CLOCK_NOT_CONFIRMED'],
  ['low overlay confidence still rejected',{...base,...gps,overlayConfidence:0.5,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'TIMESTAMP_LOW_CONFIDENCE'],
  // Independent review of 05f3aee: no number or month may be the tail of a longer token
  ['digit glued before the day is not a date (day-first)',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`123 Nov 2026 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['month name inside a word is not a month (month-first)',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`Xnov 23, 2026 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['year inside a longer number is not a year (year-first)',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`12026/11/23 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['digit glued before the day is not a date (numeric day-first)',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`123/11/2026 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['minutes followed by a digit are not a time',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`23 Nov 2026 09:123\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  ['a date is not taken from a malformed time',{...base,...gps,photoDate:'2026-11-22',photoTime:'09:12:02',overlayRawText:`22 Nov 2026 09:123 23 Nov 2026 09:12:02\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  // The same minute with and without seconds agrees; two different seconds values do not
  ['same minute as HH:mm:ss and HH:mm is accepted',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n09:12\n${GPS}\n${ADDRESS}`},'OK'],
  ['stamp without seconds plus the same minute with seconds is accepted',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`23 Nov 2026 09:12\n09:12:02\n${GPS}\n${ADDRESS}`},'OK'],
  ['two different seconds in the same minute are rejected',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n09:12:40\n${GPS}\n${ADDRESS}`},'TIMESTAMP_FIELDS_MISSING'],
  // RESIDUAL RISK (S1, not fixed): if the model fabricates both the overlay text and the fields
  // consistently and close to the real time, this deterministic check cannot detect it.
  ['S1 residual: fabricated but consistent overlay text and fields',{...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`},'OK'],
];

for(const [provider,read] of Object.entries(providers)){
  test(`${provider}: attendance timestamp is taken only from the overlay text`,async()=>{
    for(const [label,obj,want] of scenarios){
      const reading=await read(obj);
      assert.equal(code(validateAttendancePhoto(reading,receivedAt,rules)),want,`${provider}: ${label}`);
    }
  });
  test(`${provider}: accepted readings keep the overlay date and HH:mm as official time`,async()=>{
    const reading=await read({...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`${STAMP}\n${GPS}\n${ADDRESS}`});
    const v=validateAttendancePhoto(reading,receivedAt,rules);
    assert.equal(v.ok,true);assert.equal(v.workDate,'2026-11-23');assert.equal(v.officialTime,'09:12');assert.equal(v.photoDateTime,'2026-11-23T09:12:02+07:00');
    const mixed=await read({...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:02',overlayRawText:`23 Nov 2026 09:12\n09:12:02\n${GPS}\n${ADDRESS}`});
    assert.equal(validateAttendancePhoto(mixed,receivedAt,rules).photoDateTime,'2026-11-23T09:12:02+07:00','seconds come from the overlay token that shows them');
    const noSeconds=await read({...base,...gps,photoDate:'2026-11-23',photoTime:'09:12:45',overlayRawText:`23 Nov 2026 9:12\n${GPS}\n${ADDRESS}`});
    const w=validateAttendancePhoto(noSeconds,receivedAt,rules);
    assert.equal(w.ok,true,'seconds the overlay does not show are not taken from the model');assert.equal(w.officialTime,'09:12');assert.equal(w.photoDateTime,'2026-11-23T09:12:00+07:00');
  });
  test(`${provider}: AM/PM is read only as a real time marker`,async()=>{
    const evening='2026-11-23T14:12:30.000Z'; // 21:12:30 Bangkok
    const check=async(overlay,want,time,label)=>{
      const reading=await read({...base,...gps,photoDate:'2026-11-23',photoTime:'21:12',overlayRawText:`${overlay}\n${GPS}\n${ADDRESS}`});
      const v=validateAttendancePhoto(reading,evening,rules);
      assert.equal(code(v),want,`${provider}: ${label}`);
      if(time)assert.equal(v.officialTime,time,`${provider}: ${label} official time`);
    };
    await check('23 Nov 2026 21:12 Amphoe','OK','21:12','a place name starting with "Am" after 21:12 is not AM');
    await check('23 Nov 2026 9:12 PM','OK','21:12','9:12 PM is 21:12');
    await check('23 Nov 2026 9:12 PM 21:12','OK','21:12','9:12 PM and 21:12 are the same time');
    await check('23 Nov 2026 9:12 P.M.','TIMESTAMP_FIELDS_MISSING',null,'a malformed marker is not read as PM and gives no evening time');
    await check('23 Nov 2026 21:12 PM','TIMESTAMP_FIELDS_MISSING',null,'21 with PM is not a time');
    await check('23 Nov 2026 09:12 and 9:12 PM','TIMESTAMP_FIELDS_MISSING',null,'09:12 and 9:12 PM conflict');
    await check('23 Nov 2026 21:12\n22 Nov 2026 21:12','TIMESTAMP_FIELDS_MISSING',null,'two different dates at 21:12 are still rejected');
  });
}

test('evidencedOverlayTimestamp reads every supported overlay shape, CE and BE years, and AM/PM',()=>{
  const cases=[
    ['23 Nov BE 2569 at 09:12:02','2026-11-23','09:12:02'],
    ['23 Nov 2026 9:12','2026-11-23','09:12'],
    ['November 23, 2026 09:12:02 PM','2026-11-23','21:12:02'],
    ['2026/11/23 09:12:02','2026-11-23','09:12:02'],
    ['2569-11-23 09:12','2026-11-23','09:12'],
    ['23/11/2569 09:12:02','2026-11-23','09:12:02'],
    ['23-11-26 09:12','2026-11-23','09:12'],
    // AM/PM only when it is a whole word: a place name after the time is not a marker, in every parser path
    ['23 Nov 2026 21:12 Amphoe','2026-11-23','21:12'],
    ['November 23, 2026 21:12 Amphoe Mueang','2026-11-23','21:12'],
    ['2026/11/23 21:12 Amphoe','2026-11-23','21:12'],
    ['23/11/2026 21:12 Amphoe','2026-11-23','21:12'],
    ['23 Nov 2026 9:12 PM','2026-11-23','21:12'],
    ['23 Nov 2026 9:12PM Amphoe','2026-11-23','21:12'],
  ];
  for(const [text,date,time] of cases){
    assert.deepEqual(evidencedOverlayTimestamp(`${text}\n${GPS}`,null,null),{photoDate:date,photoTime:time,evidence:'EVIDENCED'},text);
    assert.equal(evidencedOverlayTimestamp(`${text}\n${GPS}`,date,time).evidence,'EVIDENCED',`${text}: agreeing model fields`);
  }
});

test('evidencedOverlayTimestamp gives a fixed reason and no timestamp whenever evidence is missing or conflicting',()=>{
  const t=(raw,d,tm)=>evidencedOverlayTimestamp(raw,d,tm);
  assert.deepEqual(t(ADDRESS,'2026-11-23','09:12'),{photoDate:null,photoTime:null,evidence:'NO_OVERLAY_TIMESTAMP'});
  assert.equal(t('',null,null).evidence,'NO_OVERLAY_TIMESTAMP');
  assert.equal(t('10:12 11 23',null,null).evidence,'NO_OVERLAY_TIMESTAMP','wall-clock digits without a year do not parse');
  assert.equal(t(`${STAMP} 10:12`,null,null).evidence,'AMBIGUOUS_OVERLAY_TIMES');
  assert.equal(t(`${STAMP} 9:12:02`,null,null).evidence,'EVIDENCED','the same time written twice is not ambiguous');
  assert.equal(t('23 Nov 2026 09:12 and 9:12 PM',null,null).evidence,'AMBIGUOUS_OVERLAY_TIMES','AM/PM is applied before times are compared');
  assert.equal(t('23 Nov 2026 9:12 PM and 09:12',null,null).evidence,'AMBIGUOUS_OVERLAY_TIMES','the conflict is found whichever time comes first');
  assert.equal(t('23 Nov 2026 9:12 PM 21:12',null,null).evidence,'EVIDENCED','the same time in 12-hour and 24-hour form agrees');
  assert.equal(t('23 Nov 2026 12:30 AM 00:30',null,null).evidence,'EVIDENCED','12 AM is 00');
  assert.equal(t('23 Nov 2026 9:12 Amphoe Mueang',null,null).evidence,'EVIDENCED','a word starting with "am" is not a marker');
  assert.equal(t(`${STAMP}\n22 Nov BE 2569 at 09:12:02`,null,null).evidence,'AMBIGUOUS_OVERLAY_DATES','a second date at the same time is not dropped');
  assert.equal(t(`22 Nov BE 2569 at 09:12:02\n${STAMP}`,'2026-11-22','09:12:02').evidence,'AMBIGUOUS_OVERLAY_DATES','model agreeing with one of two dates is not enough');
  assert.equal(t(`2026/11/22 09:12:02\n${STAMP}`,null,null).evidence,'AMBIGUOUS_OVERLAY_DATES','the parser format priority does not hide a date in another format');
  assert.equal(t(`${STAMP}\n2569-11-23 9:12:02`,null,null).evidence,'EVIDENCED','the same date and time in another format is not ambiguous');
  assert.equal(t(`${STAMP}\nPrinted 22 Nov 2569`,null,null).evidence,'EVIDENCED','boundary: a date without its own time is not a second timestamp');
  assert.equal(t(STAMP,'2026-11-24','09:12:02').evidence,'MODEL_DATE_DIFFERS');
  assert.equal(t(STAMP,'2026-11-23','09:20').evidence,'MODEL_TIME_DIFFERS');
  assert.equal(t(STAMP,'2026-11-23','09:12:03').evidence,'MODEL_TIME_DIFFERS');
  assert.equal(t(STAMP,'2026-11-23','9:12').evidence,'EVIDENCED','HH:mm agreement without seconds is enough');
  assert.equal(t(STAMP,'2026-11-23','not a time').evidence,'MODEL_TIME_DIFFERS');
  assert.equal(t('31 Feb 2026 09:12',null,null).evidence,'NO_OVERLAY_TIMESTAMP','an impossible date is not repaired');
  for(const text of ['123 Nov 2026 09:12','Xnov 23, 2026 09:12','12026/11/23 09:12','123/11/2026 09:12','23 Nov 2026 09:123','23 Nov 2026 09:12:345','2026/11/234 09:12'])
    assert.equal(t(text,null,null).evidence,'NO_OVERLAY_TIMESTAMP',`${text}: part of a longer token is not a date or time`);
  for(const text of ['23 Nov 2026 0:30 AM','23 Nov 2026 00:30 AM','23 Nov 2026 13:00 PM','23 Nov 2026 21:12 AM','23 Nov 2026 21:12 PM'])
    assert.equal(t(text,null,null).evidence,'NO_OVERLAY_TIMESTAMP',`${text}: hour outside 1-12 with a marker`);
  assert.deepEqual(t('23 Nov 2026 12:30 AM',null,null),{photoDate:'2026-11-23',photoTime:'00:30',evidence:'EVIDENCED'},'12 AM is 00');
  assert.deepEqual(t('23 Nov 2026 12:30 PM',null,null),{photoDate:'2026-11-23',photoTime:'12:30',evidence:'EVIDENCED'},'12 PM is 12');
  assert.deepEqual(t('23 Nov 2026 9:12 P.M.',null,null),{photoDate:'2026-11-23',photoTime:'09:12',evidence:'EVIDENCED'},'boundary: a malformed marker is not a marker (photo age and model agreement still apply)');
  assert.deepEqual(t(`${STAMP}\n09:12`,null,null),{photoDate:'2026-11-23',photoTime:'09:12:02',evidence:'EVIDENCED'},'HH:mm:ss and HH:mm of one minute agree');
  assert.deepEqual(t('23 Nov 2026 09:12\n09:12:02','2026-11-23','09:12:02'),{photoDate:'2026-11-23',photoTime:'09:12:02',evidence:'EVIDENCED'},'seconds come from the token that shows them');
  assert.equal(t('23 Nov 2026 09:12\n09:12:02','2026-11-23','09:12:40').evidence,'MODEL_TIME_DIFFERS','model seconds must match the seconds shown');
  assert.equal(t(`${STAMP}\n09:12:40`,null,null).evidence,'AMBIGUOUS_OVERLAY_TIMES','two different seconds values are ambiguous');
});
