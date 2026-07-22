import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpenAIVisionPayload,normalizeOpenAIVisionResult} from '../dist/vision/openai.js';

test('OpenAI fallback uses the proven MaliPang clock contract',()=>{
  const payload=buildOpenAIVisionPayload('gpt-4o-mini',new Uint8Array([255,216,255,217]).buffer);
  assert.equal(payload.model,'gpt-4o-mini');
  assert.equal(payload.store,false);
  assert.equal('reasoning' in payload,false);
  assert.equal(payload.text.format.type,'json_schema');
  assert.equal(payload.text.format.strict,true);
  const prompt=payload.input[0].content[0].text;
  assert.match(prompt,/wide and black/);
  assert.match(prompt,/Mon-Sun list on the left/);
  assert.match(prompt,/timestamp watermark or phone overlay is not evidence/i);
  assert.match(prompt,/curved, diagonal, or uneven glare/i);
  assert.match(prompt,/5 versus 9/i);
  assert.match(prompt,/second time/i);
  assert.match(prompt,/Always return weekday=null/i);
  assert.match(prompt,/note to an empty string/i);
  assert.match(payload.input[0].content[1].image_url,/^data:image\/jpeg;base64,/);
  assert.equal(payload.input[0].content[1].detail,'high');
});

test('OpenAI normalization treats textual null weekday as missing',()=>{
  const result=normalizeOpenAIVisionResult({
    kind:'CLOCK',hour:8,minute:43,month:7,day:21,weekday:'null',
    confidence:0.95,clockFullyVisible:true,needsNewPhoto:false,note:'  '
  },{});
  assert.equal(result.weekday,null);
  assert.equal(result.note,'');
});
