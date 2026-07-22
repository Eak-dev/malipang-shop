import { validateClock } from "../domain/attendance";
import { numberEnv } from "../shared/env";
import { randomId } from "../shared/ids";
import type { Env } from "../types";
import { classifyAndRead } from "../vision/service";
import { validateBankSlip } from "../expense/bank-slip";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PROVIDERS = ["pipeline", "openai", "workers-ai"] as const;
const OPENAI_EVAL_MODELS = ["gpt-4o-mini", "gpt-4.1-mini"] as const;
type Provider = typeof PROVIDERS[number];

function requestedProvider(url: URL): Provider {
  const provider = url.searchParams.get("provider") || "pipeline";
  if (!PROVIDERS.includes(provider as Provider)) {
    throw new Error("provider must be pipeline, openai, or workers-ai");
  }
  return provider as Provider;
}

function receivedAtIso(url: URL): string {
  const value = url.searchParams.get("receivedAt") || new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("receivedAt must be a valid ISO date-time");
  return parsed.toISOString();
}

async function evaluateImage(env:Env,image:ArrayBuffer,url:URL):Promise<unknown>{
  if (image.byteLength === 0) throw new Error("Image body is empty");
  if (image.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 5 MiB test limit");
  const provider = requestedProvider(url);
  const requestedModel = url.searchParams.get("model");
  if (requestedModel && (provider !== "openai" || !OPENAI_EVAL_MODELS.includes(requestedModel as typeof OPENAI_EVAL_MODELS[number]))) {
    throw new Error("model override is allowed only for openai: gpt-4o-mini or gpt-4.1-mini");
  }
  const receivedAt = receivedAtIso(url);
  const traceId = randomId("vision-eval");
  const evaluationEnv: Env = provider === "openai"
    ? { ...env, WORKERS_AI_ENABLED: "false", OPENAI_FALLBACK_ENABLED: "true", OPENAI_MODEL: requestedModel || env.OPENAI_MODEL }
    : provider === "workers-ai"
      ? { ...env, WORKERS_AI_ENABLED: "true", OPENAI_FALLBACK_ENABLED: "false" }
      : env;

  const reading = await classifyAndRead(evaluationEnv, image, image, traceId, {usageMetric:"openai_admin_test_calls",enforceDailyLimit:false});
  const validation = validateClock(
    reading,
    receivedAt,
    numberEnv(env.CLOCK_MAX_DATE_DIFF_DAYS, 1),
    numberEnv(env.CLOCK_FALLBACK_MIN_CONFIDENCE, 0.9),
    numberEnv(env.CLOCK_MAX_LINE_TIME_DIFF_MIN, 30)
  );
  const { raw: _raw, ...safeReading } = reading;

  return {
    traceId,
    providerRequested: provider,
    modelRequested: requestedModel || null,
    receivedAt,
    imageBytes: image.byteLength,
    reading: safeReading,
    validation,
    documentValidation: reading.kind === "BANK_SLIP" ? validateBankSlip(reading) : null
  };
}

export async function evaluateUploadedImage(env: Env, request: Request): Promise<unknown> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0]?.trim().toLowerCase() || "";
  if (contentType !== "image/jpeg") throw new Error("Only image/jpeg is supported");
  return evaluateImage(env,await request.arrayBuffer(),new URL(request.url));
}

export async function evaluateEvidenceImage(env:Env,input:{key?:string},url:URL):Promise<unknown>{
  const key=String(input.key||"").trim();
  if(!key||key.length>512)throw new Error("A valid R2 evidence key is required");
  const object=await env.EVIDENCE.get(key);
  if(!object)throw new Error("R2 evidence object not found");
  return evaluateImage(env,await new Response(object.body).arrayBuffer(),url);
}
