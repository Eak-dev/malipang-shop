import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Two explicit fixture sources:
//  - default: tests/fixtures/clock-photos/cases.json (unchanged legacy contract);
//  - private: MALIPANG_CLOCK_PRIVATE_MANIFEST points to a manifest OUTSIDE Git.
// When the variable is set the private source is used exclusively; there is no
// silent fallback to cases.json. Private values (timestamps, GPS, paths, read
// errors) must never reach assertion messages or diagnostics: every failure
// below uses fixed, boolean-based messages (assert.ok with a literal message).
const selfPath=fileURLToPath(import.meta.url);
const fixtureDir=path.join(path.dirname(selfPath),'fixtures','clock-photos');
const isChild=process.env.CLOCK_FIXTURE_CHILD==='1';
const ok=(condition,message)=>assert.ok(Boolean(condition),message);

// The compiled validator lives in the ignored dist/ folder. `npm run test:clock-photos` does not
// build, so a clean checkout has no dist: load it lazily (only the synthetic tests need it) and, if
// missing, run the project's own local compile (`npm run build:test`; no network, no live call).
let validatorPromise;
function loadValidator(){
  validatorPromise??=(async()=>{
    const url=new URL('../dist/domain/attendance.js',import.meta.url).href;
    try{return (await import(url)).validateAttendancePhoto;}catch{/* dist missing: build below */}
    const run=spawnSync('npm',['run','build:test'],{cwd:path.join(path.dirname(selfPath),'..'),env:{PATH:process.env.PATH,HOME:process.env.HOME},encoding:'utf8',timeout:600000});
    ok(run.status===0,'local build of the compiled validator failed');
    return (await import(`${url}?built=1`)).validateAttendancePhoto;
  })();
  return validatorPromise;
}

// Owner-stated expectations, fixed in code so a manifest cannot drift toward system output.
const OWNER_EXPECTED={'photo-01':'pass','photo-02':'pass','photo-03':'pass','photo-04':'pass','photo-05':'pass','photo-06':'reject','photo-07':'reject'};
// Validation order from src/domain/attendance.ts: a reading without date/time must stop at or before this code.
const PRE_GPS_CODES=['NOT_CLOCK','CLOCK_NOT_CONFIRMED','TIMESTAMP_MISSING','TIMESTAMP_NOT_WHITE','TIMESTAMP_FIELDS_MISSING'];
const ISO_WITH_ZONE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
const isEmptyText=value=>value==null||value==='';
// Providers that actually read the photo. 'none' and 'openai-error' (src/vision/service.ts failedVision) are failures even when HTTP is 200.
const SUCCESS_PROVIDERS=['openai','workers-ai'];
// Allowlist for diagnostics only; any other identifier is masked.
const DIAGNOSTIC_PROVIDERS=['openai','workers-ai','pipeline','none','openai-error'];
// Thresholds mirror the validator defaults (ATTENDANCE_CLOCK_MIN_CONFIDENCE).
const CLOCK_MIN_CONFIDENCE=0.7;
// The single code src/domain/attendance.ts:51-55 returns for a reading that has no date/time.
function expectedRejectCode(reading){
  if(reading.kind!=='CLOCK')return 'NOT_CLOCK';
  if(reading.clockPresent!==true||reading.clockConfidence<CLOCK_MIN_CONFIDENCE)return 'CLOCK_NOT_CONFIRMED';
  if(!reading.overlayPresent)return 'TIMESTAMP_MISSING';
  if(!reading.overlayTextWhite)return 'TIMESTAMP_NOT_WHITE';
  return 'TIMESTAMP_FIELDS_MISSING';
}

