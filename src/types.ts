export type RuntimeMode = "shadow" | "production";
export type ImageKind = "CLOCK" | "RECEIPT" | "BANK_SLIP" | "ONLINE_ORDER" | "UNKNOWN";
export type PunchType = "IN" | "OUT" | "DUPLICATE" | "COMPLETE" | "REVIEW";
export type SheetEntityType = "ATTENDANCE_EVENT" | "DAILY_PAYROLL" | "WEEKLY_PAYROLL" | "EXPENSE" | "SYSTEM_LOG";

export interface Env {
  DB: D1Database;
  AI: { run(model: string, input: unknown): Promise<unknown> };
  EVIDENCE: R2Bucket;
  JOB_QUEUE: Queue<QueueJob>;
  ATTENDANCE_COORDINATOR: DurableObjectNamespace;
  APP_ENV: string;
  RUNTIME_MODE: RuntimeMode;
  TIMEZONE: string;
  ATTENDANCE_ENABLED: string;
  EXPENSE_ENABLED: string;
  SHEETS_SYNC_ENABLED: string;
  R2_EVIDENCE_ENABLED: string;
  LINE_LOADING_ENABLED: string;
  LINE_LOADING_SECONDS: string;
  LINE_OWNER_USER_ID: string;
  SHADOW_LINE_OUTPUT: string;
  WORKERS_AI_ENABLED: string;
  WORKERS_AI_MODEL: string;
  OPENAI_FALLBACK_ENABLED: string;
  OPENAI_MODEL: string;
  OPENAI_DAILY_FALLBACK_LIMIT: string;
  ATTENDANCE_STORE_LAT: string;
  ATTENDANCE_STORE_LNG: string;
  ATTENDANCE_ALLOWED_RADIUS_M: string;
  ATTENDANCE_MAX_PHOTO_AGE_MIN: string;
  ATTENDANCE_OVERLAY_MIN_CONFIDENCE: string;
  ATTENDANCE_CLOCK_MIN_CONFIDENCE: string;
  EXTERNAL_API_TIMEOUT_MS: string;
  VISION_TIMEOUT_MS: string;
  SHEET_STAFF_CONFIG: string;
  SHEET_ATTENDANCE_RAW: string;
  SHEET_DAILY_PAYROLL: string;
  SHEET_WEEKLY_PAYROLL: string;
  SHEET_EXPENSE_RAW: string;
  SHEET_EXPENSE_DAILY: string;
  SHEET_SYSTEM_LOG: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ADMIN_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY_BASE64: string;
  GOOGLE_SPREADSHEET_ID: string;
  OPENAI_API_KEY?: string;
}

export interface LineWebhookBody { destination?: string; events?: LineEvent[] }
export interface LineSource { type: string; userId?: string; groupId?: string; roomId?: string }
export interface LineMessage { id: string; type: string; text?: string; contentProvider?: { type: string } }
export interface LineEvent {
  type: string;
  timestamp: number;
  source: LineSource;
  replyToken?: string;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  message?: LineMessage;
  postback?: { data: string; params?: { date?: string; datetime?: string; time?: string } };
}

export interface InboundJob { kind: "LINE_EVENT"; event: LineEvent; receivedAtIso: string; traceId: string }
export interface SheetsSyncJob { kind: "SHEETS_SYNC"; entityType: SheetEntityType; entityKey: string; entityVersion: number; traceId: string }
export type QueueJob = InboundJob | SheetsSyncJob;

export interface Employee {
  employeeId: string;
  staffName: string;
  lineUserId: string;
  scheduledIn: string;
  scheduledOut: string;
  dailyWageSatang: number;
  graceMin: number;
  lateDeductionSatang: number;
  earlyDeductionSatang: number;
  canSubmitExpense: boolean;
  status: "ACTIVE" | "INACTIVE";
}

export interface EmployeeImportInput {
  employeeId: string;
  staffName: string;
  lineUserId: string;
  scheduledIn: string;
  scheduledOut: string;
  dailyWageBaht: number;
  graceMin: number;
  lateDeductionBaht: number;
  earlyDeductionBaht?: number;
  canSubmitExpense?: boolean;
  status: "ACTIVE" | "INACTIVE";
}

export interface VisionResult {
  kind: ImageKind;
  hour: number | null;
  minute: number | null;
  month: number | null;
  day: number | null;
  weekday: string | null;
  confidence: number;
  clockFullyVisible: boolean | null;
  clockPresent: boolean | null;
  clockConfidence: number;
  overlayPresent: boolean;
  overlayTextWhite: boolean;
  photoDate: string | null;
  photoTime: string | null;
  latitude: number | null;
  longitude: number | null;
  locationText: string;
  overlayRawText: string;
  overlayConfidence: number;
  needsNewPhoto: boolean;
  note: string;
  provider: string;
  raw: unknown;
  document?: BankSlipDocument | null;
}

export interface BankSlipDocument {
  documentType: "BANK_SLIP";
  channel: "BANK" | "G_WALLET";
  institution: string;
  transactionType: "TRANSFER" | "PAYMENT" | "WALLET_PAYMENT" | "TOPUP" | "UNKNOWN";
  transactionStatus: "SUCCESS" | "FAILED" | "PENDING" | "UNKNOWN";
  printedYear: string;
  paymentDate: string;
  paymentTime: string;
  referenceId: string;
  sender: string;
  senderAccountMasked: string;
  recipient: string;
  recipientAccountMasked: string;
  merchant: string;
  grossAmountBaht: number | null;
  discountAmountBaht: number | null;
  paidAmountBaht: number | null;
  currency: string;
  suggestedDescription: string;
  suggestedCategory: string;
  confidence: number;
  needsReview: boolean;
  note: string;
}

export interface AttendanceCommitRequest {
  traceId: string;
  webhookEventId: string;
  messageId: string;
  receivedAtIso: string;
  employee: Employee;
  reading: VisionResult;
  workDate: string;
  officialTime: string;
  lineTime: string;
  lineDiffMinutes: number;
  photoDateTime: string;
  gpsLat: number;
  gpsLng: number;
  distanceM: number;
  attendanceSource: "PHOTO_TIMESTAMP_GPS";
  clockEvidence: boolean;
  clockConfidence: number;
  overlayRawText: string;
  imageSha256: string;
  imageKey: string;
  validationCode: string;
  validationNote: string;
  validationReview: boolean;
}

export interface AttendanceCommitResult {
  eventId: string;
  punchType: PunchType;
  workDate: string;
  officialTime: string;
  status: "NORMAL" | "REVIEW" | "DUPLICATE" | "ALREADY_COMPLETE";
  lateMinutes: number;
  confirmedWageSatang: number;
  pendingWageSatang: number;
  validationCode: string;
  version: number;
}
