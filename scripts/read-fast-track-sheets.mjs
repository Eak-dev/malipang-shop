import {readFile} from 'node:fs/promises';
import {createSign} from 'node:crypto';

const credentialsPath=process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
const spreadsheetId=process.env.GOOGLE_SPREADSHEET_ID;
if(!credentialsPath||!spreadsheetId)throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE and GOOGLE_SPREADSHEET_ID are required');
const credentials=JSON.parse(await readFile(credentialsPath,'utf8'));
const now=Math.floor(Date.now()/1000);
const b64url=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
const input=`${b64url({alg:'RS256',typ:'JWT'})}.${b64url({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
const signature=createSign('RSA-SHA256').update(input).end().sign(credentials.private_key).toString('base64url');
const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${input}.${signature}`})});
if(!tokenResponse.ok)throw new Error(`Google OAuth HTTP ${tokenResponse.status}`);
const {access_token:token}=await tokenResponse.json();
const auth={authorization:`Bearer ${token}`};
const metaResponse=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties(title,timeZone),sheets.properties(sheetId,title,gridProperties)`,{headers:auth});
if(!metaResponse.ok)throw new Error(`Sheets metadata HTTP ${metaResponse.status}`);
const metadata=await metaResponse.json();
const ranges=["'V52_ATTENDANCE_RAW'!A14:Z17","'V52_DAILY_PAYROLL'!A9:P11","'V52_WEEKLY_PAYROLL'!A5:I7","'V52_EXPENSE_RAW'!A26:J30","'รายวัน'!A792:W795"];
const query=new URLSearchParams({valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'FORMATTED_STRING'});
for(const range of ranges)query.append('ranges',range);
const valuesResponse=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query}`,{headers:auth});
if(!valuesResponse.ok)throw new Error(`Sheets values HTTP ${valuesResponse.status}`);
const values=await valuesResponse.json();
console.log(JSON.stringify({
  metadata:{title:metadata.properties?.title,timeZone:metadata.properties?.timeZone,sheets:(metadata.sheets||[]).map(item=>item.properties)},
  ranges:(values.valueRanges||[]).map(item=>({range:item.range,values:item.values||[]}))
},null,2));
