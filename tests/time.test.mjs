import test from 'node:test';
import assert from 'node:assert/strict';
import {weekStartMonday,addDays,isIsoDate,minutesOf} from '../dist/shared/time.js';
import {distanceMeters,validateAttendancePhoto} from '../dist/domain/attendance.js';

const rules={storeLat:13.89682,storeLng:100.60830,allowedRadiusM:120,maxPhotoAgeMin:3,overlayMinConfidence:.9,clockMinConfidence:.7};
const base={kind:'CLOCK',hour:17,minute:16,month:7,day:21,weekday:'Tue',confidence:.99,clockFullyVisible:true,clockPresent:true,clockConfidence:.99,overlayPresent:true,overlayTextWhite:true,photoDate:'2026-07-21',photoTime:'17:15:56',latitude:13.896844,longitude:100.608314,locationText:'Yingcharoen Market',overlayRawText:'21 Jul BE 2569 at 17:15:56 +13.896844,+100.608314',overlayConfidence:.99,needsNewPhoto:false,note:'',provider:'test',raw:null};

test('week is Monday through Sunday',()=>{assert.equal(weekStartMonday('2026-07-20'),'2026-07-20');assert.equal(addDays('2026-07-20',6),'2026-07-26');});
test('HH:mm and ISO validation',()=>{assert.equal(minutesOf('04:30'),270);assert.throws(()=>minutesOf('24:00'));assert.equal(isIsoDate('2026-02-28'),true);assert.equal(isIsoDate('2026-02-31'),false);});
test('white photo timestamp is authoritative, not wall-clock digits',()=>{const r=validateAttendancePhoto(base,'2026-07-21T10:15:56.000Z',rules);assert.equal(r.ok,true);assert.equal(r.workDate,'2026-07-21');assert.equal(r.officialTime,'17:15');assert.equal(r.review,false);assert.ok(r.distanceM<10);});
test('GPS distance uses the configured shop location',()=>{assert.ok(distanceMeters(13.89682,100.60830,13.896844,100.608314)<10);const r=validateAttendancePhoto({...base,latitude:13.90,longitude:100.61},'2026-07-21T10:15:56.000Z',rules);assert.equal(r.validationCode,'OUTSIDE_STORE_RADIUS');});
test('missing GPS is rejected',()=>{assert.equal(validateAttendancePhoto({...base,latitude:null,longitude:null},'2026-07-21T10:15:56.000Z',rules).validationCode,'GPS_MISSING');});
test('missing or non-white overlay is rejected',()=>{assert.equal(validateAttendancePhoto({...base,overlayPresent:false},'2026-07-21T10:15:56.000Z',rules).validationCode,'TIMESTAMP_MISSING');assert.equal(validateAttendancePhoto({...base,overlayTextWhite:false},'2026-07-21T10:15:56.000Z',rules).validationCode,'TIMESTAMP_NOT_WHITE');});
test('shop clock is required only as presence evidence',()=>{const r=validateAttendancePhoto({...base,clockPresent:false,hour:null,minute:null,month:null,day:null},'2026-07-21T10:15:56.000Z',rules);assert.equal(r.validationCode,'CLOCK_NOT_CONFIRMED');const accepted=validateAttendancePhoto({...base,hour:null,minute:null,month:null,day:null},'2026-07-21T10:15:56.000Z',rules);assert.equal(accepted.ok,true);});
test('stale or replayed photo is rejected instead of recorded for review',()=>{const r=validateAttendancePhoto(base,'2026-07-21T10:25:56.000Z',rules);assert.equal(r.ok,false);assert.equal(r.validationCode,'PHOTO_TIME_TOO_OLD');});