async function loadPrivateManifest(manifestPath){
  const fail=code=>({ok:false,code});
  if(typeof manifestPath!=='string'||!manifestPath.trim())return fail('MANIFEST_PATH_EMPTY');
  const manifestFile=path.resolve(manifestPath),dir=path.dirname(manifestFile);
  let text;try{text=await readFile(manifestFile,'utf8');}catch{return fail('MANIFEST_UNREADABLE');}
  let manifest;try{manifest=JSON.parse(text);}catch{return fail('MANIFEST_NOT_JSON');}
  if(!manifest||!Array.isArray(manifest.cases))return fail('MANIFEST_SHAPE_INVALID');
  if(manifest.cases.length!==7)return fail('MANIFEST_CASE_COUNT');
  const ids=manifest.cases.map(item=>item&&item.id);
  if(new Set(ids).size!==7||!ids.every(id=>typeof id==='string'&&Object.hasOwn(OWNER_EXPECTED,id)))return fail('MANIFEST_IDS_INVALID');
  const cases=[],seenHashes=new Set();
  let realDir;try{realDir=await realpath(dir);}catch{return fail('MANIFEST_UNREADABLE');}
  for(const item of manifest.cases){
    if(item.ownerExpected!==OWNER_EXPECTED[item.id])return fail('MANIFEST_OWNER_EXPECTED_MISMATCH');
    if(typeof item.receivedAt!=='string'||!ISO_WITH_ZONE.test(item.receivedAt)||!Number.isFinite(new Date(item.receivedAt).getTime()))return fail('MANIFEST_RECEIVED_AT_INVALID');
    if(typeof item.file!=='string'||!item.file||path.isAbsolute(item.file))return fail('MANIFEST_IMAGE_PATH_INVALID');
    const imagePath=path.resolve(dir,item.file),relative=path.relative(dir,imagePath);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return fail('MANIFEST_IMAGE_PATH_INVALID');
    if(typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256))return fail('MANIFEST_HASH_INVALID');
    // Seven different photos: the same bytes under another name must not stand in for a second photo.
    if(seenHashes.has(item.sha256))return fail('MANIFEST_DUPLICATE_SHA256');
    seenHashes.add(item.sha256);
    let expectedReading=null;
    if(item.ownerExpected==='reject'){
      if(item.expectedReading!=null)return fail('MANIFEST_REJECT_HAS_READING');
    }else if(item.readingVerified===true){
      const reading=item.expectedReading;
      if(!reading||!/^\d{4}-\d{2}-\d{2}$/.test(reading.photoDate)||!/^\d{2}:\d{2}(?::\d{2})?$/.test(reading.photoTime)||!Number.isFinite(reading.latitude)||!Number.isFinite(reading.longitude))return fail('MANIFEST_EXPECTED_READING_INVALID');
      expectedReading={photoDate:reading.photoDate,photoTime:reading.photoTime,latitude:reading.latitude,longitude:reading.longitude};
    }
    // Resolve symlinks (file or directory): the real image must stay inside the real manifest directory.
    let realImage;try{realImage=await realpath(imagePath);}catch{return fail('IMAGE_UNREADABLE');}
    const realRelative=path.relative(realDir,realImage);
    if(!realRelative||realRelative.startsWith('..')||path.isAbsolute(realRelative))return fail('MANIFEST_IMAGE_PATH_ESCAPES');
    let image;try{image=await readFile(realImage);}catch{return fail('IMAGE_UNREADABLE');}
    if(image.length<3||image[0]!==0xff||image[1]!==0xd8)return fail('IMAGE_NOT_JPEG');
    if(sha256(image)!==item.sha256)return fail('IMAGE_HASH_MISMATCH');
    // readingVerified stays false until an independent reviewer compares the values with the photo.
    cases.push({id:item.id,mode:'private',image,receivedAt:item.receivedAt,ownerExpected:item.ownerExpected,readingVerified:item.readingVerified===true,expectedReading});
  }
  return{ok:true,cases};
}

const manifestEnv=process.env.MALIPANG_CLOCK_PRIVATE_MANIFEST;
const privateMode=manifestEnv!==undefined;
let loaded;
if(privateMode){loaded=await loadPrivateManifest(manifestEnv);}
else{
  const legacy=JSON.parse(await readFile(path.join(fixtureDir,'cases.json'),'utf8'));
  const images=await Promise.all(legacy.map(async item=>{try{return await readFile(path.join(fixtureDir,item.file));}catch{return null;}}));
  loaded={ok:true,cases:legacy.map((item,index)=>({id:item.id,mode:'legacy',image:images[index],receivedAt:item.receivedAt,expected:item.expected}))};
}
const cases=loaded.ok?loaded.cases:[];

