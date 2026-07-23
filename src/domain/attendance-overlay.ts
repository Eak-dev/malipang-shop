import { isIsoDate } from "../shared/time";

export interface ParsedAttendanceOverlay {
  photoDate: string | null;
  photoTime: string | null;
  latitude: number | null;
  longitude: number | null;
}

const months:Record<string,number>={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
const pad=(value:number)=>String(value).padStart(2,"0");
const normalizeYear=(value:number,digits:number)=>digits===2?(value<=79?2000+value:1900+value):value>=2400?value-543:value;
function dateValue(year:number,month:number,day:number):string|null{const value=`${year}-${pad(month)}-${pad(day)}`;return isIsoDate(value)?value:null;}
function timeValue(hour:number,minute:number,second:number,meridiem=""):string|null{
  const marker=meridiem.toUpperCase();
  if(marker){if(hour<1||hour>12)return null;if(marker==="AM"&&hour===12)hour=0;if(marker==="PM"&&hour!==12)hour+=12;}
  if(hour<0||hour>23||minute<0||minute>59||second<0||second>59)return null;
  return`${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function parseAttendanceOverlay(rawText:string):ParsedAttendanceOverlay{
  const text=String(rawText||"").replace(/\s+/g," ").trim();let photoDate:string|null=null,photoTime:string|null=null;
  const dayFirst=/(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:BE\s*)?(\d{2,4})\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  const monthFirst=/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  const yearFirst=/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  const numericDayFirst=/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(text);
  if(dayFirst){const yearText=dayFirst[3]!,year=normalizeYear(Number(yearText),yearText.length);photoDate=dateValue(year,months[dayFirst[2]!.toLowerCase()]||0,Number(dayFirst[1]));photoTime=timeValue(Number(dayFirst[4]),Number(dayFirst[5]),Number(dayFirst[6]||0),dayFirst[7]);}
  else if(monthFirst){const yearText=monthFirst[3]!,year=normalizeYear(Number(yearText),yearText.length);photoDate=dateValue(year,months[monthFirst[1]!.toLowerCase()]||0,Number(monthFirst[2]));photoTime=timeValue(Number(monthFirst[4]),Number(monthFirst[5]),Number(monthFirst[6]||0),monthFirst[7]);}
  else if(yearFirst){const yearText=yearFirst[1]!,year=normalizeYear(Number(yearText),yearText.length);photoDate=dateValue(year,Number(yearFirst[2]),Number(yearFirst[3]));photoTime=timeValue(Number(yearFirst[4]),Number(yearFirst[5]),Number(yearFirst[6]||0),yearFirst[7]);}
  else if(numericDayFirst){const yearText=numericDayFirst[3]!,year=normalizeYear(Number(yearText),yearText.length);photoDate=dateValue(year,Number(numericDayFirst[2]),Number(numericDayFirst[1]));photoTime=timeValue(Number(numericDayFirst[4]),Number(numericDayFirst[5]),Number(numericDayFirst[6]||0),numericDayFirst[7]);}
  let latitude:number|null=null,longitude:number|null=null;
  const signed=/([+-]?\d{1,2}\.\d+)\s*[, ]\s*([+-]?\d{2,3}\.\d+)/.exec(text),cardinal=/(\d{1,2}\.\d+)\s*([NS])[, ]+\s*(\d{2,3}\.\d+)\s*([EW])/i.exec(text);
  if(signed){latitude=Number(signed[1]);longitude=Number(signed[2]);}
  else if(cardinal){latitude=Number(cardinal[1])*(cardinal[2]!.toUpperCase()==="S"?-1:1);longitude=Number(cardinal[3])*(cardinal[4]!.toUpperCase()==="W"?-1:1);}
  return{photoDate,photoTime,latitude,longitude};
}
