import test from 'node:test';
import {liveSkip} from './helpers/live-opt-in.mjs';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

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

// The validator under test is compiled from the CURRENT src/ on every run into a fresh temp folder
// (TypeScript transpile of src/domain/attendance.ts and its relative imports; no type-check, no
// network). dist/ is never read, so a missing or stale dist (another SHA) cannot be tested by mistake,
// and the checkout's dist/ is not modified.
async function buildValidator({srcRoot,outDir,ts}){
  const seen=new Set();
  const visit=async rel=>{
    if(seen.has(rel))return;seen.add(rel);
    let text;try{text=await readFile(path.join(srcRoot,`${rel}.ts`),'utf8');}catch{ok(false,'validator source could not be read');}
    const out=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:`${rel}.ts`});
    await mkdir(path.dirname(path.join(outDir,rel)),{recursive:true});
    await writeFile(path.join(outDir,`${rel}.js`),out.outputText);
    for(const match of out.outputText.matchAll(/require\("(\.{1,2}\/[^"]+)"\)/g))await visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel),match[1])));
  };
  await visit('domain/attendance');
  await writeFile(path.join(outDir,'package.json'),JSON.stringify({type:'commonjs'}));
  return path.join(outDir,'domain','attendance.js');
}
async function importFreshValidator(srcRoot){
  const ts=(await import('typescript')).default;
  const outDir=await mkdtemp(path.join(os.tmpdir(),'clock-validator-'));
  try{
    const entry=await buildValidator({srcRoot,outDir,ts});
    return (await import(pathToFileURL(entry).href)).validateAttendancePhoto;
  }finally{await rm(outDir,{recursive:true,force:true});}
}
let validatorPromise;
function loadValidator(){
  validatorPromise??=importFreshValidator(path.join(path.dirname(selfPath),'..','src'));
  return validatorPromise;
}

