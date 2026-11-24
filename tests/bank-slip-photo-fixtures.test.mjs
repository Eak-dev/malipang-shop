import test from 'node:test';
import {liveSkip} from './helpers/live-opt-in.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';

const cases=JSON.parse(await readFile(new URL('./fixtures/bank-slip-cases.json',import.meta.url),'utf8'));
const baseUrl=String(process.env.MALIPANG_VISION_BASE_URL||'').replace(/\/$/,'');
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE||'';
const manifest=process.env.MALIPANG_BANK_SLIP_PRIVATE_MANIFEST;
const legacyImageMap=process.env.MALIPANG_BANK_SLIP_IMAGE_MAP;
const maxImageBytes=5*1024*1024;
const digest=image=>createHash('sha256').update(image).digest('hex');
const validImage=image=>image.length>2&&image.length<=maxImageBytes&&image[0]===0xff&&image[1]===0xd8;

function usesPrivateManifest(path,imageMap){
  if(path===undefined)return false;
  assert.ok(path.trim(),'PRIVATE_SLIP_MANIFEST_EMPTY');
  assert.ok(imageMap===undefined,'Choose only one bank slip fixture mode');
  return true;
}

function validExpected(expected,baseline){
  if(!expected||expected.channel!==baseline.channel||!Number.isFinite(expected.paidAmountBaht)||expected.paidAmountBaht<=0)return false;
  const date=expected.paymentDate;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const parsed=new Date(date+'T00:00:00Z');
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==date)return false;
  if(typeof expected.paymentTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(expected.paymentTime))return false;
  if(!Array.isArray(expected.allowedCategories)||!expected.allowedCategories.length||
    !expected.allowedCategories.every(category=>typeof category==='string'&&/^[a-z_]+$/.test(category)))return false;
  const amounts=['grossAmountBaht','discountAmountBaht'];
  if(amounts.some(key=>key in expected&&(!Number.isFinite(expected[key])||expected[key]<0)))return false;
  return baseline.channel!=='G_WALLET'||amounts.every(key=>key in expected);
}

async function loadPrivateCases(path){
  let entries,root;
  try{
    const canonical=await realpath(path);
    root=dirname(canonical);
    entries=JSON.parse(await readFile(canonical,'utf8')).cases;
  }catch{throw Error('PRIVATE_SLIP_MANIFEST_UNREADABLE');}
  assert.ok(Array.isArray(entries)&&entries.length===cases.length,'PRIVATE_SLIP_CASE_COUNT');
  const hashes=new Set();
  return Promise.all(cases.map(async ({id,expected:baseline})=>{
    const matched=entries.filter(item=>item?.id===id);
    assert.ok(matched.length===1,id+': PRIVATE_SLIP_CASE_REQUIRED');
    const [item]=matched;
    assert.ok(item.readingVerified===true&&validExpected(item.expected,baseline),id+': PRIVATE_SLIP_EXPECTED_REVIEW_REQUIRED');
    assert.ok(typeof item.file==='string'&&/^[\w.-]+\.jpe?g$/i.test(item.file),id+': PRIVATE_SLIP_IMAGE_FILENAME');
    assert.ok(typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256)&&!hashes.has(item.sha256),id+': PRIVATE_SLIP_IMAGE_HASH_REQUIRED');
    hashes.add(item.sha256);
    let image;
    try{
      const file=await realpath(join(root,item.file));
      if(dirname(file)===root)image=await readFile(file);
    }catch{/* report the fixed reason below */}
    assert.ok(image&&validImage(image)&&digest(image)===item.sha256,id+': PRIVATE_SLIP_IMAGE_UNVERIFIED');
    const expected={...item.expected,kind:baseline.kind,institutionAliases:baseline.institutionAliases};
    return {id,expected,image};
  }));
}

function checkReading(id,expected,result){
  assert.ok(result?.ok===true,id+': evaluator did not report success');
  const doc=result?.reading?.document;
  assert.ok(result?.reading?.provider==='openai'&&result?.reading?.kind===expected.kind&&doc,id+': bank slip reading required');
  for(const field of ['channel','paymentDate','paymentTime','paidAmountBaht','grossAmountBaht','discountAmountBaht']){
    if(field in expected)assert.ok(doc[field]===expected[field],id+': '+field+' mismatch');
  }
  assert.ok(typeof doc.institution==='string'&&expected.institutionAliases.some(alias=>doc.institution.toLowerCase().includes(alias)),id+': institution mismatch');
  assert.ok(expected.allowedCategories.includes(doc.suggestedCategory),id+': category mismatch');
  assert.ok(result?.documentValidation?.ok===true,id+': document validation failed');
}

test('bank slip fixture contract covers KBank, SCB, and Paotang',async()=>{
  assert.deepEqual(cases.map(item=>item.id),['kbank-kplus','scb-easy','paotang-gwallet']);
  assert.deepEqual(new Set(cases.map(item=>item.expected.channel)),new Set(['BANK','G_WALLET']));
  for(const item of cases)assert.ok(validExpected(item.expected,item.expected),item.id+': invalid legacy contract');
  if(usesPrivateManifest(manifest,legacyImageMap))await loadPrivateCases(manifest);
});