// Pure checkers: assertion messages are fixed text and never include actual/expected values.
function checkPrivateReading(item,result){
  const reading=result&&result.reading,validation=result&&result.validation;
  ok(reading&&validation,`${item.id}: response shape`);
  const timestampPresent=!isEmptyText(reading.photoDate)&&!isEmptyText(reading.photoTime);
  const gpsPresent=reading.latitude!=null&&reading.longitude!=null;
  const code=String(validation.validationCode);
  // A HTTP 200 whose provider is 'none' or 'openai-error' is a failed read, never a valid reading.
  ok(SUCCESS_PROVIDERS.includes(reading.provider),`${item.id}: provider did not read the photo`);
  if(item.ownerExpected==='pass'){
    ok(validation.ok===true,`${item.id}: owner expects accepted`);
    ok(code==='OK',`${item.id}: owner expects validation OK`);
    ok(reading.kind==='CLOCK'&&reading.clockPresent===true&&reading.overlayPresent===true&&reading.overlayTextWhite===true,`${item.id}: clock and white overlay required`);
    ok(timestampPresent&&gpsPresent,`${item.id}: timestamp and GPS required`);
    if(item.readingVerified&&item.expectedReading){
      const want=item.expectedReading;
      ok(reading.photoDate===want.photoDate,`${item.id}: verified date matches`);
      ok(reading.photoTime===want.photoTime,`${item.id}: verified time matches`);
      ok(Math.abs(reading.latitude-want.latitude)<0.00001&&Math.abs(reading.longitude-want.longitude)<0.00001,`${item.id}: verified GPS matches`);
    }
  }else{
    ok(validation.ok===false,`${item.id}: owner expects rejection`);
    ok(code!=='OK',`${item.id}: rejection code present`);
    // Nothing may be fabricated for a photo without these overlay fields.
    ok(isEmptyText(reading.photoDate)&&isEmptyText(reading.photoTime),`${item.id}: no date or time may be invented`);
    // Each axis is checked on its own: a single invented coordinate is also fabricated data.
    ok(reading.latitude==null,`${item.id}: no latitude may be invented`);
    ok(reading.longitude==null,`${item.id}: no longitude may be invented`);
    // Without date/time the validator stops at or before TIMESTAMP_FIELDS_MISSING, so GPS_MISSING would contradict the reading.
    ok(PRE_GPS_CODES.includes(code),`${item.id}: rejection code consistent with validation order`);
    // The code must be exactly the first failing predicate of this reading, not merely a pre-GPS code.
    ok(code===expectedRejectCode(reading),`${item.id}: rejection code matches first failing check of the reading`);
  }
}

function checkLegacyReading(item,result){
  const reading=result&&result.reading,validation=result&&result.validation,want=item.expected;
  ok(reading&&validation,`${item.id}: response shape`);
  ok(reading.kind===want.kind,`${item.id}: kind`);
  ok(reading.photoDate===want.photoDate,`${item.id}: photo date`);
  ok(reading.photoTime===want.photoTime,`${item.id}: photo time`);
  ok(reading.clockPresent===true&&reading.overlayPresent===true&&reading.overlayTextWhite===true,`${item.id}: clock and white overlay`);
  if(want.latitude==null)ok(reading.latitude===null&&reading.longitude===null,`${item.id}: GPS absent`);
  else ok(Math.abs(reading.latitude-want.latitude)<0.00001&&Math.abs(reading.longitude-want.longitude)<0.00001,`${item.id}: GPS`);
  ok(validation.ok===want.accepted,`${item.id}: acceptance`);
  ok(validation.validationCode===want.validationCode,`${item.id}: validation code`);
}

// Allowlisted, non-identifying diagnostics only: no timestamp, GPS, address, path or text.
function diagnosticFor(item,result){
  const reading=result.reading||{},validation=result.validation||{};
  const code=/^[A-Z_]{1,40}$/.test(String(validation.validationCode))?validation.validationCode:'UNRECOGNISED';
  const provider=DIAGNOSTIC_PROVIDERS.includes(reading.provider)?reading.provider:'unrecognised';
  return{id:item.id,provider,accepted:validation.ok===true,validationCode:code,clockPresent:reading.clockPresent===true,overlayPresent:reading.overlayPresent===true,timestampPresent:!isEmptyText(reading.photoDate)&&!isEmptyText(reading.photoTime),gpsPresent:reading.latitude!=null&&reading.longitude!=null};
}

test('clock photo fixture contract contains the seven supplied photos',async()=>{
  ok(loaded.ok,`private manifest rejected: ${loaded.ok?'':loaded.code}`);
  ok(cases.length===7,'seven cases required');
  ok(new Set(cases.map(item=>item.id)).size===7,'case ids must be unique');
  for(const item of cases){
    if(item.mode==='private'){
      ok(item.image.length>0&&item.image[0]===0xff&&item.image[1]===0xd8,`${item.id}: JPEG image required`);
      ok(Number.isFinite(new Date(item.receivedAt).getTime()),`${item.id}: receivedAt`);
      continue;
    }
    if(item.image){
      ok(item.image.length>0,`${item.id}: image is empty`);
      ok(item.image[0]===0xff&&item.image[1]===0xd8,`${item.id}: not a JPEG`);
    }
    const want=item.expected;
    ok(want.kind==='CLOCK',`${item.id}: kind`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(want.photoDate),`${item.id}: photoDate format`);
    ok(/^\d{2}:\d{2}(?::\d{2})?$/.test(want.photoTime),`${item.id}: photoTime format`);
    ok(typeof want.accepted==='boolean',`${item.id}: accepted flag`);
    if(want.accepted)ok(Number.isFinite(want.latitude)&&Number.isFinite(want.longitude),`${item.id}: GPS for accepted case`);
    ok(Number.isFinite(new Date(item.receivedAt).getTime()),`${item.id}: receivedAt`);
  }
});

