import { isoDateInBangkok } from "../shared/time";
export interface ParsedExpenseText{description:string;amountSatang:number;paymentKey:string;sourceWallet:string;category:string;transactionDate:string;quickSave:boolean}
const cashTokens=new Set(["ทอน","change","drawer","front","frontcash","cashbox","till","cash","เงิน","เงินสด","สด"]),transferTokens=new Set(["โอน","transfer","bank","qr","online","onlineqr","promptpay","pp","พร้อมเพย์"]);
const cardAliases:Record<string,string>={
  kbank:"kbank",kb:"kbank",kasikorn:"kbank",
  firstchoice:"firstchoice",fc:"firstchoice",first:"firstchoice",
  aeon:"aeon",citibank:"citibank",citi:"citibank",
  ttb:"ttb",thanachart:"ttb",homepro:"homepro",hp:"homepro",
  t1:"t1",theone:"t1",the_one:"t1"
},cardTokens=new Set(Object.keys(cardAliases));
const cardWallets:Record<string,string>={kbank:"CARD_KBANK",firstchoice:"CARD_FIRST_CHOICE",aeon:"CARD_AEON",citibank:"CARD_CITIBANK",ttb:"CARD_TTB",homepro:"CARD_HOMEPRO",t1:"CARD_THE1"};
function validIso(year:number,month:number,day:number):string|null{
  if(!Number.isInteger(year)||!Number.isInteger(month)||!Number.isInteger(day)||year<2000||year>9999||month<1||month>12||day<1||day>31)return null;
  const iso=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`,d=new Date(`${iso}T12:00:00+07:00`);
  return Number.isFinite(d.getTime())&&isoDateInBangkok(d)===iso?iso:null;
}
export function parseExpenseText(text:string,now=new Date()):ParsedExpenseText|null{
  let s=text.trim(),transactionDate=isoDateInBangkok(now);const currentYear=Number(transactionDate.slice(0,4));
  const dmy=/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+/.exec(s),iso=/^(\d{4})-(\d{1,2})-(\d{1,2})\s+/.exec(s);
  if(dmy){let year=dmy[3]?Number(dmy[3]):currentYear;if(year<100)year+=2000;const parsed=validIso(year,Number(dmy[2]),Number(dmy[1]));if(!parsed)return null;transactionDate=parsed;s=s.slice(dmy[0].length);}else if(iso){const parsed=validIso(Number(iso[1]),Number(iso[2]),Number(iso[3]));if(!parsed)return null;transactionDate=parsed;s=s.slice(iso[0].length);}
  const parts=s.split(/\s+/).filter(Boolean);if(parts.length<2)return null;
  const amountText=String(parts.at(-1)||"");if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amountText))return null;
  const amountBaht=Number(amountText.replace(/,/g,"")),amountSatang=Math.round(amountBaht*100);if(!Number.isFinite(amountBaht)||amountBaht<=0||!Number.isSafeInteger(amountSatang)||amountSatang<=0)return null;
  const candidate=parts.length>=3?String(parts.at(-2)).toLowerCase():"",hasPaymentToken=cashTokens.has(candidate)||transferTokens.has(candidate)||cardTokens.has(candidate),middle=hasPaymentToken?candidate:"",description=parts.slice(0,parts.length-(hasPaymentToken?2:1)).join(" ").trim();if(!description)return null;
  let paymentKey="cash",sourceWallet="CASH_DRAWER",quickSave=false;
  if(cashTokens.has(middle)){quickSave=middle==="ทอน"||middle==="change";}else if(transferTokens.has(middle)){paymentKey="transfer";sourceWallet="SHOP_BANK";quickSave=middle==="โอน";}else if(cardTokens.has(middle)){const canonical=cardAliases[middle];if(!canonical)throw new Error("Expense card alias is not configured");paymentKey=canonical;sourceWallet=cardWallets[paymentKey]||"SHOP_BANK";}
  return{description,amountSatang,paymentKey,sourceWallet,category:autoCategory(description),transactionDate,quickSave};
}
export function autoCategory(desc:string):string{
  const s=desc.toLowerCase(),has=(keywords:string[])=>keywords.some(keyword=>s.includes(keyword)),hasWord=(keywords:string[])=>keywords.some(keyword=>new RegExp(`(?:^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:$|[^a-z0-9])`,"i").test(s));
  if(has(["น้ำมัน","ค่าน้ำมัน","ขนส่ง","ส่งของ","ค่าจอดรถ","grab","lineman","fuel","gasoline","delivery","transport","shipping","parking"]))return"transport";
  if(has(["ค่าไฟ","ค่าน้ำ","อินเทอร์เน็ต","internet","wifi","wi-fi","โทรศัพท์","phone","electric","electricity","water bill"])||hasWord(["water"]))return"utilities";
  if(has(["กล่อง","ถุง","ซีล","สติ๊กเกอร์","สติกเกอร์","เทป","แพ็ค","ถุงมือ","ซองกันชื้น","packaging","box","boxes","bag","bags","sticker","seal","tape","pack","glove","gloves"]))return"packaging";
  if(has(["แก๊ส","lpg","alumax"])||hasWord(["gas"]))return"gas";
  if(has(["ค่าเช่า","ค่าส่วนกลาง","ภาษีที่ดิน","rent","common fee","service charge","land tax"]))return"rent";
  if(has(["ไส้กวน","สังขยา","เผือก","ถั่วแดง","บลูเบอร์รี่","ฟิลลิ่ง","filling","fillings","custard","pandan","taro","red bean","blueberry"]))return"fillings";
  if(has(["แป้ง","ไข่","น้ำตาล","ยีสต์","นม","เนย","มาการีน","วัตถุดิบ","ไส้กรอก","แฮม","หมูหยอง","ข้าวโพด","ลูกเกด","ชีส","flour","egg","eggs","sugar","yeast","milk","butter","margarine","ham","sausage","pork floss","corn","raisin","raisins","cheese","mayonnaise","mayo","ketchup","truffle","tuna","crab stick","crabstick"]))return"ingredients";
  if(has(["เครื่อง","ซ่อม","อุปกรณ์","equipment","repair","machine","ตะกร้อ","ช้อน","ส้อม","salad spinner","tool","tools"]))return"equipment";
  if(has(["ค่าแรง","เงินเดือน","salary","wage","staff","payroll","labor","labour"]))return"staff";
  if(has(["น้ำยาล้าง","ทำความสะอาด","cleaner","detergent","sponge"]))return"cleaning";
  if(has(["ค่าธรรมเนียม","bank fee","service fee"])||hasWord(["fee"]))return"bank_fee";
  if(has(["แอด","โฆษณา","ยิงแอด","ป้าย","facebook","marketing","poster","signage"])||hasWord(["ad","ads"]))return"marketing";
  return"general";
}
