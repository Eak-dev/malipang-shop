import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fixtureDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','clock-photos');
const cases=JSON.parse(await readFile(path.join(fixtureDir,'cases.json'),'utf8'));
const fixtureImages=await Promise.all(cases.map(async item=>{
  try{return await readFile(path.join(fixtureDir,item.file));}catch{return null;}
}));
const fixtureImagesPresent=fixtureImages.every(Boolean);

test('clock photo fixture contract contains the seven supplied photos',async()=>{
  assert.equal(cases.length,7);
  assert.equal(new Set(cases.map(item=>item.id)).size,7);
  for(const [index,item] of cases.entries()){
    const image=fixtureImages[index];
    if(image){
      assert.ok(image.length>0,`${item.id}: image is empty`);
      assert.deepEqual([...image.subarray(0,2)],[0xff,0xd8],`${item.id}: not a JPEG`);
    }
    assert.equal(item.expected.kind,'CLOCK');
    assert.match(item.expected.photoDate,/^\d{4}-\d{2}-\d{2}$/);
    assert.match(item.expected.photoTime,/^\d{2}:\d{2}(?::\d{2})?$/);
    assert.equal(typeof item.expected.accepted,'boolean');
    if(item.expected.accepted){assert.ok(Number.isFinite(item.expected.latitude));assert.ok(Number.isFinite(item.expected.longitude));}
    assert.ok(Number.isFinite(new Date(item.receivedAt).getTime()));
  }
});

const baseUrl=String(process.env.MALIPANG_VISION_BASE_URL||'').replace(/\/$/,'');
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
const provider=process.env.MALIPANG_VISION_PROVIDER||'openai';
const openAIModel=process.env.MALIPANG_OPENAI_MODEL||'';
const selectedIds=new Set(String(process.env.MALIPANG_CLOCK_CASES||'').split(',').map(value=>value.trim()).filter(Boolean));
const selectedCases=selectedIds.size?cases.filter(item=>selectedIds.has(item.id)):cases;

test('live vision enforces white timestamp, GPS, and shop-clock evidence',{
  skip:!baseUrl||!tokenFile||!fixtureImagesPresent
},async t=>{
  assert.ok(['pipeline','openai','workers-ai'].includes(provider));
  const adminToken=(await readFile(tokenFile,'utf8')).trim();
  assert.ok(adminToken.length>=32,'admin token is missing or too short');

  for(const item of selectedCases){
    await t.test(item.id,async t=>{
      const index=cases.findIndex(candidate=>candidate.id===item.id);
      const image=fixtureImages[index];
      assert.ok(image,`${item.id}: local fixture is missing`);
      const modelQuery=openAIModel?`&model=${encodeURIComponent(openAIModel)}`:'';
      const url=`${baseUrl}/admin/vision/evaluate?provider=${encodeURIComponent(provider)}&receivedAt=${encodeURIComponent(item.receivedAt)}${modelQuery}`;
      const response=await fetch(url,{
        method:'POST',
        headers:{authorization:`Bearer ${adminToken}`,'content-type':'image/jpeg'},
        body:image
      });
      const result=await response.json();
      assert.equal(response.ok,true,`${item.id}: HTTP ${response.status} ${result.error||''}`);
      assert.equal(result.ok,true,`${item.id}: endpoint failed`);
      assert.equal(result.reading.kind,item.expected.kind);
      assert.equal(result.reading.photoDate,item.expected.photoDate);
      assert.equal(result.reading.photoTime,item.expected.photoTime);
      assert.equal(result.reading.clockPresent,true);
      assert.equal(result.reading.overlayPresent,true);
      assert.equal(result.reading.overlayTextWhite,true);
      if(item.expected.latitude==null){assert.equal(result.reading.latitude,null);assert.equal(result.reading.longitude,null);}else{assert.ok(Math.abs(result.reading.latitude-item.expected.latitude)<0.00001);assert.ok(Math.abs(result.reading.longitude-item.expected.longitude)<0.00001);}
      assert.equal(result.validation.ok,item.expected.accepted,`${item.id}: ${result.validation.validationCode}`);
      assert.equal(result.validation.validationCode,item.expected.validationCode);
      t.diagnostic(JSON.stringify({
        provider:result.reading.provider,
        photoTimestamp:`${result.reading.photoDate} ${result.reading.photoTime}`,
        gps:[result.reading.latitude,result.reading.longitude],
        clockPresent:result.reading.clockPresent,
        overlayConfidence:result.reading.overlayConfidence,
        validation:result.validation.validationCode
      }));
    });
  }
});