test('bank slip evaluator rejects unsuccessful and mismatched responses without exposing amounts',()=>{
  const expected={kind:'BANK_SLIP',channel:'BANK',institutionAliases:['example'],paymentDate:'2000-02-29',paymentTime:'12:30',paidAmountBaht:123.45,allowedCategories:['general']};
  const document={...expected,institution:'Example',suggestedCategory:'general'};
  const result={ok:true,reading:{provider:'openai',kind:'BANK_SLIP',document},documentValidation:{ok:true}};
  checkReading('synthetic',expected,result);
  assert.throws(()=>checkReading('synthetic',expected,{...result,ok:false}),/evaluator did not report success/);
  const wrong={...result,reading:{...result.reading,document:{...document,paidAmountBaht:987.65}}};
  assert.throws(()=>checkReading('synthetic',expected,wrong),error=>{
    return error.message==='synthetic: paidAmountBaht mismatch'&&!/987\.65|123\.45/.test(JSON.stringify(error));
  });
});

test('private slip contract binds independently reviewed expectations to each distinct JPEG',async()=>{
  assert.equal(usesPrivateManifest(undefined,'{}'),false);
  assert.throws(()=>usesPrivateManifest('','{}'),/PRIVATE_SLIP_MANIFEST_EMPTY/);
  assert.throws(()=>usesPrivateManifest('private.json','{}'),/Choose only one bank slip fixture mode/);
  const root=await mkdtemp(join(tmpdir(),'bank-slip-contract-'));
  try{
    const path=join(root,'cases.json');
    const entries=await Promise.all(cases.map(async ({id,expected},index)=>{
      const file=id+'.jpg',image=Buffer.from([0xff,0xd8,index,0xff,0xd9]);
      await writeFile(join(root,file),image);
      return {id,file,sha256:digest(image),readingVerified:true,
        expected:{...expected,paymentDate:'2000-02-29',paymentTime:'12:30'}};
    }));
    const save=()=>writeFile(path,JSON.stringify({cases:entries}));
    await assert.rejects(loadPrivateCases(path),/PRIVATE_SLIP_MANIFEST_UNREADABLE/);
    await save();
    const loaded=await loadPrivateCases(path);
    assert.ok(loaded.every(item=>item.expected.paymentDate==='2000-02-29'));
    entries[0].readingVerified=false;
    await save();
    await assert.rejects(loadPrivateCases(path),/PRIVATE_SLIP_EXPECTED_REVIEW_REQUIRED/);
    entries[0].readingVerified=true;
    await writeFile(join(root,entries[0].file),Buffer.from([0xff,0xd8,99]));
    await save();
    await assert.rejects(loadPrivateCases(path),/PRIVATE_SLIP_IMAGE_UNVERIFIED/);
    entries[0].sha256=entries[1].sha256;
    await writeFile(join(root,entries[0].file),await readFile(join(root,entries[1].file)));
    await save();
    await assert.rejects(loadPrivateCases(path),/PRIVATE_SLIP_IMAGE_HASH_REQUIRED/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('live OpenAI evaluator extracts every supplied bank slip',{skip:liveSkip('bank-slips')},async t=>{
  const privateMode=usesPrivateManifest(manifest,legacyImageMap);
  assert.ok(baseUrl,'MALIPANG_VISION_BASE_URL is required');
  assert.ok(tokenFile,'MALIPANG_ADMIN_TOKEN_FILE is required');
  let selected;
  if(privateMode)selected=await loadPrivateCases(manifest);
  else{
    let imageMap;
    try{imageMap=JSON.parse(legacyImageMap||'{}');}catch{throw Error('BANK_SLIP_IMAGE_MAP_INVALID');}
    assert.ok(imageMap&&cases.every(item=>imageMap[item.id]),'MALIPANG_BANK_SLIP_IMAGE_MAP must contain all three fixture images');
    selected=await Promise.all(cases.map(async item=>{
      try{return {...item,image:await readFile(imageMap[item.id])};}catch{throw Error(item.id+': bank slip image unreadable');}
    }));
  }
  assert.ok(selected.every(item=>validImage(item.image)),'All slip images must be JPEGs within the evaluator limit');
  let token;
  try{token=(await readFile(tokenFile,'utf8')).trim();}catch{throw Error('Bank slip admin token file unreadable');}
  assert.ok(token.length>=32,'Bank slip admin token is missing or too short');
  for(const {id,expected,image} of selected)await t.test(id,async()=>{
    let response,result;
    try{
      response=await fetch(`${baseUrl}/admin/vision/evaluate?provider=openai&model=gpt-4.1-mini`,{
        method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'image/jpeg'},body:image
      });
      result=await response.json();
    }catch{throw Error(id+': evaluator request or response failed');}
    assert.ok(response.ok,id+': evaluator HTTP '+response.status);
    checkReading(id,expected,result);
  });
});
