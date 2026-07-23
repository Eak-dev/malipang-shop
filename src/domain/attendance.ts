import { hhmmInBangkok, isIsoDate } from "../shared/time";
import type { VisionResult } from "../types";

export interface AttendancePhotoRules {
  storeLat: number;
  storeLng: number;
  allowedRadiusM: number;
  maxPhotoAgeMin: number;
  overlayMinConfidence: number;
  clockMinConfidence: number;
}

export interface ValidatedAttendancePhoto {
  ok: boolean;
  workDate: string;
  officialTime: string;
  photoDateTime: string;
  gpsLat: number;
  gpsLng: number;
  distanceM: number;
  lineTime: string;
  lineDiffMinutes: number;
  validationCode: string;
  review: boolean;
  note: string;
}

const empty = (receivedAtIso:string,code:string,note=code):ValidatedAttendancePhoto => ({
  ok:false,workDate:"",officialTime:"",photoDateTime:"",gpsLat:0,gpsLng:0,distanceM:0,
  lineTime:hhmmInBangkok(new Date(receivedAtIso)),lineDiffMinutes:0,validationCode:code,review:true,note
});

function normalizedTime(value:string|null):{hhmm:string;full:string}|null{
  if(!value)return null;
  const match=/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if(!match)return null;
  const hour=Number(match[1]),minute=Number(match[2]),second=Number(match[3]||0);
  if(hour<0||hour>23||minute<0||minute>59||second<0||second>59)return null;
  const hh=String(hour).padStart(2,"0"),mm=String(minute).padStart(2,"0"),ss=String(second).padStart(2,"0");
  return{hhmm:`${hh}:${mm}`,full:`${hh}:${mm}:${ss}`};
}

export function distanceMeters(lat1:number,lng1:number,lat2:number,lng2:number):number{
  const rad=(value:number)=>value*Math.PI/180,dLat=rad(lat2-lat1),dLng=rad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

export function validateAttendancePhoto(reading:VisionResult,receivedAtIso:string,rules:AttendancePhotoRules):ValidatedAttendancePhoto{
  const fail=(code:string,note=code)=>empty(receivedAtIso,code,note);
  if(reading.kind!=="CLOCK")return fail("NOT_CLOCK");
  if(reading.clockPresent!==true||reading.clockConfidence<rules.clockMinConfidence)return fail("CLOCK_NOT_CONFIRMED");
  if(!reading.overlayPresent)return fail("TIMESTAMP_MISSING");
  if(!reading.overlayTextWhite)return fail("TIMESTAMP_NOT_WHITE");
  if(!reading.photoDate||!reading.photoTime)return fail("TIMESTAMP_FIELDS_MISSING");
  if(reading.overlayConfidence<rules.overlayMinConfidence)return fail("TIMESTAMP_LOW_CONFIDENCE");
  if(!isIsoDate(reading.photoDate))return fail("TIMESTAMP_INVALID");
  const time=normalizedTime(reading.photoTime);if(!time)return fail("TIMESTAMP_INVALID");
  if(reading.latitude==null||reading.longitude==null)return fail("GPS_MISSING");
  if(!Number.isFinite(reading.latitude)||!Number.isFinite(reading.longitude)||reading.latitude< -90||reading.latitude>90||reading.longitude< -180||reading.longitude>180)return fail("GPS_VALUE_OUT_OF_RANGE");
  if(!reading.locationText.trim())return fail("LOCATION_TEXT_MISSING");
  if(!Number.isFinite(rules.storeLat)||!Number.isFinite(rules.storeLng)||rules.storeLat< -90||rules.storeLat>90||rules.storeLng< -180||rules.storeLng>180)return fail("STORE_LOCATION_NOT_CONFIGURED");
  const distanceM=distanceMeters(rules.storeLat,rules.storeLng,reading.latitude,reading.longitude);
  if(distanceM>rules.allowedRadiusM)return fail("OUTSIDE_STORE_RADIUS",`ห่างจากร้าน ${Math.round(distanceM)} เมตร`);
  const photoDateTime=`${reading.photoDate}T${time.full}+07:00`,photoMs=new Date(photoDateTime).getTime(),receivedMs=new Date(receivedAtIso).getTime();
  if(!Number.isFinite(photoMs)||!Number.isFinite(receivedMs))return fail("TIMESTAMP_INVALID");
  const lineDiffMinutes=Math.round(Math.abs(receivedMs-photoMs)/60000);
  if(lineDiffMinutes>rules.maxPhotoAgeMin)return fail("PHOTO_TIME_TOO_OLD",`Timestamp ต่างจากเวลา LINE ${lineDiffMinutes} นาที`);
  return{ok:true,workDate:reading.photoDate,officialTime:time.hhmm,photoDateTime,gpsLat:reading.latitude,gpsLng:reading.longitude,distanceM:Math.round(distanceM*10)/10,lineTime:hhmmInBangkok(new Date(receivedAtIso)),lineDiffMinutes,validationCode:"OK",review:false,note:reading.note.trim()};
}
