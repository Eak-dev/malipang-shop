const pad = (n: number) => String(n).padStart(2, "0");
export function hhmm(hour: number, minute: number): string { return `${pad(hour)}:${pad(minute)}`; }
export function minutesOf(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid HH:mm: ${value}`);
  const hour=Number(m[1]),minute=Number(m[2]);
  if(hour<0||hour>23||minute<0||minute>59)throw new Error(`Invalid HH:mm: ${value}`);
  return hour*60+minute;
}
export function isoDateInBangkok(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=(type:string)=>parts.find((p)=>p.type===type)?.value??"";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function hhmmInBangkok(date: Date): string {
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Bangkok",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const get=(type:string)=>Number(parts.find((p)=>p.type===type)?.value??0);
  return hhmm(get("hour"),get("minute"));
}
function validDate(year:number,month:number,day:number):Date|null{
  const candidate=new Date(`${year}-${pad(month)}-${pad(day)}T12:00:00+07:00`);
  if(!Number.isFinite(candidate.getTime()))return null;
  const rendered=isoDateInBangkok(candidate);
  return rendered===`${year}-${pad(month)}-${pad(day)}`?candidate:null;
}
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  return validDate(Number(match[1]), Number(match[2]), Number(match[3])) !== null;
}
export function resolveClockDate(month:number,day:number,receivedAtIso:string):string|null{
  const received=new Date(receivedAtIso);
  const year=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Bangkok",year:"numeric"}).format(received));
  const candidates=[year-1,year,year+1].map((y)=>validDate(y,month,day)).filter((d):d is Date=>d!==null);
  if(!candidates.length)return null;
  candidates.sort((a,b)=>Math.abs(a.getTime()-received.getTime())-Math.abs(b.getTime()-received.getTime()));
  return isoDateInBangkok(candidates[0]);
}
export function dayDiff(aIso:string,bIso:string):number{
  const a=new Date(`${aIso}T12:00:00+07:00`).getTime(),b=new Date(`${bIso}T12:00:00+07:00`).getTime();
  return Math.round(Math.abs(a-b)/86400000);
}
export function minuteDiffSameDate(a:string,b:string):number{return Math.abs(minutesOf(a)-minutesOf(b));}
export function weekdayShort(dateIso:string):string{return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(`${dateIso}T12:00:00+07:00`).getUTCDay()]||"";}
export function weekStartMonday(workDate:string):string{
  const d=new Date(`${workDate}T12:00:00+07:00`),dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow);return d.toISOString().slice(0,10);
}
export function addDays(dateIso:string,days:number):string{const d=new Date(`${dateIso}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