// Owner-stated expectations, fixed in code so a manifest cannot drift toward system output.
const OWNER_EXPECTED={'photo-01':'pass','photo-02':'pass','photo-03':'pass','photo-04':'pass','photo-05':'pass','photo-06':'reject','photo-07':'reject'};
// Validation order from src/domain/attendance.ts: a reading without date/time must stop at or before this code.
const PRE_GPS_CODES=['NOT_CLOCK','CLOCK_NOT_CONFIRMED','TIMESTAMP_MISSING','TIMESTAMP_NOT_WHITE','TIMESTAMP_FIELDS_MISSING'];
const ISO_WITH_ZONE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
const isEmptyText=value=>value==null||value==='';
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const validTime=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
const validCoord=(value,limit)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=limit;
// Providers that actually read the photo. 'none' and 'openai-error' (src/vision/service.ts failedVision) are failures even when HTTP is 200.
const SUCCESS_PROVIDERS=['openai','workers-ai'];
// Allowlist for diagnostics only; any other identifier is masked.
const DIAGNOSTIC_PROVIDERS=['openai','workers-ai','pipeline','none','openai-error'];
// /admin/vision/evaluate does not return the effective ATTENDANCE_CLOCK_MIN_CONFIDENCE, so the test
// cannot prove it from the response. The operator must state the endpoint's value explicitly via
// MALIPANG_ENDPOINT_CLOCK_MIN_CONFIDENCE (private mode, live only); absent or invalid = live blocked.
// The test never guesses a default. The value is an operator attestation, not something verified here.
function parseClockMin(text){
  // Same closed range as src/shared/env.ts (0 <= value <= 1, 0 and 1 included), in plain decimal form only.
  if(typeof text!=='string'||!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(text.trim()))return null;
  const value=Number(text.trim());
  return value>=0&&value<=1?value:null;
}
const endpointClockMin=parseClockMin(process.env.MALIPANG_ENDPOINT_CLOCK_MIN_CONFIDENCE);
// The single code src/domain/attendance.ts:51-55 returns for a reading that has no date/time.
function expectedRejectCode(reading,clockMin){
  if(reading.kind!=='CLOCK')return 'NOT_CLOCK';
  if(reading.clockPresent!==true||reading.clockConfidence<clockMin)return 'CLOCK_NOT_CONFIRMED';
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
function checkPrivateReading(item,result,clockMin){
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
    // Every pass case needs well-formed values, verified or not; only verified ones are compared exactly.
    ok(validDate(reading.photoDate),`${item.id}: photo date must be a valid calendar date`);
    ok(validTime(reading.photoTime),`${item.id}: photo time must be a valid time`);
    ok(validCoord(reading.latitude,90),`${item.id}: latitude must be a finite number in range`);
    ok(validCoord(reading.longitude,180),`${item.id}: longitude must be a finite number in range`);
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
    ok(Number.isFinite(clockMin)&&clockMin>=0&&clockMin<=1,`${item.id}: effective clock confidence threshold must be stated`);
    ok(code===expectedRejectCode(reading,clockMin),`${item.id}: rejection code matches first failing check of the reading`);
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
test('live vision enforces white timestamp, GPS, and shop-clock evidence',{skip:liveSkip('clock-photos')},async t=>{
  ok(loaded.ok,`private manifest rejected: ${loaded.ok?'':loaded.code}`);
  ok(baseUrl,'MALIPANG_VISION_BASE_URL is required');
  ok(tokenFile,'MALIPANG_ADMIN_TOKEN_FILE is required');
  ok(!privateMode||endpointClockMin!==null,'MALIPANG_ENDPOINT_CLOCK_MIN_CONFIDENCE (the endpoint effective ATTENDANCE_CLOCK_MIN_CONFIDENCE) is required');
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
      if(item.mode==='private')checkPrivateReading(item,result,endpointClockMin);else checkLegacyReading(item,result);
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
const failsSanitized=(item,result,message,clockMin=0.7)=>{
  let error;try{checkPrivateReading(item,result,clockMin);}catch(caught){error=caught;}
  ok(error instanceof assert.AssertionError,message);
  ok(!String(error.message).includes('SECRET')&&!String(error.stack).includes('SECRET'),'synthetic: failure text must not carry reading values');
  ok(error.actual===false&&error.expected===true,'synthetic: failure carries booleans only');
};

test('synthetic private-case checkers: reject case rules and sanitized failures',()=>{
  const rejectItem={id:'photo-06',ownerExpected:'reject'};
  checkPrivateReading(rejectItem,rejectResult('TIMESTAMP_MISSING',{photoTime:''}),0.7);
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
  checkPrivateReading(rejectItem,rejectResult('TIMESTAMP_MISSING',{provider:'workers-ai'}),0.7);
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
    ok(real.validationCode===expectedRejectCode(reading,0.7),'synthetic: oracle equals the real validator');
    checkPrivateReading(rejectItem,{reading,validation:{ok:false,validationCode:real.validationCode}},0.7);
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
  failsSanitized(passItem,passResult,'synthetic: malformed value must fail');
  // Verified values are compared exactly: well-formed but different values must fail, one field at a time.
  const wellFormed={...passResult.reading,photoDate:'2000-01-02'};
  checkPrivateReading(passItem,{...passResult,reading:wellFormed},0.7);
  const differences=[{photoDate:'2000-01-03'},{photoTime:'03:04:06'},{photoTime:'03:04'},{latitude:13.0001},{longitude:100.0001},{latitude:-13},{longitude:-100}];
  for(const change of differences)failsSanitized(passItem,{...passResult,reading:{...wellFormed,...change}},'synthetic: valid but different verified value must fail');
  // Within the 0.00001 degree tolerance still passes.
  checkPrivateReading(passItem,{...passResult,reading:{...wellFormed,latitude:13.000005,longitude:100.000005}},0.7);
  // An unverified (provisional) reading is not compared with provider output.
  checkPrivateReading({...passItem,readingVerified:false,expectedReading:null},{...passResult,reading:{...passResult.reading,photoDate:'2000-01-09'}},0.7);
  failsSanitized({...passItem,readingVerified:false,expectedReading:null},{...passResult,reading:{...passResult.reading,photoDate:'2000-01-09',provider:'none'}},'synthetic: failed provider must not pass a pass case');
});

test('synthetic effective threshold: oracle follows the stated clock confidence threshold (0, 0.70, 0.80 and 1), never a guess',async()=>{
  const validateAttendancePhoto=await loadValidator();
  const rejectItem={id:'photo-06',ownerExpected:'reject'};
  for(const clockMin of [0,0.7,0.8,1]){
    const rules={...syntheticRules,clockMinConfidence:clockMin};
    for(const clockConfidence of [0,0.65,0.75,0.85,1]){
      const reading=rejectReading({clockConfidence});
      const real=validateAttendancePhoto({...reading,overlayConfidence:0.99,locationText:'synthetic place',note:''},syntheticReceived,rules);
      const expected=clockConfidence<clockMin?'CLOCK_NOT_CONFIRMED':'TIMESTAMP_MISSING';
      ok(real.validationCode===expected&&expectedRejectCode(reading,clockMin)===expected,'synthetic: oracle equals the real validator at this threshold');
      checkPrivateReading(rejectItem,{reading,validation:{ok:false,validationCode:real.validationCode}},clockMin);
    }
  }
  // The reported case: confidence .75 with endpoint threshold .80 is CLOCK_NOT_CONFIRMED and is accepted only when .80 is stated.
  const reading=rejectReading({clockConfidence:0.75});
  const atEighty={reading,validation:{ok:false,validationCode:'CLOCK_NOT_CONFIRMED'}};
  checkPrivateReading(rejectItem,atEighty,0.8);
  failsSanitized(rejectItem,atEighty,'synthetic: the same result is refused if 0.70 is stated',0.7);
  const atSeventy={reading,validation:{ok:false,validationCode:'TIMESTAMP_MISSING'}};
  checkPrivateReading(rejectItem,atSeventy,0.7);
  failsSanitized(rejectItem,atSeventy,'synthetic: a 0.70 result is refused if 0.80 is stated',0.8);
  // No stated threshold: refused, never defaulted.
  for(const missing of [null,NaN,-0.1,1.0001,1.5])failsSanitized(rejectItem,atSeventy,'synthetic: missing or invalid threshold must fail',missing);
  // Boundary values 0 and 1 are valid configuration (src/shared/env.ts), so they are accepted when stated.
  checkPrivateReading(rejectItem,{reading:rejectReading({clockConfidence:0}),validation:{ok:false,validationCode:'TIMESTAMP_MISSING'}},0);
  failsSanitized(rejectItem,{reading:rejectReading({clockConfidence:0}),validation:{ok:false,validationCode:'CLOCK_NOT_CONFIRMED'}},'synthetic: threshold 0 never rejects on confidence alone',0);
  checkPrivateReading(rejectItem,{reading:rejectReading({clockConfidence:0.99}),validation:{ok:false,validationCode:'CLOCK_NOT_CONFIRMED'}},1);
  // undefined is called directly: failsSanitized would substitute its own default for it.
  let undefinedError;try{checkPrivateReading(rejectItem,atSeventy,undefined);}catch(caught){undefinedError=caught;}
  ok(undefinedError instanceof assert.AssertionError,'synthetic: undefined threshold must fail');
  ok(parseClockMin('0')===0&&parseClockMin('0.0')===0&&parseClockMin('0.7')===0.7&&parseClockMin('0.80')===0.8&&parseClockMin(' 1 ')===1&&parseClockMin('1.0')===1,'synthetic: valid thresholds including 0 and 1 parse');
  for(const bad of [undefined,'',' ','abc','-0.5','-0','1.5','1.0001','2','0.7x','.7','NaN','Infinity','1e-1'])ok(parseClockMin(bad)===null,'synthetic: invalid threshold text is refused');
});

test('synthetic pass cases: well-formed values are required even when the reading is provisional',()=>{
  const item={id:'photo-02',ownerExpected:'pass',readingVerified:false,expectedReading:null};
  const good={provider:'openai',kind:'CLOCK',clockPresent:true,overlayPresent:true,overlayTextWhite:true,photoDate:'2000-01-02',photoTime:'03:04:05',latitude:13.5,longitude:100.5};
  const make=overrides=>({reading:{...good,...overrides},validation:{ok:true,validationCode:'OK'}});
  // Positive: provisional values are not compared with any expectation, only checked for form.
  checkPrivateReading(item,make({}),0.7);
  checkPrivateReading(item,make({photoDate:'2000-12-31',photoTime:'23:59',latitude:-90,longitude:-180}),0.7);
  checkPrivateReading(item,make({photoDate:'2004-02-29',photoTime:'00:00:00',latitude:0,longitude:180}),0.7);
  const bad=[
    {photoDate:'not-a-date'},{photoDate:'2000-13-45'},{photoDate:'2001-02-29'},{photoDate:20000102},{photoDate:null},{photoDate:''},
    {photoTime:'25:61'},{photoTime:'3:04'},{photoTime:'03:04:60'},{photoTime:30405},{photoTime:null},{photoTime:''},
    // The reported shape: latitude empty with longitude out of range, plus single-axis variants.
    {latitude:null,longitude:181},{latitude:null},{longitude:null},{latitude:null,longitude:null},
    {latitude:'13.5'},{longitude:'100.5'},{latitude:NaN},{longitude:Infinity},{latitude:91},{latitude:-91},{longitude:181},{longitude:-181}
  ];
  for(const overrides of bad)failsSanitized(item,make(overrides),'synthetic: malformed pass-case value must fail');
});

test('synthetic validator build: always compiled from the given source, never from a stale or missing dist',async()=>{
  const ts=(await import('typescript')).default;
  const root=await mkdtemp(path.join(os.tmpdir(),'clock-build-'));
  try{
    const writeSource=async(dir,behaviour)=>{
      await mkdir(path.join(dir,'src','domain'),{recursive:true});await mkdir(path.join(dir,'src','shared'),{recursive:true});
      await writeFile(path.join(dir,'src','shared','time.ts'),'export const stamp:string="'+behaviour+'";');
      await writeFile(path.join(dir,'src','domain','attendance.ts'),'import {stamp} from "../shared/time";\nimport type {Unused} from "../types";\nexport function validateAttendancePhoto():string{return stamp;}');
    };
    const load=async(dir,out)=>{const entry=await buildValidator({srcRoot:path.join(dir,'src'),outDir:out,ts});return {entry,fn:(await import(pathToFileURL(entry).href)).validateAttendancePhoto};};
    // Clean: no dist anywhere.
    const clean=path.join(root,'clean');await writeSource(clean,'FRESH-1');
    const first=await load(clean,path.join(root,'out1'));
    ok(first.fn()==='FRESH-1'&&first.entry.startsWith(path.join(root,'out1')),'synthetic: clean tree compiles into the temp folder');
    // Stale dist present beside the source: it must be ignored and left untouched.
    const stale=path.join(root,'stale');await writeSource(stale,'FRESH-2');
    await mkdir(path.join(stale,'dist','domain'),{recursive:true});
    await writeFile(path.join(stale,'dist','package.json'),'{"type":"commonjs"}');
    await writeFile(path.join(stale,'dist','domain','attendance.js'),'exports.validateAttendancePhoto=()=>"STALE";');
    const second=await load(stale,path.join(root,'out2'));
    ok(second.fn()==='FRESH-2','synthetic: stale dist is not used');
    ok((await readFile(path.join(stale,'dist','domain','attendance.js'),'utf8')).includes('STALE'),'synthetic: existing dist is left unmodified');
    // Source changes after a first build: a new build reflects it (distinct output folder = new module).
    await writeSource(stale,'FRESH-3');
    ok((await load(stale,path.join(root,'out3'))).fn()==='FRESH-3','synthetic: changed source is rebuilt');
    // A missing source file fails closed with a fixed message.
    let error;try{await buildValidator({srcRoot:path.join(root,'nowhere'),outDir:path.join(root,'out4'),ts});}catch(caught){error=caught;}
    ok(error instanceof assert.AssertionError&&!String(error.message).includes(root),'synthetic: missing source fails without a path');
  }finally{await rm(root,{recursive:true,force:true});}
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
    const root=await mkdtemp(path.join(os.tmpdir(),'clock-fixture-'));
    try{
      const missing=runChild({MALIPANG_CLOCK_PRIVATE_MANIFEST:path.join(root,'SECRETDIR','missing.json')});
      ok(missing.status!==0,'synthetic: missing manifest must fail the run');
      ok(!missing.output.includes('SECRET')&&!missing.output.includes(root),'synthetic: failure output contains no path');
      ok(/MANIFEST_UNREADABLE/.test(missing.output),'synthetic: failure states a fixed reason code');
      ok(!/^ok \d+ - clock photo fixture contract/m.test(missing.output),'synthetic: missing manifest cannot pass the contract');

      const manifestPath=await syntheticManifest(path.join(root,'valid'));
      const local=runChild({MALIPANG_CLOCK_PRIVATE_MANIFEST:manifestPath});
      ok(local.status===0,'synthetic: without the live opt-in the local contract run passes');
      ok(/^ok \d+ - clock photo fixture contract/m.test(local.output),'synthetic: valid manifest passes the local contract');
      ok(/^ok \d+ - live vision.* # SKIP live suite not selected \(set MALIPANG_LIVE_TESTS=clock-photos\)/m.test(local.output),'synthetic: unselected live case states why it is skipped');
      ok((local.output.match(/ # SKIP/g)||[]).length===1,'synthetic: only the live case is skipped');

      const passing=runChild({MALIPANG_CLOCK_PRIVATE_MANIFEST:manifestPath,MALIPANG_LIVE_TESTS:'clock-photos'});
      ok(passing.status!==0,'synthetic: selected live suite without prerequisites must fail the run');
      ok(/^ok \d+ - clock photo fixture contract/m.test(passing.output),'synthetic: valid manifest passes the local contract when live is selected');
      ok(/^not ok \d+ - live vision/m.test(passing.output),'synthetic: selected live case fails, never skips, without an endpoint');
      ok(!/ # SKIP/.test(passing.output),'synthetic: nothing is skipped once live is selected');
      ok(/MALIPANG_VISION_BASE_URL is required/.test(passing.output),'synthetic: live failure names the missing prerequisite');
      ok(!passing.output.includes('SECRET')&&!passing.output.includes(root)&&!local.output.includes(root),'synthetic: passing-contract output contains no path');
    }finally{await rm(root,{recursive:true,force:true});}
  });
}
