import { trilingual } from "../line/multilingual";
import type { AttendanceCommitResult, Employee } from "../types";

const statusText = (status: AttendanceCommitResult["status"]): { th: string; en: string; my: string } =>
  status === "NORMAL"
    ? {th:"ปกติ",en:"OK",my:"OK"}
    : {th:"ต้องตรวจสอบ",en:"Review required",my:"ပြန်လည်စစ်ဆေးရန် လိုအပ်သည်"};

export function buildAttendanceReply(employee: Employee, result: AttendanceCommitResult): string {
  if (result.punchType === "DUPLICATE") {
    return trilingual(
      "ระบบได้รับรูปนี้แล้วค่ะ ไม่ต้องส่งซ้ำ",
      "This photo has already been received. Please do not send it again.",
      "ဤဓာတ်ပုံကို စနစ်မှ လက်ခံရရှိပြီးပါပြီ။ ထပ်မံပေးပို့ရန် မလိုပါ။"
    );
  }
  if (result.punchType === "COMPLETE") {
    return trilingual(
      `วันนี้ ${employee.staffName} บันทึกเวลาเข้าและออกครบแล้วค่ะ หากต้องแก้ไขให้แจ้งผู้ดูแล`,
      `${employee.staffName}'s check-in and check-out are already complete for today. Contact the administrator if a correction is needed.`,
      `ယနေ့ ${employee.staffName} ၏ အလုပ်ဝင်ချိန်နှင့် အလုပ်ဆင်းချိန် နှစ်ခုလုံး မှတ်တမ်းတင်ပြီးပါပြီ။ ပြင်ဆင်ရန်လိုပါက စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။`
    );
  }

  const isIn = result.punchType === "IN";
  const status = statusText(result.status);
  const thai = [
    `บันทึกเวลา${isIn?"เข้า":"ออก"}งานเรียบร้อยค่ะ`,
    `ชื่อ: ${employee.staffName}`,
    `วันที่: ${result.workDate}`,
    `เวลา${isIn?"เข้า":"ออก"}งาน: ${result.officialTime}`,
    "อ้างอิงเวลา: Timestamp บนภาพ",
    "ตรวจ GPS: ผ่าน",
    "ยืนยันนาฬิการ้าน: ผ่าน",
    `สาย: ${result.lateMinutes} นาที`,
    `สถานะ: ${status.th}`
  ].join("\n");
  const english = [
    `${isIn?"Check-in":"Check-out"} recorded.`,
    `Name: ${employee.staffName}`,
    `Date: ${result.workDate}`,
    `${isIn?"Check-in":"Check-out"} time: ${result.officialTime}`,
    "Time source: Photo timestamp",
    "GPS check: Passed",
    "Shop clock evidence: Passed",
    `Late: ${result.lateMinutes} minutes`,
    `Status: ${status.en}`
  ].join("\n");
  const burmese = [
    `${isIn?"အလုပ်ဝင်ချိန်":"အလုပ်ဆင်းချိန်"} မှတ်တမ်းတင်ပြီးပါပြီ။`,
    `အမည်: ${employee.staffName}`,
    `ရက်စွဲ: ${result.workDate}`,
    `${isIn?"အလုပ်ဝင်ချိန်":"အလုပ်ဆင်းချိန်"}: ${result.officialTime}`,
    "အချိန်အရင်းအမြစ်: ဓာတ်ပုံ Timestamp",
    "GPS စစ်ဆေးမှု: အောင်မြင်",
    "ဆိုင်နာရီအထောက်အထား: အောင်မြင်",
    `နောက်ကျမှု: ${result.lateMinutes} မိနစ်`,
    `အခြေအနေ: ${status.my}`
  ].join("\n");
  return trilingual(thai, english, burmese);
}

export function attendanceNotAllowedMessage(): string {
  return trilingual(
    "ยังไม่บันทึกเวลาค่ะ ❌\nสาเหตุ: บัญชีนี้ไม่มีสิทธิ์ลงเวลา หรือระบบลงเวลายังไม่เปิด\nวิธีแก้: กรุณาติดต่อผู้ดูแลร้าน\nรหัส: ATTENDANCE_NOT_ALLOWED",
    "Attendance was not recorded. ❌\nReason: This account is not allowed to record attendance, or attendance is disabled.\nAction: Please contact the shop administrator.\nCode: ATTENDANCE_NOT_ALLOWED",
    "အလုပ်ချိန်ကို မှတ်တမ်းမတင်ရသေးပါ။ ❌\nအကြောင်းရင်း: ဤအကောင့်တွင် အလုပ်ချိန်မှတ်တမ်းတင်ခွင့်မရှိပါ သို့မဟုတ် စနစ်ပိတ်ထားပါသည်။\nဖြေရှင်းရန်: ဆိုင်စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။\nကုဒ်: ATTENDANCE_NOT_ALLOWED"
  );
}

export function unsupportedImageMessage(): string {
  return trilingual(
    "ยังไม่บันทึกรูปค่ะ ❌\nสาเหตุ: ระบบรองรับเฉพาะรูปที่ส่งเข้า LINE โดยตรง\nวิธีแก้: กรุณาส่งรูปต้นฉบับจากเมนูรูปภาพ\nรหัส: EXTERNAL_IMAGE",
    "The image was not recorded. ❌\nReason: Only images sent directly through LINE are supported.\nAction: Please send the original image from the photo menu.\nCode: EXTERNAL_IMAGE",
    "ဓာတ်ပုံကို မှတ်တမ်းမတင်ရသေးပါ။ ❌\nအကြောင်းရင်း: LINE မှ တိုက်ရိုက်ပေးပို့သော ဓာတ်ပုံများကိုသာ လက်ခံပါသည်။\nဖြေရှင်းရန်: ဓာတ်ပုံမီနူးမှ မူရင်းဓာတ်ပုံကို ပေးပို့ပါ။\nကုဒ်: EXTERNAL_IMAGE"
  );
}

export function unauthorizedImageMessage(): string {
  return trilingual(
    "ยังไม่บันทึกรูปค่ะ ❌\nสาเหตุ: ไม่พบพนักงานหรือสิทธิ์สำหรับรับรูปนี้\nวิธีแก้: กรุณาติดต่อผู้ดูแลร้านเพื่อตรวจ LINE User ID และสถานะพนักงาน\nรหัส: UNAUTHORIZED_IMAGE",
    "The image was not recorded. ❌\nReason: No active employee or image permission was found for this account.\nAction: Ask the shop administrator to check the LINE User ID and employee status.\nCode: UNAUTHORIZED_IMAGE",
    "ဓာတ်ပုံကို မှတ်တမ်းမတင်ရသေးပါ။ ❌\nအကြောင်းရင်း: ဤအကောင့်အတွက် ဝန်ထမ်းအချက်အလက် သို့မဟုတ် ဓာတ်ပုံပေးပို့ခွင့် မတွေ့ပါ။\nဖြေရှင်းရန်: LINE User ID နှင့် ဝန်ထမ်းအခြေအနေကို စစ်ဆေးရန် ဆိုင်စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။\nကုဒ်: UNAUTHORIZED_IMAGE"
  );
}
