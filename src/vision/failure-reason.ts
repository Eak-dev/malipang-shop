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
    if (!reading.overlayPresent || !reading.photoDate || !reading.photoTime || reading.latitude == null || reading.longitude == null || reading.needsNewPhoto) {
      return rejection(
        "ATTENDANCE_OVERLAY_INCOMPLETE",
        {reason:"อ่าน Timestamp หรือพิกัด GPS สีขาวบนภาพได้ไม่ครบ",action:"เปิดกล้องที่แสดงวันที่ เวลา และพิกัดเป็นตัวหนังสือสีขาว แล้วถ่ายให้เห็นนาฬิการ้านด้วย"},
        {reason:"The white timestamp or GPS overlay could not be read completely.",action:"Use a camera overlay showing date, time, and GPS in white, with the shop clock visible too."},
        {reason:"ဓာတ်ပုံပေါ်ရှိ အဖြူရောင် Timestamp သို့မဟုတ် GPS ကို အပြည့်အစုံ မဖတ်နိုင်ပါ။",action:"ရက်စွဲ၊ အချိန်နှင့် GPS ကို အဖြူရောင်ဖြင့်ပြပြီး ဆိုင်နာရီပါ မြင်ရအောင် ရိုက်ပါ။"},
        "เวลา"
      );
    }
    return rejection(
      "CLOCK_NOT_ACCEPTED",
      {reason:"รูปยังไม่ผ่านเงื่อนไข Timestamp, GPS หรือนาฬิการ้าน",action:"ถ่ายใหม่ให้เห็น Overlay สีขาวและนาฬิการ้านชัดเจน"},
      {reason:"The photo did not pass timestamp, GPS, or shop-clock validation.",action:"Retake it with the white overlay and shop clock clearly visible."},
      {reason:"ဓာတ်ပုံသည် Timestamp၊ GPS သို့မဟုတ် ဆိုင်နာရီ စစ်ဆေးမှု မအောင်မြင်ပါ။",action:"အဖြူရောင် Overlay နှင့် ဆိုင်နာရီ ရှင်းလင်းစွာ မြင်ရအောင် ပြန်ရိုက်ပါ။"},
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
    CLOCK_NOT_CONFIRMED:{th:{reason:"AI ยังยืนยันนาฬิกาประจำร้านในภาพไม่ได้",action:"ถ่ายให้เห็นนาฬิกาสีดำของร้านชัดเจนพร้อม Overlay สีขาว"},en:{reason:"The shop wall clock could not be confirmed in the photo.",action:"Retake it with the black shop clock and white overlay clearly visible."},my:{reason:"ဓာတ်ပုံထဲရှိ ဆိုင်နံရံကပ်နာရီကို အတည်မပြုနိုင်ပါ။",action:"အနက်ရောင်ဆိုင်နာရီနှင့် အဖြူရောင် Overlay ရှင်းလင်းစွာ မြင်ရအောင် ပြန်ရိုက်ပါ။"}},
    TIMESTAMP_MISSING:{th:{reason:"ไม่พบ Timestamp และตำแหน่งที่เป็นตัวหนังสือสีขาวบนภาพ",action:"เปิดการประทับวันที่ เวลา และตำแหน่งในแอปกล้องแล้วถ่ายใหม่"},en:{reason:"No white timestamp and location overlay was found.",action:"Enable the camera's date, time, and location overlay and retake the photo."},my:{reason:"အဖြူရောင် Timestamp နှင့် တည်နေရာ Overlay မတွေ့ပါ။",action:"ကင်မရာတွင် ရက်စွဲ၊ အချိန်နှင့် တည်နေရာ Overlay ဖွင့်ပြီး ပြန်ရိုက်ပါ။"}},
    TIMESTAMP_NOT_WHITE:{th:{reason:"Timestamp หรือตำแหน่งบนภาพไม่ได้เป็นตัวหนังสือสีขาว",action:"ตั้งค่า Overlay ให้เป็นสีขาวแล้วถ่ายใหม่"},en:{reason:"The timestamp or location overlay is not white.",action:"Set the overlay text to white and retake the photo."},my:{reason:"Timestamp သို့မဟုတ် တည်နေရာ Overlay သည် အဖြူရောင်မဟုတ်ပါ။",action:"Overlay စာသားကို အဖြူရောင်ထားပြီး ပြန်ရိုက်ပါ။"}},
    TIMESTAMP_FIELDS_MISSING:{th:{reason:"อ่านวันที่หรือเวลาจาก Overlay สีขาวได้ไม่ครบ",action:"ถ่ายใหม่ให้ตัวหนังสือวันที่และเวลาคมชัด ไม่ถูกตัด"},en:{reason:"The date or time in the white overlay is incomplete.",action:"Retake it with sharp, uncropped date and time text."},my:{reason:"အဖြူရောင် Overlay မှ ရက်စွဲ သို့မဟုတ် အချိန် မပြည့်စုံပါ။",action:"ရက်စွဲနှင့်အချိန် စာသားပြတ်သားပြီး မဖြတ်တောက်အောင် ပြန်ရိုက်ပါ။"}},
    TIMESTAMP_LOW_CONFIDENCE:{th:{reason:"AI อ่าน Timestamp สีขาวได้ไม่มั่นใจพอ",action:"ถ่ายใหม่ให้ตัวหนังสือไม่เบลอและไม่ทับวัตถุสีอ่อน"},en:{reason:"The AI was not confident enough in the white timestamp.",action:"Retake it with sharp text that does not overlap a light background."},my:{reason:"AI သည် အဖြူရောင် Timestamp ကို ယုံကြည်စိတ်ချစွာ မဖတ်နိုင်ပါ။",action:"စာသားမမှုန်ဘဲ အလင်းရောင်နောက်ခံနှင့် မထပ်အောင် ပြန်ရိုက်ပါ။"}},
    TIMESTAMP_INVALID:{th:{reason:"วันที่หรือเวลาบน Overlay ไม่ใช่ค่าที่ถูกต้อง",action:"ตรวจวันที่เวลาในแอปกล้องแล้วถ่ายใหม่"},en:{reason:"The overlay date or time is invalid.",action:"Check the camera date and time and retake the photo."},my:{reason:"Overlay ရက်စွဲ သို့မဟုတ် အချိန် မမှန်ကန်ပါ။",action:"ကင်မရာရက်စွဲနှင့်အချိန်ကို စစ်ဆေးပြီး ပြန်ရိုက်ပါ။"}},
    LOCATION_TEXT_MISSING:{th:{reason:"ไม่พบชื่อสถานที่หรือที่อยู่ในตราประทับสีขาว",action:"เปิดให้แอปกล้องแสดงชื่อสถานที่หรือที่อยู่พร้อม Timestamp และ GPS แล้วถ่ายใหม่"},en:{reason:"No place name or address was found in the white overlay.",action:"Enable the camera overlay for place/address, timestamp, and GPS, then retake the photo."},my:{reason:"အဖြူရောင် Overlay တွင် နေရာအမည် သို့မဟုတ် လိပ်စာ မတွေ့ပါ။",action:"နေရာ/လိပ်စာ၊ Timestamp နှင့် GPS Overlay ကိုဖွင့်ပြီး ပြန်ရိုက်ပါ။"}},
    GPS_MISSING:{th:{reason:"ไม่พบพิกัด Latitude/Longitude บนภาพ",action:"เปิด GPS และให้ Overlay แสดงตัวเลขพิกัดแล้วถ่ายใหม่"},en:{reason:"Latitude and longitude were not found in the photo.",action:"Enable GPS and show numeric coordinates in the overlay, then retake it."},my:{reason:"ဓာတ်ပုံတွင် Latitude/Longitude မတွေ့ပါ။",action:"GPS ဖွင့်ပြီး Overlay တွင် ဂဏန်းပုံစံ ပင်ကိုဩဒိနိတ်ပြကာ ပြန်ရိုက်ပါ။"}},
    GPS_VALUE_OUT_OF_RANGE:{th:{reason:"ค่าพิกัด GPS บนภาพไม่ถูกต้อง",action:"เปิด GPS ให้จับตำแหน่งใหม่แล้วถ่ายอีกครั้ง"},en:{reason:"The GPS coordinates in the photo are invalid.",action:"Refresh the GPS location and retake the photo."},my:{reason:"ဓာတ်ပုံရှိ GPS ပင်ကိုဩဒိနိတ် မမှန်ကန်ပါ။",action:"GPS တည်နေရာကို ပြန်ယူပြီး ဓာတ်ပုံပြန်ရိုက်ပါ။"}},
    STORE_LOCATION_NOT_CONFIGURED:{th:{reason:"ระบบยังไม่ได้ตั้งค่าพิกัดร้าน",action:"ไม่ต้องถ่ายใหม่ กรุณาแจ้งผู้ดูแลระบบ"},en:{reason:"The shop coordinates are not configured.",action:"Do not retake the photo. Contact the administrator."},my:{reason:"ဆိုင်ပင်ကိုဩဒိနိတ်ကို စနစ်တွင် မသတ်မှတ်ရသေးပါ။",action:"ဓာတ်ပုံအသစ် မရိုက်ပါနှင့်။ စီမံခန့်ခွဲသူကို ဆက်သွယ်ပါ။"}},
    OUTSIDE_STORE_RADIUS:{th:{reason:"พิกัดบนภาพอยู่นอกรัศมีร้าน",action:"ไปยังจุดร้านมะลิปัง รอให้ GPS จับตำแหน่ง แล้วถ่ายใหม่"},en:{reason:"The photo coordinates are outside the shop radius.",action:"Go to the MaliPang shop, wait for GPS to update, and retake it."},my:{reason:"ဓာတ်ပုံပင်ကိုဩဒိနိတ်သည် ဆိုင်ဧရိယာပြင်ပတွင် ရှိပါသည်။",action:"မလိပန်းဆိုင်သို့သွား၍ GPS အသစ်ရပြီးနောက် ပြန်ရိုက်ပါ။"}},
    PHOTO_TIME_TOO_OLD:{th:{reason:"Timestamp บนภาพห่างจากเวลาที่ส่ง LINE เกินกำหนด",action:"ถ่ายรูปใหม่ ณ เวลาปัจจุบันแล้วส่งทันที"},en:{reason:"The photo timestamp is too far from the LINE send time.",action:"Take a new photo now and send it immediately."},my:{reason:"ဓာတ်ပုံ Timestamp နှင့် LINE ပို့ချိန် အလွန်ကွာခြားနေပါသည်။",action:"ယခု ဓာတ်ပုံအသစ်ရိုက်ပြီး ချက်ချင်းပို့ပါ။"}}
  };
  const detail = cases[code] || {
    th:{reason:"รูปยังไม่ผ่านเงื่อนไข Timestamp, GPS และนาฬิการ้าน",action:"ถ่ายใหม่ให้เห็น Overlay สีขาวและนาฬิการ้านชัดเจน"},
    en:{reason:"The photo did not pass timestamp, GPS, and shop-clock validation.",action:"Retake it with the white overlay and shop clock clearly visible."},
    my:{reason:"ဓာတ်ပုံသည် Timestamp၊ GPS နှင့် ဆိုင်နာရီ စစ်ဆေးမှု မအောင်မြင်ပါ။",action:"အဖြူရောင် Overlay နှင့် ဆိုင်နာရီ ရှင်းလင်းစွာ မြင်ရအောင် ပြန်ရိုက်ပါ။"}
  };
  return rejection(code || "CLOCK_NOT_ACCEPTED", detail.th, detail.en, detail.my, "เวลา");
}
