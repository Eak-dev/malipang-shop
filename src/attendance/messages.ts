import { trilingual } from "../line/multilingual";
import type { AttendanceCommitResult, Employee } from "../types";

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
  const reviewThai = result.status === "REVIEW" ? "\nระบบบันทึกแล้ว และผู้ดูแลจะตรวจสอบข้อมูลเพิ่มเติม" : "";
  const reviewEnglish = result.status === "REVIEW" ? "\nRecorded. The administrator will review the details." : "";
  const reviewBurmese = result.status === "REVIEW" ? "\nမှတ်တမ်းတင်ပြီးပါပြီ။ စီမံခန့်ခွဲသူမှ ထပ်မံစစ်ဆေးပါမည်။" : "";
  return trilingual(
    `✅ บันทึกเวลา${isIn?"เข้า":"ออก"}งานเรียบร้อย\nชื่อ: ${employee.staffName}\nวันที่: ${result.workDate}\nเวลา: ${result.officialTime}${reviewThai}`,
    `✅ ${isIn?"Check-in":"Check-out"} recorded\nName: ${employee.staffName}\nDate: ${result.workDate}\nTime: ${result.officialTime}${reviewEnglish}`,
    `✅ ${isIn?"အလုပ်ဝင်ချိန်":"အလုပ်ဆင်းချိန်"} မှတ်တမ်းတင်ပြီးပါပြီ\nအမည်: ${employee.staffName}\nရက်စွဲ: ${result.workDate}\nအချိန်: ${result.officialTime}${reviewBurmese}`
  );
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