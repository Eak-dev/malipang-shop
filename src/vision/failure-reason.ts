import type { VisionResult } from "../types";

export interface VisionRejection {
  code: string;
  message: string;
}

function rejection(code: string, reason: string, action: string, subject = "รูป"): VisionRejection {
  return {
    code,
    message: `ยังไม่บันทึก${subject}ค่ะ ❌\nสาเหตุ: ${reason}\nวิธีแก้: ${action}\nรหัส: ${code}`
  };
}

export function describeVisionRejection(reading: VisionResult): VisionRejection {
  if (reading.provider === "budget-guard") {
    return rejection(
      "VISION_DAILY_LIMIT",
      "ระบบอ่านรูปครบโควตาประจำวันแล้ว รูปของคุณไม่ได้ผิด",
      "ไม่ต้องถ่ายใหม่ กรุณาแจ้งผู้ดูแลร้านเพื่อเปิดโควตาเพิ่ม"
    );
  }
  if (reading.provider === "openai-error") {
    return rejection(
      "VISION_SERVICE_ERROR",
      "บริการ AI อ่านรูปขัดข้องชั่วคราว",
      "กรุณาส่งรูปเดิมอีกครั้งใน 1–2 นาที หากยังไม่ผ่านให้แจ้งผู้ดูแลร้าน"
    );
  }
  if (reading.provider === "none") {
    return rejection(
      "VISION_NOT_AVAILABLE",
      "ระบบอ่านรูปยังไม่พร้อมใช้งาน",
      "กรุณาแจ้งผู้ดูแลร้าน ไม่จำเป็นต้องถ่ายรูปใหม่"
    );
  }
  if (reading.kind === "CLOCK") {
    if (reading.hour == null || reading.minute == null || reading.month == null || reading.day == null || reading.needsNewPhoto) {
      return rejection(
        "CLOCK_FIELDS_MISSING",
        "อ่านเวลา เดือน หรือวันที่บนหน้าปัดได้ไม่ครบ",
        "ถ่ายให้เห็นนาฬิกาทั้งเรือน ตัวเลขไม่เบลอและไม่มีแสงสะท้อน",
        "เวลา"
      );
    }
    return rejection(
      "CLOCK_NOT_ACCEPTED",
      "ข้อมูลจากหน้าปัดยังไม่ผ่านเงื่อนไขลงเวลา",
      "ถ่ายให้ตรงหน้าปัดและเห็นเวลา เดือน และวันที่ครบ",
      "เวลา"
    );
  }
  return rejection(
    "IMAGE_KIND_UNKNOWN",
    "AI ไม่พบหน้าปัดนาฬิการ้านหรือเอกสารค่าใช้จ่ายที่ชัดพอ",
    "ส่งภาพต้นฉบับและถ่ายวัตถุให้เต็มภาพ ตัวเลขไม่เบลอ ไม่มืด และไม่สะท้อนแสง"
  );
}

export function describeClockValidationFailure(code: string): VisionRejection {
  const cases: Record<string, { reason: string; action: string }> = {
    NOT_CLOCK: {
      reason: "รูปนี้ไม่ใช่หน้าปัดนาฬิกาของร้าน",
      action: "ถ่ายนาฬิกาสีดำของร้านให้เห็นทั้งเรือน"
    },
    CLOCK_FIELDS_MISSING: {
      reason: "อ่านเวลา เดือน หรือวันที่บนหน้าปัดได้ไม่ครบ",
      action: "ถ่ายให้เห็นนาฬิกาทั้งเรือน ตัวเลขไม่เบลอและไม่มีแสงสะท้อน"
    },
    CLOCK_VALUE_OUT_OF_RANGE: {
      reason: "ค่าที่อ่านจากหน้าปัดอยู่นอกช่วงเวลาหรือวันที่ที่ถูกต้อง",
      action: "ถ่ายใหม่ให้ตรงหน้าปัดและเห็นตัวเลขครบทุกหลัก"
    },
    CLOCK_LOW_CONFIDENCE: {
      reason: "AI อ่านตัวเลขได้ไม่มั่นใจพอ จึงไม่เดาเวลาให้",
      action: "ขยับเข้าใกล้ ถ่ายตรงหน้าปัด และหลีกเลี่ยงภาพเบลอหรือแสงสะท้อน"
    },
    CLOCK_INVALID_CALENDAR_DATE: {
      reason: "เดือนและวันที่ที่อ่านได้ไม่เป็นวันที่จริง",
      action: "ตรวจหน้าปัดแล้วถ่ายใหม่ให้เห็นเดือนและวันที่ชัดเจน"
    },
    CLOCK_DATE_MISMATCH: {
      reason: "วันที่บนหน้าปัดต่างจากวันที่ส่งรูปเกินช่วงที่ระบบอนุญาต",
      action: "ตรวจวันที่บนตัวนาฬิกาและถ่ายรูปของวันปัจจุบันใหม่"
    }
  };
  const detail = cases[code] || {
    reason: "ข้อมูลจากหน้าปัดยังไม่ผ่านเงื่อนไขลงเวลา",
    action: "ถ่ายให้ตรงหน้าปัดและเห็นเวลา เดือน และวันที่ครบ"
  };
  return rejection(code || "CLOCK_NOT_ACCEPTED", detail.reason, detail.action, "เวลา");
}
