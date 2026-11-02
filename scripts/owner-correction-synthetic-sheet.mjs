// Offline-only fixture builder. Never opens a network connection or writes a
// Google account. All cell values are fixed synthetic examples. Formula-only
// inputs must match the verifier's pinned fingerprints before use.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const MONTH_DIGEST='a0527cc06ec7543c6cdf87beff0fea5ed6d2ceeeaee966036e9ca10b86201f75';
const FLOW_DIGEST='5e49405e4b8d63dc3470610e5c941c5fc105969991b3be85e684bc4e23fe9043';
const EXTERNAL=/https?:\/\/|\b(?:IMPORTRANGE|IMPORTDATA|IMPORTXML|IMPORTHTML|GOOGLEFINANCE|HYPERLINK|WEBSERVICE|INDIRECT|IMAGE)\s*\(|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const sheets=[['รายวัน',1001,4500,26],['V52_EXPENSE_RAW',1002,4500,26],['รายละเอียดการซื้อ',1003,4500,20],['97_EXPENSE_CLEAN',1004,4500,8],['04_OWNER_MONTH_CLOSE',1005,800,23],['35_EXPENSE_FLOW_CHECK',1006,80,7]];
const text=value=>({userEnteredValue:{stringValue:value}});
const num=value=>({userEnteredValue:{numberValue:value}});
const formula=value=>({userEnteredValue:{formulaValue:value}});
const write=(sheetId,rowIndex,columnIndex,values)=>({updateCells:{start:{sheetId,rowIndex,columnIndex},rows:[{values}],fields:'userEnteredValue'}});

function normalize(formula,minimum){
  if(typeof formula!=='string'||!formula.startsWith('=')||formula.length>10000||EXTERNAL.test(formula))return null;
  let bad=false;const ends=new Set();const normalized=formula.replace(/('รายวัน'!\$?[A-Z]+\$?5:\$?[A-Z]+\$?)(\d+)/g,(_m,prefix,last)=>{const end=Number(last);if(!Number.isSafeInteger(end)||end<minimum)bad=true;ends.add(end);return `${prefix}<ROW_END>`;});
  return bad||ends.size>1?null:{normalized,endRow:ends.size?[...ends][0]:null};
}
const digest=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** Reject values, extra fields, imports, truncated ranges, and wrong SHA. */
export function verifyFormulaBundle(bundle){
  if(!bundle||typeof bundle!=='object'||Array.isArray(bundle)||JSON.stringify(Object.keys(bundle).sort())!==JSON.stringify(['clean','flow','month'])||!Array.isArray(bundle.month)||bundle.month.length!==14||!Array.isArray(bundle.flow)||bundle.flow.length!==368||typeof bundle.clean!=='string')return false;
  const month=[...bundle.month,bundle.clean].map((x,i)=>normalize(x,i===14?3421:3684)),flow=bundle.flow.map(x=>normalize(x,3421));
  if(month.some(x=>!x)||!month[14]?.endRow||flow.some(x=>!x))return false;
  const ends=new Set(flow.flatMap(x=>x.endRow?[x.endRow]:[]));if(ends.size!==1)return false;
  return digest(month.map(x=>x.normalized))===MONTH_DIGEST&&digest(flow.map(x=>x.normalized))===FLOW_DIGEST;
}

/** The skeleton is deliberately not verifier-ready and cannot certify UAT. */
export function makeSyntheticSheetFixture(bundle=null){
  if(bundle!==null&&!verifyFormulaBundle(bundle))throw new Error('FORMULA_BUNDLE_NOT_VERIFIED');
  const month=bundle?.month??Array(14).fill('=0'),clean=bundle?.clean??'=0',flow=bundle?.flow??['=0','=SEQUENCE(61,1,DATE(2026,11,1),1)',...Array(366).fill('=0')];
  const requests=[
    write(1001,0,0,[text('QA ONLY — SYNTHETIC DATA')]),
    write(1001,1,7,[text('เงินโอน'),text('ยอดรวม'),text(''),num(20)]),
    write(1001,2,6,[text('NON-FIXED'),text('เงินโอน'),text(''),text(''),text('Kbank')]),
    write(1001,4,0,[num(2026)]),
    write(1001,5,1,[num(11),text(''),text('รายรับทั้งหมดในบัญชี')]),
    write(1001,6,1,[num(11),num(2),text('SYNTHETIC UAT EXPENSE'),text(''),text(''),text(''),num(100),formula('=SUM(F7:H7)')]),
    write(1001,6,17,[formula('=SUM(K7:Q7)'),text(''),text(''),formula('=DATE(2026,11,2)'),text('general'),text('บัญชีร้าน')]),
    write(1001,7,0,[text('รวม'),num(11)]),
    write(1001,8,1,[num(12),text(''),text('รายรับทั้งหมดในบัญชี')]),
    write(1001,10,0,[text('รวม'),num(12)]),
    write(1002,0,0,[text('Synthetic expense ID'),text('Payment date'),text('Description'),text('Amount'),text('Payment'),text('Wallet'),text('Category'),text('Status')]),
    write(1002,1,0,[text('exp_uat_synthetic'),text('2026-11-02'),text('SYNTHETIC UAT EXPENSE'),num(100),text('transfer'),text('SHOP_BANK'),text('general'),text('CONFIRMED')]),
    write(1003,0,0,[text('Synthetic receipt item ID'),text('Synthetic expense ID'),text('Synthetic document ID')]),
    write(1005,1,2,[formula('=DATE(2026,11,1)')]),
    write(1005,11,1,[formula(month[0])]),
    ...month.slice(1,13).map((f,i)=>write(1005,23+i,2,[formula(f)])),
    write(1005,13,11,[formula(month[13])]),write(1004,1,0,[formula(clean)]),
    write(1006,1,0,[formula(flow[0])]),write(1006,4,0,[formula(flow[1])]),
    ...Array.from({length:61},(_,i)=>write(1006,4+i,1,flow.slice(2+i*6,2+(i+1)*6).map(formula))),
    {createDeveloperMetadata:{developerMetadata:{metadataId:900001,metadataKey:'malipang_expense_daily',metadataValue:'exp_uat_synthetic',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:1001,dimension:'ROWS',startIndex:6,endIndex:7}}}}},
    {createDeveloperMetadata:{developerMetadata:{metadataId:900002,metadataKey:'malipang_expense_raw',metadataValue:'exp_uat_synthetic',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:1002,dimension:'ROWS',startIndex:1,endIndex:2}}}}}
  ];
  return {kind:'LOCAL_SYNTHETIC_FIXTURE',formulaStatus:bundle?'PINNED_DIGEST_MATCH':'PLACEHOLDER_NOT_VERIFIER_READY',safeForRemote:false,
    outstanding:['ISOLATED_GOOGLE_ACCOUNT_AND_WORKER_BINDING','FORMULA_CONTENT_PRIVACY_REVIEW','LIVE_SHARING_AND_SCRIPT_INSPECTION','PROTECTED_RANGE_SETUP_AND_READBACK','D1_SYNTHETIC_DATA_AND_LINE_CHANNEL','LIVE_UAT_NOT_RUN'],
    create:{properties:{title:'QA_ONLY_OWNER_CORRECTION_SYNTHETIC',timeZone:'Asia/Bangkok'},sheets:sheets.map(([title,sheetId,rowCount,columnCount])=>({properties:{title,sheetId,gridProperties:{rowCount,columnCount}}}))},batchUpdate:{requests}};
}

async function main(){
  const args=process.argv.slice(2);let output='',bundlePath='';
  for(let i=0;i<args.length;i++){if(args[i]==='--output')output=args[++i]||'';else if(args[i]==='--formula-only-bundle')bundlePath=args[++i]||'';else throw Error('INVALID_ARGUMENT');}
  if(!output)throw Error('OUTPUT_REQUIRED');
  const bundle=bundlePath?JSON.parse(await readFile(bundlePath,'utf8')):null,result=makeSyntheticSheetFixture(bundle);
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({kind:result.kind,formulaStatus:result.formulaStatus,safeForRemote:result.safeForRemote})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await main()}catch(error){process.stderr.write(`Fixture creation failed: ${error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_ERROR'}\n`);process.exitCode=1}}