const baseUrl=String(process.env.MALIPANG_VISION_BASE_URL||'').replace(/\/$/,'');
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
const provider=process.env.MALIPANG_VISION_PROVIDER||'openai';
const openAIModel=process.env.MALIPANG_OPENAI_MODEL||'';
const selectedIds=new Set(String(process.env.MALIPANG_CLOCK_CASES||'').split(',').map(value=>value.trim()).filter(Boolean));
const selectedCases=selectedIds.size?cases.filter(item=>selectedIds.has(item.id)):cases;

// Live: needs an explicitly provided, authorised test endpoint. No default URL exists.
test('live vision enforces white timestamp, GPS, and shop-clock evidence',async t=>{
  ok(loaded.ok,`private manifest rejected: ${loaded.ok?'':loaded.code}`);
  ok(baseUrl,'MALIPANG_VISION_BASE_URL is required');
  ok(tokenFile,'MALIPANG_ADMIN_TOKEN_FILE is required');
  ok(cases.length===7&&cases.every(item=>item.image),'all seven clock fixture images are required');
  ok(selectedCases.length===cases.length,'all seven clock cases must be selected');
  ok(['pipeline','openai','workers-ai'].includes(provider),'provider must be pipeline, openai, or workers-ai');
  let adminToken='';
  try{adminToken=(await readFile(tokenFile,'utf8')).trim();}catch{ok(false,'admin token file is unreadable');}
  ok(adminToken.length>=32,'admin token is missing or too short');

  for(const item of selectedCases){
    await t.test(item.id,async t=>{
      const modelQuery=openAIModel?`&model=${encodeURIComponent(openAIModel)}`:'';
      const url=`${baseUrl}/admin/vision/evaluate?provider=${encodeURIComponent(provider)}&receivedAt=${encodeURIComponent(item.receivedAt)}${modelQuery}`;
      let response,result;
      try{response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${adminToken}`,'content-type':'image/jpeg'},body:item.image});}
      catch{ok(false,`${item.id}: evaluation request failed`);}
      try{result=await response.json();}catch{ok(false,`${item.id}: HTTP ${response.status} non-JSON response`);}
      ok(response.ok===true,`${item.id}: HTTP ${response.status}`);
      ok(result&&result.ok===true,`${item.id}: endpoint failed`);
      if(item.mode==='private')checkPrivateReading(item,result);else checkLegacyReading(item,result);
      t.diagnostic(JSON.stringify(diagnosticFor(item,result)));
    });
  }
});

// ---- Synthetic, local only: no photos, no network, no provider. These are NOT live results. ----
const syntheticRules={storeLat:13,storeLng:100,allowedRadiusM:120,maxPhotoAgeMin:3,overlayMinConfidence:0.9,clockMinConfidence:0.7};
const syntheticReading=overrides=>({kind:'CLOCK',clockPresent:true,clockConfidence:0.99,overlayPresent:true,overlayTextWhite:true,overlayConfidence:0.99,photoDate:'2000-01-02',photoTime:'03:04:05',latitude:13,longitude:100,locationText:'synthetic place',note:'',...overrides});
const syntheticReceived='2000-01-01T20:04:10.000Z'; // 03:04:10 at +07:00, 5 s after the synthetic photo

test('synthetic validator order: reading without date/time never reaches GPS_MISSING',async()=>{
  const validateAttendancePhoto=await loadValidator();
  const noFields={photoDate:null,photoTime:null,latitude:null,longitude:null};
  const steps=[
    [{kind:'OTHER'},'NOT_CLOCK'],
    [{clockPresent:false},'CLOCK_NOT_CONFIRMED'],
    [{clockConfidence:0.1},'CLOCK_NOT_CONFIRMED'],
    [{overlayPresent:false,...noFields},'TIMESTAMP_MISSING'],
    [{overlayTextWhite:false,...noFields},'TIMESTAMP_NOT_WHITE'],
    [noFields,'TIMESTAMP_FIELDS_MISSING'],
    [{photoDate:'',photoTime:'',latitude:null,longitude:null},'TIMESTAMP_FIELDS_MISSING']
  ];
  for(const [overrides,expected] of steps){
    const result=validateAttendancePhoto(syntheticReading(overrides),syntheticReceived,syntheticRules);
    ok(result.ok===false&&result.validationCode===expected,'synthetic: first failing check follows documented order');
    ok(result.validationCode!=='GPS_MISSING','synthetic: GPS_MISSING must not precede timestamp checks');
    ok(PRE_GPS_CODES.includes(result.validationCode),'synthetic: code belongs to pre-GPS group');
  }
});

test('synthetic validator: GPS_MISSING only when date and time are present',async()=>{
  const validateAttendancePhoto=await loadValidator();
  const missingGps=validateAttendancePhoto(syntheticReading({latitude:null,longitude:null}),syntheticReceived,syntheticRules);
  ok(missingGps.ok===false&&missingGps.validationCode==='GPS_MISSING','synthetic: timestamp present, GPS absent');
  ok(!PRE_GPS_CODES.includes(missingGps.validationCode),'synthetic: GPS_MISSING is outside the pre-GPS group');
  const complete=validateAttendancePhoto(syntheticReading({}),syntheticReceived,syntheticRules);
  ok(complete.ok===true&&complete.validationCode==='OK','synthetic: complete reading accepted');
});

const rejectReading=overrides=>({provider:'openai',kind:'CLOCK',clockPresent:true,clockConfidence:0.99,overlayPresent:false,overlayTextWhite:false,photoDate:null,photoTime:null,latitude:null,longitude:null,...overrides});
const rejectResult=(code,readingOverrides)=>({reading:rejectReading(readingOverrides),validation:{ok:false,validationCode:code}});
const failsSanitized=(item,result,message)=>{
  let error;try{checkPrivateReading(item,result);}catch(caught){error=caught;}
  ok(error instanceof assert.AssertionError,message);
  ok(!String(error.message).includes('SECRET')&&!String(error.stack).includes('SECRET'),'synthetic: failure text must not carry reading values');
  ok(error.actual===false&&error.expected===true,'synthetic: failure carries booleans only');
};

test('synthetic private-case checkers: reject case rules and sanitized failures',()=>{
  const rejectItem={id:'photo-06',ownerExpected:'reject'};
  checkPrivateReading(rejectItem,rejectResult('TIMESTAMP_MISSING',{photoTime:''}));
  const marker='SECRET-2000-01-02 03:04:05 13.123456,100.654321 /private/path';
  const bad=[
    rejectResult('GPS_MISSING',{photoDate:marker,photoTime:marker,overlayPresent:true,overlayTextWhite:true}),
    rejectResult('TIMESTAMP_MISSING',{latitude:13.123456,longitude:100.654321}),
    // One axis only: an AND-style "GPS present" test would wrongly accept these.
    rejectResult('TIMESTAMP_MISSING',{latitude:13.123456}),
    rejectResult('TIMESTAMP_MISSING',{longitude:100.654321}),
    rejectResult('TIMESTAMP_MISSING',{latitude:0}),
    rejectResult('TIMESTAMP_MISSING',{longitude:0}),
    rejectResult('GPS_MISSING',{}),
    {reading:rejectReading({}),validation:{ok:true,validationCode:'OK'}}
  ];
  for(const result of bad)failsSanitized(rejectItem,result,'synthetic: bad reject case must fail');
});

test('synthetic reject case: provider none/openai-error is a failed read even with HTTP 200 and a plausible code',()=>{
  const rejectItem={id:'photo-07',ownerExpected:'reject'};
  for(const failed of ['none','openai-error']){
    // These are the shapes src/vision/service.ts failedVision() returns: UNKNOWN, no overlay, no clock.
    const failedRead={reading:rejectReading({provider:failed,kind:'UNKNOWN',clockPresent:null,clockConfidence:0}),validation:{ok:false,validationCode:'NOT_CLOCK'}};
    failsSanitized(rejectItem,failedRead,`synthetic: provider ${failed} must not count as a successful read`);
    // Even a reading that is otherwise perfectly consistent is refused for these providers.
    failsSanitized(rejectItem,rejectResult('TIMESTAMP_MISSING',{provider:failed}),`synthetic: consistent reading from ${failed} must still fail`);
  }
  checkPrivateReading(rejectItem,rejectResult('TIMESTAMP_MISSING',{provider:'workers-ai'}));
});

test('synthetic reject case: validationCode must equal the first failing predicate of the reading',async()=>{
  const validateAttendancePhoto=await loadValidator();
  const rejectItem={id:'photo-06',ownerExpected:'reject'};
  // Cross-check the test oracle against the real validator on readings with no date/time.
  const readings=[
    {kind:'UNKNOWN'},{kind:'OTHER',clockPresent:true},{clockPresent:null},{clockPresent:false},{clockConfidence:0.1},
    {overlayPresent:false},{overlayPresent:true,overlayTextWhite:false},{overlayPresent:true,overlayTextWhite:true},{overlayPresent:true,overlayTextWhite:true,photoDate:'',photoTime:''}
  ];
  const seen=new Set();
  for(const overrides of readings){
    const reading=rejectReading(overrides);
    const real=validateAttendancePhoto({...reading,overlayConfidence:0.99,locationText:'synthetic place',note:''},syntheticReceived,syntheticRules);
    ok(real.validationCode===expectedRejectCode(reading),'synthetic: oracle equals the real validator');
    checkPrivateReading(rejectItem,{reading,validation:{ok:false,validationCode:real.validationCode}});
    seen.add(real.validationCode);
  }
  ok(PRE_GPS_CODES.every(code=>seen.has(code)),'synthetic: every pre-GPS code was exercised');
  // Mismatches that stay inside the pre-GPS group must still fail.
  failsSanitized(rejectItem,{reading:rejectReading({kind:'UNKNOWN'}),validation:{ok:false,validationCode:'TIMESTAMP_FIELDS_MISSING'}},'synthetic: UNKNOWN kind with TIMESTAMP_FIELDS_MISSING must fail');
  failsSanitized(rejectItem,rejectResult('TIMESTAMP_FIELDS_MISSING',{}),'synthetic: no overlay with TIMESTAMP_FIELDS_MISSING must fail');
  failsSanitized(rejectItem,rejectResult('TIMESTAMP_MISSING',{overlayPresent:true,overlayTextWhite:true}),'synthetic: overlay present with TIMESTAMP_MISSING must fail');
  failsSanitized(rejectItem,rejectResult('TIMESTAMP_NOT_WHITE',{overlayPresent:true,overlayTextWhite:true}),'synthetic: white overlay with TIMESTAMP_NOT_WHITE must fail');
  failsSanitized(rejectItem,rejectResult('CLOCK_NOT_CONFIRMED',{}),'synthetic: confirmed clock with CLOCK_NOT_CONFIRMED must fail');
});

test('synthetic pass-case checker: verified values compared, provisional values not, failures sanitized',()=>{
  const marker='SECRET-2000-01-02 03:04:05 13.123456,100.654321 /private/path';
  const passItem={id:'photo-01',ownerExpected:'pass',readingVerified:true,expectedReading:{photoDate:'2000-01-02',photoTime:'03:04:05',latitude:13,longitude:100}};
  const passResult={reading:{provider:'openai',kind:'CLOCK',clockPresent:true,overlayPresent:true,overlayTextWhite:true,photoDate:marker,photoTime:'03:04:05',latitude:13,longitude:100},validation:{ok:true,validationCode:'OK'}};
  failsSanitized(passItem,passResult,'synthetic: mismatch of a verified value must fail');
  // An unverified (provisional) reading is not compared with provider output.
  checkPrivateReading({...passItem,readingVerified:false,expectedReading:null},{...passResult,reading:{...passResult.reading,photoDate:'2000-01-09'}});
  failsSanitized({...passItem,readingVerified:false,expectedReading:null},{...passResult,reading:{...passResult.reading,photoDate:'2000-01-09',provider:'none'}},'synthetic: failed provider must not pass a pass case');
});

test('synthetic diagnostics carry only allowlisted non-identifying fields',()=>{
  const marker='SECRET-2000-01-02 03:04:05 13.123456,100.654321';
  const out=diagnosticFor({id:'photo-01'},{reading:{provider:'openai',clockPresent:true,overlayPresent:true,photoDate:marker,photoTime:marker,latitude:13.123456,longitude:100.654321,locationText:marker,overlayRawText:marker},validation:{ok:true,validationCode:'OK'}});
  const text=JSON.stringify(out);
  ok(!text.includes('SECRET')&&!/\d{4}-\d{2}-\d{2}/.test(text)&&!/\d+\.\d{4,}/.test(text),'synthetic: diagnostics contain no date, time or GPS');
  ok(JSON.stringify(Object.keys(out).sort())===JSON.stringify(['accepted','clockPresent','gpsPresent','id','overlayPresent','provider','timestampPresent','validationCode']),'synthetic: diagnostics keys are allowlisted');
  ok(diagnosticFor({id:'photo-01'},{reading:{provider:marker},validation:{validationCode:marker}}).validationCode==='UNRECOGNISED','synthetic: unrecognised code is masked');
  // An identifier that satisfies the former generic regex (^[a-z0-9-]{1,30}$) is still masked: only enum values pass.
  const looksHarmless='secret-room-42';
  ok(/^[a-z0-9-]{1,30}$/.test(looksHarmless),'synthetic: the identifier would have passed the former regex');
  const masked=diagnosticFor({id:'photo-01'},{reading:{provider:looksHarmless},validation:{ok:true,validationCode:'OK'}});
  ok(masked.provider==='unrecognised'&&!JSON.stringify(masked).includes('secret'),'synthetic: unlisted provider identifier does not leak');
  for(const allowed of DIAGNOSTIC_PROVIDERS)ok(diagnosticFor({id:'photo-01'},{reading:{provider:allowed},validation:{}}).provider===allowed,'synthetic: enum provider is kept');
});

// Builds a synthetic manifest (fake JPEG bytes only) under root/SECRETDIR; the marker in the
// directory name lets tests prove that paths never appear in output.
async function syntheticManifest(root,{mutate,omitImage}={}){
  const dir=path.join(root,'SECRETDIR');await mkdir(dir,{recursive:true});
  const entries=[];
  for(const id of Object.keys(OWNER_EXPECTED)){
    const image=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.from(`synthetic-${id}`)]);
    const file=`${id}.jpg`;
    if(omitImage!==id)await writeFile(path.join(dir,file),image);
    entries.push({id,file,sha256:sha256(image),receivedAt:'2000-01-01T20:04:10.000Z',ownerExpected:OWNER_EXPECTED[id]});
  }
  const manifest={cases:entries};
  if(mutate)mutate(manifest);
  const manifestPath=path.join(dir,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest));
  return manifestPath;
}

test('synthetic private manifest: valid manifest loads, every defect fails closed without cases.json fallback',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'clock-fixture-'));
  try{
    const sub=name=>path.join(root,name);
    const valid=await loadPrivateManifest(await syntheticManifest(sub('a')));
    ok(valid.ok&&valid.cases.length===7,'synthetic: valid manifest loads');
    const overwrite=async(name,content)=>{const p=await syntheticManifest(sub(name));await writeFile(p,content);return p;};
    const defects=[
      ['MANIFEST_PATH_EMPTY',async()=>''],
      ['MANIFEST_UNREADABLE',async()=>path.join(root,'SECRETDIR','missing.json')],
      ['MANIFEST_NOT_JSON',()=>overwrite('b','{SECRET not json')],
      ['MANIFEST_SHAPE_INVALID',()=>overwrite('c','{"cases":"x"}')],
      ['MANIFEST_CASE_COUNT',()=>syntheticManifest(sub('d'),{mutate:m=>m.cases.pop()})],
      ['MANIFEST_IDS_INVALID',()=>syntheticManifest(sub('e'),{mutate:m=>{m.cases[1].id=m.cases[0].id;}})],
      ['MANIFEST_OWNER_EXPECTED_MISMATCH',()=>syntheticManifest(sub('f'),{mutate:m=>{m.cases[5].ownerExpected='pass';}})],
      ['MANIFEST_RECEIVED_AT_INVALID',()=>syntheticManifest(sub('g'),{mutate:m=>{m.cases[0].receivedAt='2000-01-01 03:04:10';}})],
      ['MANIFEST_IMAGE_PATH_INVALID',()=>syntheticManifest(sub('h'),{mutate:m=>{m.cases[0].file='../escape.jpg';}})],
      ['MANIFEST_REJECT_HAS_READING',()=>syntheticManifest(sub('i'),{mutate:m=>{m.cases[6].expectedReading={photoDate:'2000-01-02'};}})],
      ['MANIFEST_EXPECTED_READING_INVALID',()=>syntheticManifest(sub('j'),{mutate:m=>{m.cases[0].readingVerified=true;}})],
      ['IMAGE_UNREADABLE',()=>syntheticManifest(sub('k'),{omitImage:'photo-03'})],
      ['IMAGE_HASH_MISMATCH',()=>syntheticManifest(sub('l'),{mutate:m=>{m.cases[2].sha256='0'.repeat(64);}})],
      ['MANIFEST_HASH_INVALID',()=>syntheticManifest(sub('m'),{mutate:m=>{m.cases[2].sha256='xyz';}})]
    ];
    for(const [code,build] of defects){
      const result=await loadPrivateManifest(await build());
      ok(result.ok===false&&result.code===code,`synthetic: defect ${code} must fail closed`);
      ok(!('cases' in result),`synthetic: defect ${code} returns no cases`);
    }
    const notJpeg=await syntheticManifest(sub('n'));
    await writeFile(path.join(path.dirname(notJpeg),'photo-02.jpg'),Buffer.from('plain'));
    ok((await loadPrivateManifest(notJpeg)).code==='IMAGE_NOT_JPEG','synthetic: non-JPEG fails');
  }finally{await rm(root,{recursive:true,force:true});}
});

const syntheticImage=id=>Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.from(`synthetic-${id}`)]);
async function rewriteManifest(manifestPath,change){
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));change(manifest);
  await writeFile(manifestPath,JSON.stringify(manifest));
}

test('synthetic private manifest: seven SHA-256 values must be distinct even under different file names',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'clock-fixture-'));
  try{
    // Same bytes under two names, declared hash correct for both.
    const same=await syntheticManifest(path.join(root,'a'));
    await writeFile(path.join(path.dirname(same),'photo-02.jpg'),syntheticImage('photo-01'));
    await rewriteManifest(same,m=>{m.cases[1].sha256=m.cases[0].sha256;});
    const sameResult=await loadPrivateManifest(same);
    ok(sameResult.ok===false&&sameResult.code==='MANIFEST_DUPLICATE_SHA256','synthetic: identical bytes under another name are rejected');
    ok(!('cases' in sameResult),'synthetic: duplicate returns no cases');
    // Declared hash repeated although bytes differ is rejected too.
    const declared=await syntheticManifest(path.join(root,'b'),{mutate:m=>{m.cases[4].sha256=m.cases[3].sha256;}});
    ok((await loadPrivateManifest(declared)).code==='MANIFEST_DUPLICATE_SHA256','synthetic: repeated declared hash is rejected');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('synthetic private manifest: symlinked file or directory outside the manifest directory is refused without leaking paths',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'clock-fixture-'));
  try{
    const outside=path.join(root,'OUTSIDE');await mkdir(outside,{recursive:true});
    await writeFile(path.join(outside,'x.jpg'),syntheticImage('photo-03')); // bytes match the declared hash, so only the path check can reject it

    const fileLink=await syntheticManifest(path.join(root,'f'));
    await rm(path.join(path.dirname(fileLink),'photo-03.jpg'));
    await symlink(path.join(outside,'x.jpg'),path.join(path.dirname(fileLink),'photo-03.jpg'));
    const fileResult=await loadPrivateManifest(fileLink);

    const dirLink=await syntheticManifest(path.join(root,'d'));
    await symlink(outside,path.join(path.dirname(dirLink),'linkdir'));
    await rewriteManifest(dirLink,m=>{m.cases[2].file='linkdir/x.jpg';});
    const dirResult=await loadPrivateManifest(dirLink);

    for(const result of [fileResult,dirResult]){
      ok(result.ok===false&&result.code==='MANIFEST_IMAGE_PATH_ESCAPES','synthetic: escaping symlink fails with a fixed code');
      ok(!('cases' in result)&&!JSON.stringify(result).includes('SECRET')&&!JSON.stringify(result).includes(root),'synthetic: result carries no path');
    }

    // Control: a symlink that stays inside the manifest directory is still accepted.
    const inside=await syntheticManifest(path.join(root,'i'));
    const insideDir=path.dirname(inside);
    await rm(path.join(insideDir,'photo-03.jpg'));
    await writeFile(path.join(insideDir,'photo-03-real.jpg'),syntheticImage('photo-03'));
    await symlink(path.join(insideDir,'photo-03-real.jpg'),path.join(insideDir,'photo-03.jpg'));
    ok((await loadPrivateManifest(inside)).ok===true,'synthetic: in-directory symlink remains valid');
  }finally{await rm(root,{recursive:true,force:true});}
});

// Child-process checks: the real file is run with synthetic input, no network variables and a
// marker inside the path, proving neither success nor failure output reveals paths or errors.
function runChild(env){
  const clean={PATH:process.env.PATH,CLOCK_FIXTURE_CHILD:'1',...env};
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',selfPath],{env:clean,encoding:'utf8',timeout:60000});
  return{status:run.status,output:`${run.stdout||''}\n${run.stderr||''}`};
}
if(!isChild){
  test('synthetic end-to-end output: failing and passing private runs leak no path or private values',async()=>{
    await loadValidator(); // children must find dist already built (they get a minimal env and never build)
    const root=await mkdtemp(path.join(os.tmpdir(),'clock-fixture-'));
    try{
      const missing=runChild({MALIPANG_CLOCK_PRIVATE_MANIFEST:path.join(root,'SECRETDIR','missing.json')});
      ok(missing.status!==0,'synthetic: missing manifest must fail the run');
      ok(!missing.output.includes('SECRET')&&!missing.output.includes(root),'synthetic: failure output contains no path');
      ok(/MANIFEST_UNREADABLE/.test(missing.output),'synthetic: failure states a fixed reason code');
      ok(!/^ok \d+ - clock photo fixture contract/m.test(missing.output),'synthetic: missing manifest cannot pass the contract');

      const manifestPath=await syntheticManifest(path.join(root,'valid'));
      const passing=runChild({MALIPANG_CLOCK_PRIVATE_MANIFEST:manifestPath});
      ok(passing.status!==0,'synthetic: live prerequisites missing must still fail the run');
      ok(/^ok \d+ - clock photo fixture contract/m.test(passing.output),'synthetic: valid manifest passes the local contract');
      ok(/^not ok \d+ - live vision/m.test(passing.output),'synthetic: live case fails, never skips, without an endpoint');
      ok(!/ # SKIP/.test(passing.output),'synthetic: nothing is skipped');
      ok(/MALIPANG_VISION_BASE_URL is required/.test(passing.output),'synthetic: live failure names the missing prerequisite');
      ok(!passing.output.includes('SECRET')&&!passing.output.includes(root),'synthetic: passing-contract output contains no path');
    }finally{await rm(root,{recursive:true,force:true});}
  });
}
