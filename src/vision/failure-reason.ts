import type { VisionResult } from "../types";
import { trilingual } from "../line/multilingual";

export interface VisionRejection {
  code: string;
  message: string;
}

interface Translation { reason: string; action: string }

function rejection(code: string, thai: Translation, english: Translation, burmese: Translation, subject = "รูป"): VisionRejection {
  return {
    code,
    message: trilingual(
      `ยังไม่บันทึก${subject}ค่ะ ❌\nสาเหตุ: ${thai.reason}\nวิธีแก้: ${thai.action}\nรหัส: ${code}`,
      `Attendance image was not recorded. ❌\nReason: ${english.reason}\nAction: ${english.action}\nCode: ${code}`,
      `အလုပ်ချိန်ဓာတ်ပုံကို မှတ်တမ်းမတင်ရသေးပါ။ ❌\nအကြောင်းရင်း: ${burmese.reason}\nဖြေရှင်းရန်: ${burmese.action}\nကုဒ်: ${code}`
    )
  };
}

export function describeVisionRejection(reading: VisionResult): VisionRejection {
  if (reading.provider === "budget-guard") {
    return rejection(
      "VISION_DAILY_LIMIT",
      {reason:"ระบบอ่านรูปครบโควตาประจำวันแล้ว รูปของคุณไม่ได้ผิด",action:"ไม่ต้องถ่ายใหม่ กรุณาแจ้งผู้ดูแลร้านเพื่อเปิดโควตาเพิ่ม"},
      {reason:"The daily image-reading quota has been reached. Your photo is not at fault.",action:"Do not retake the photo. Please contact the shop administrator."},
      {reason:"နေ့စဉ် ဓာတ်ပုံဖတ်ရှုမှု ကန့်သတ်ချက် ပြည့်သွားပါပြီ။ သင့်ဓာတ်ပုံတွင် အမှားမရှိပါ။",action:"ဓာတ်ပုံအသစ် မရိုက်ပါနှင့်။ ဆိုင်စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။"}
    );
  }
  if (reading.provider === "openai-error") {
    return rejection(
      "VISION_SERVICE_ERROR",
      {reason:"บริการ AI อ่านรูปขัดข้องชั่วคราว",action:"กรุณาส่งรูปเดิมอีกครั้งใน 1–2 นาที หากยังไม่ผ่านให้แจ้งผู้ดูแลร้าน"},
      {reason:"The AI image-reading service is temporarily unavailable.",action:"Send the same photo again in 1–2 minutes. Contact the administrator if it still fails."},
      {reason:"AI ဓာတ်ပုံဖတ်ရှုမှု ဝန်ဆောင်မှု ယာယီချို့ယွင်းနေပါသည်။",action:"၁–၂ မိနစ်အကြာတွင် ဓာတ်ပုံတူကို ပြန်ပို့ပါ။ မအောင်မြင်သေးပါက စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။"}
    );
  }
  if (reading.provider === "none") {
    return rejection(
      "VISION_NOT_AVAILABLE",
      {reason:"ระบบอ่านรูปยังไม่พร้อมใช้งาน",action:"กรุณาแจ้งผู้ดูแลร้าน ไม่จำเป็นต้องถ่ายรูปใหม่"},
      {reason:"The image-reading system is not available.",action:"Please contact the shop administrator. You do not need to retake the photo."},
      {reason:"ဓာတ်ပုံဖတ်ရှုမှုစနစ် အသင့်မဖြစ်သေးပါ။",action:"ဆိုင်စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။ ဓာတ်ပုံအသစ်ရိုက်ရန် မလိုပါ။"}
    );
  }
  if (reading.kind === "CLOCK") {
    if (reading.hour == null || reading.minute == null || reading.month == null || reading.day == null || reading.needsNewPhoto) {
      return rejection(
        "CLOCK_FIELDS_MISSING",
        {reason:"อ่านเวลา เดือน หรือวันที่บนหน้าปัดได้ไม่ครบ",action:"ถ่ายให้เห็นนาฬิกาทั้งเรือน ตัวเลขไม่เบลอและไม่มีแสงสะท้อน"},
        {reason:"The time, month, or day could not be read completely.",action:"Photograph the whole clock with sharp digits and no glare."},
        {reason:"နာရီ၊ လ သို့မဟုတ် ရက်ကို အပြည့်အစုံ မဖတ်နိုင်ပါ။",action:"နာရီတစ်ခုလုံးနှင့် ဂဏန်းများ ပြတ်သားပြီး အလင်းပြန်မှုမရှိအောင် ရိုက်ပါ။"},
        "เวลา"
      );
    }
    return rejection(
      "CLOCK_NOT_ACCEPTED",
      {reason:"ข้อมูลจากหน้าปัดยังไม่ผ่านเงื่อนไขลงเวลา",action:"ถ่ายให้ตรงหน้าปัดและเห็นเวลา เดือน และวันที่ครบ"},
      {reason:"The clock data did not pass attendance validation.",action:"Photograph the clock straight on with the time, month, and day visible."},
      {reason:"နာရီအချက်အလက်သည် အလုပ်ချိန်စစ်ဆေးမှု မအောင်မြင်ပါ။",action:"အချိန်၊ လနှင့် ရက်အားလုံး မြင်ရအောင် နာရီကို တည့်တည့်ရိုက်ပါ။"},
      "เวลา"
    );
  }
  return rejection(
    "IMAGE_KIND_UNKNOWN",
    {reason:"AI ไม่พบหน้าปัดนาฬิการ้านที่ชัดพอ",action:"ส่งภาพต้นฉบับและถ่ายนาฬิกาให้เต็มภาพ ตัวเลขไม่เบลอ ไม่มืด และไม่สะท้อนแสง"},
    {reason:"The AI could not clearly identify the shop wall clock.",action:"Send the original image with the full clock visible, sharp, bright, and without glare."},
    {reason:"AI သည် ဆိုင်နံရံကပ်နာရီကို ရှင်းလင်းစွာ မတွေ့ရှိနိုင်ပါ။",action:"နာရီတစ်ခုလုံး ပြတ်သား၊ လင်းပြီး အလင်းပြန်မှုမရှိသော မူရင်းဓာတ်ပုံကို ပေးပို့ပါ။"}
  );
}

