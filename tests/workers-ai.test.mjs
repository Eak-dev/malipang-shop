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
      return{result:{answer:'```json\n{"kind":"CLOCK","hour":4,"minute":3,"month":7,"day":21,"weekday":"Tuesday","confidence":0.99,"clockFullyVisible":true,"needsNewPhoto":false,"note":""}\n```'}};
    }}
  };
  const result=await readImageWithWorkersAI(env,new Uint8Array([255,216,255,217]).buffer);
  assert.equal(calledModel,env.WORKERS_AI_MODEL);
  assert.equal(calledInput.task,'query');
  assert.equal(calledInput.stream,false);
  assert.equal(calledInput.reasoning,false);
  assert.match(calledInput.image,/^data:image\/jpeg;base64,/);
  assert.match(calledInput.question,/Return JSON only/);
  assert.match(calledInput.question,/curved, diagonal, or uneven glare/i);
  assert.match(calledInput.question,/5 versus 9/i);
  assert.match(calledInput.question,/Always return weekday=null/i);
  assert.equal(result.kind,'CLOCK');
  assert.equal(result.hour,4);
  assert.equal(result.minute,3);
  assert.equal(result.month,7);
  assert.equal(result.day,21);
  assert.equal(result.confidence,0.99);
});
