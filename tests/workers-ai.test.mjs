import test from 'node:test';
import assert from 'node:assert/strict';
import {readImageWithWorkersAI} from '../dist/vision/workers-ai.js';

test('Moondream 3.1 uses query contract and parses answer JSON',async()=>{
  let calledModel='';
  let calledInput;
  const env={
    WORKERS_AI_MODEL:'@cf/moondream/moondream3.1-9B-A2B',
    AI:{run:async(model,input)=>{
      calledModel=model;
      calledInput=input;
      return{result:{answer:'```json\n{"kind":"CLOCK","hour":null,"minute":null,"month":null,"day":null,"weekday":null,"confidence":0.99,"clockFullyVisible":true,"clockPresent":true,"clockConfidence":0.99,"overlayPresent":true,"overlayTextWhite":true,"photoDate":"2026-07-21","photoTime":"17:15:56","latitude":13.896844,"longitude":100.608314,"locationText":"Yingcharoen Market","overlayRawText":"21 Jul BE 2569 at 17:15:56","overlayConfidence":0.99,"needsNewPhoto":false,"note":""}\n```'}};
    }}
  };
  const result=await readImageWithWorkersAI(env,new Uint8Array([255,216,255,217]).buffer);
  assert.equal(calledModel,env.WORKERS_AI_MODEL);
  assert.equal(calledInput.task,'query');
  assert.equal(calledInput.stream,false);
  assert.equal(calledInput.reasoning,false);
  assert.match(calledInput.image,/^data:image\/jpeg;base64,/);
  assert.match(calledInput.question,/Return JSON only/);
  assert.match(calledInput.question,/authoritative attendance source/i);
  assert.match(calledInput.question,/every corner/i);
  assert.match(calledInput.question,/never use its digits as attendance time/i);
  assert.equal(result.kind,'CLOCK');
  assert.equal(result.photoDate,'2026-07-21');
  assert.equal(result.photoTime,'17:15:56');
  assert.equal(result.latitude,13.896844);
  assert.equal(result.clockPresent,true);
  assert.equal(result.confidence,0.99);
});