export function describeClockValidationFailure(code: string): VisionRejection {
  const cases: Record<string, { th: Translation; en: Translation; my: Translation }> = {
    NOT_CLOCK: {
      th:{reason:"รูปนี้ไม่ใช่หน้าปัดนาฬิกาของร้าน",action:"ถ่ายนาฬิกาสีดำของร้านให้เห็นทั้งเรือน"},
      en:{reason:"This is not the shop wall clock.",action:"Photograph the entire black shop clock."},
      my:{reason:"ဤပုံသည် ဆိုင်နံရံကပ်နာရီ မဟုတ်ပါ။",action:"ဆိုင်ရှိ အနက်ရောင်နာရီတစ်ခုလုံးကို ရိုက်ပါ။"}
    },
    CLOCK_FIELDS_MISSING: {
      th:{reason:"อ่านเวลา เดือน หรือวันที่บนหน้าปัดได้ไม่ครบ",action:"ถ่ายให้เห็นนาฬิกาทั้งเรือน ตัวเลขไม่เบลอและไม่มีแสงสะท้อน"},
      en:{reason:"The time, month, or day could not be read completely.",action:"Photograph the whole clock with sharp digits and no glare."},
      my:{reason:"နာရီ၊ လ သို့မဟုတ် ရက်ကို အပြည့်အစုံ မဖတ်နိုင်ပါ။",action:"နာရီတစ်ခုလုံးနှင့် ဂဏန်းများ ပြတ်သားပြီး အလင်းပြန်မှုမရှိအောင် ရိုက်ပါ။"}
    },
    CLOCK_VALUE_OUT_OF_RANGE: {
      th:{reason:"ค่าที่อ่านจากหน้าปัดอยู่นอกช่วงเวลาหรือวันที่ที่ถูกต้อง",action:"ถ่ายใหม่ให้ตรงหน้าปัดและเห็นตัวเลขครบทุกหลัก"},
      en:{reason:"The clock values are outside a valid time or date range.",action:"Retake the photo straight on with every digit visible."},
      my:{reason:"နာရီမှဖတ်ရသော တန်ဖိုးသည် မှန်ကန်သော အချိန် သို့မဟုတ် ရက်စွဲအတွင်း မရှိပါ။",action:"ဂဏန်းအားလုံးမြင်ရအောင် တည့်တည့်ပြန်ရိုက်ပါ။"}
    },
    CLOCK_LOW_CONFIDENCE: {
      th:{reason:"AI อ่านตัวเลขได้ไม่มั่นใจพอ จึงไม่เดาเวลาให้",action:"ขยับเข้าใกล้ ถ่ายตรงหน้าปัด และหลีกเลี่ยงภาพเบลอหรือแสงสะท้อน"},
      en:{reason:"The AI was not confident enough to read the digits and will not guess.",action:"Move closer, face the clock directly, and avoid blur or glare."},
      my:{reason:"AI သည် ဂဏန်းများကို ယုံကြည်စိတ်ချစွာ မဖတ်နိုင်သဖြင့် ခန့်မှန်းမည်မဟုတ်ပါ။",action:"ပိုနီးကပ်၍ တည့်တည့်ရိုက်ပြီး မှုန်ဝါးခြင်းနှင့် အလင်းပြန်ခြင်းကို ရှောင်ပါ။"}
    },
    CLOCK_INVALID_CALENDAR_DATE: {
      th:{reason:"เดือนและวันที่ที่อ่านได้ไม่เป็นวันที่จริง",action:"ตรวจหน้าปัดแล้วถ่ายใหม่ให้เห็นเดือนและวันที่ชัดเจน"},
      en:{reason:"The detected month and day do not form a valid calendar date.",action:"Check the clock and retake a clear photo of the month and day."},
      my:{reason:"ဖတ်ရသော လနှင့်ရက်သည် မှန်ကန်သော ပြက္ခဒိန်ရက်စွဲ မဟုတ်ပါ။",action:"နာရီကို စစ်ဆေးပြီး လနှင့်ရက်ကို ရှင်းလင်းစွာ ပြန်ရိုက်ပါ။"}
    },
    CLOCK_DATE_MISMATCH: {
      th:{reason:"วันที่บนหน้าปัดต่างจากวันที่ส่งรูปเกินช่วงที่ระบบอนุญาต",action:"ตรวจวันที่บนตัวนาฬิกาและถ่ายรูปของวันปัจจุบันใหม่"},
      en:{reason:"The clock date differs too much from the date the photo was sent.",action:"Check the clock date and take a new photo today."},
      my:{reason:"နာရီပေါ်ရှိရက်စွဲနှင့် ဓာတ်ပုံပို့သည့်ရက်စွဲ အလွန်ကွာခြားနေပါသည်။",action:"နာရီရက်စွဲကို စစ်ဆေးပြီး ယနေ့ဓာတ်ပုံအသစ် ရိုက်ပါ။"}
    }
  };
  const detail = cases[code] || {
    th:{reason:"ข้อมูลจากหน้าปัดยังไม่ผ่านเงื่อนไขลงเวลา",action:"ถ่ายให้ตรงหน้าปัดและเห็นเวลา เดือน และวันที่ครบ"},
    en:{reason:"The clock data did not pass attendance validation.",action:"Photograph the clock straight on with the time, month, and day visible."},
    my:{reason:"နာရီအချက်အလက်သည် အလုပ်ချိန်စစ်ဆေးမှု မအောင်မြင်ပါ။",action:"အချိန်၊ လနှင့်ရက် မြင်ရအောင် နာရီကို တည့်တည့်ရိုက်ပါ။"}
  };
  return rejection(code || "CLOCK_NOT_ACCEPTED", detail.th, detail.en, detail.my, "เวลา");
}
