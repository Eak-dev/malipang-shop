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
    assert.ok(Number.isInteger(item.expected.hour)&&item.expected.hour>=0&&item.expected.hour<=23);
    assert.ok(Number.isInteger(item.expected.minute)&&item.expected.minute>=0&&item.expected.minute<=59);
    assert.ok(Number.isInteger(item.expected.month)&&item.expected.month>=1&&item.expected.month<=12);
    assert.ok(Number.isInteger(item.expected.day)&&item.expected.day>=1&&item.expected.day<=31);
    assert.ok(Number.isFinite(new Date(item.receivedAt).getTime()));
  }
});

const baseUrl=String(process.env.MALIPANG_VISION_BASE_URL||'').replace(/\/$/,'');
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;
const provider=process.env.MALIPANG_VISION_PROVIDER||'openai';
const openAIModel=process.env.MALIPANG_OPENAI_MODEL||'';
const selectedIds=new Set(String(process.env.MALIPANG_CLOCK_CASES||'').split(',').map(value=>value.trim()).filter(Boolean));
const selectedCases=selectedIds.size?cases.filter(item=>selectedIds.has(item.id)):cases;

test('live vision reads every supplied clock photo exactly',{
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
      assert.equal(result.reading.hour,item.expected.hour);
      assert.equal(result.reading.minute,item.expected.minute);
      assert.equal(result.reading.month,item.expected.month);
      assert.equal(result.reading.day,item.expected.day);
      assert.equal(result.reading.needsNewPhoto,false);
      assert.ok(result.reading.confidence>=0.9,`${item.id}: confidence ${result.reading.confidence}`);
      assert.equal(result.validation.ok,true,`${item.id}: ${result.validation.validationCode}`);

      const weekday=String(result.reading.weekday||'').toLowerCase();
      const weekdayMatches=!weekday||weekday===item.expected.weekday||weekday===item.expected.weekday.slice(0,3);
      t.diagnostic(JSON.stringify({
        provider:result.reading.provider,
        clock:`${String(result.reading.hour).padStart(2,'0')}:${String(result.reading.minute).padStart(2,'0')}`,
        date:`${result.reading.month}/${result.reading.day}`,
        weekday:result.reading.weekday,
        weekdayMatches,
        confidence:result.reading.confidence,
        validation:result.validation.validationCode
      }));
    });
  }
});
