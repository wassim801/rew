import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;
const modelCooldownUntil = new Map<string, number>();

export function isModelInCooldown(model: string): boolean {
  const until = modelCooldownUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldownUntil.delete(model);
    return false;
  }
  return true;
}

export function markModelCooldown(model: string, durationMs = 90000): void {
  modelCooldownUntil.set(model, Date.now() + durationMs);
}

export function clearModelCooldown(model: string): void {
  modelCooldownUntil.delete(model);
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets to run AI transcription and analysis.'
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 180000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function isTransientGeminiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('unavailable') ||
    msg.includes('resource_exhausted') ||
    msg.includes('deadline_exceeded') ||
    msg.includes('deadline expired') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('try again later') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('eai_again') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('abort')
  );
}

function classifyTransientReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
    return '429 rate-limit';
  }
  if (
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded')
  ) {
    return '503 capacity spike';
  }
  if (
    msg.includes('504') ||
    msg.includes('deadline') ||
    msg.includes('timed out') ||
    msg.includes('etimedout') ||
    msg.includes('abort')
  ) {
    return 'request timeout';
  }
  return 'network interruption';
}

export function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  let extracted = raw.trim();

  // Unwrap JSON error payloads returned directly by the Google GenAI SDK
  if (extracted.startsWith('{')) {
    try {
      const parsed = JSON.parse(extracted) as {
        error?: { code?: number; message?: string; status?: string };
        message?: string;
      };
      if (parsed?.error?.message) {
        const code = parsed.error.code ? ` (${parsed.error.code})` : '';
        extracted = `${parsed.error.message}${code}`;
      } else if (parsed?.message) {
        extracted = parsed.message;
      }
    } catch {
      // Fall back to raw message inspection
    }
  }

  const lower = extracted.toLowerCase();
  if (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded')
  ) {
    return 'Gemini AI service is temporarily experiencing high demand (503). Completed stages and audio chunks are saved—please wait a moment and click Retry to resume.';
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return 'Gemini API rate limit reached (429). Completed stages and chunks are preserved—wait 30–60 seconds and click Retry to resume.';
  }
  if (lower.includes('504') || lower.includes('deadline_exceeded') || lower.includes('timed out')) {
    return 'Gemini AI request timed out. Completed stages and chunks are saved—click Retry to continue.';
  }
  if (lower.includes('api_key') || lower.includes('api key') || lower.includes('401') || lower.includes('403')) {
    return 'Gemini API authentication failed. Please verify your GEMINI_API_KEY configuration.';
  }

  return extracted;
}

function jitteredDelayMs(baseMs: number, attempt: number): Promise<void> {
  const jitter = 0.85 + Math.random() * 0.3;
  const ms = Math.round(baseMs * Math.pow(2, attempt) * jitter);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  label = 'gemini-call',
  baseDelayMs = 1500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      const result = await fn();
      console.log(`[Gemini] ${label} succeeded in ${Date.now() - t0}ms (attempt ${attempt + 1})`);
      return result;
    } catch (err) {
      lastError = err;
      const reason = isTransientGeminiError(err) ? classifyTransientReason(err) : 'non-retryable';
      console.log(
        `[Gemini] ${label} attempt ${attempt + 1}/${maxRetries + 1} interrupted (${reason}) after ${Date.now() - t0}ms`
      );
      if (!isTransientGeminiError(err) || attempt === maxRetries) {
        throw err;
      }
      await jitteredDelayMs(baseDelayMs, attempt);
    }
  }
  throw lastError;
}

export async function withModelFallback<T>(
  models: string[],
  runForModel: (model: string) => Promise<T>,
  label = 'gemini-call',
  options?: { recoveryRounds?: number; roundDelayMs?: number }
): Promise<T> {
  const recoveryRounds = options?.recoveryRounds ?? 5;
  const roundDelayMs = options?.roundDelayMs ?? 4000;
  let lastError: unknown;

  for (let round = 0; round < recoveryRounds; round++) {
    if (round > 0) {
      const isRateLimited = lastError ? classifyTransientReason(lastError).startsWith('429') : false;
      const extraWait = isRateLimited ? 6000 : 0;
      const waitMs =
        Math.round(roundDelayMs * Math.pow(1.85, round - 1) * (0.85 + Math.random() * 0.3)) + extraWait;
      console.log(
        `[Gemini] ${label} waiting ${waitMs}ms before recovery round ${round + 1}/${recoveryRounds} after temporary spike...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // Prefer models not currently in cooldown so healthy fallback models answer immediately
    const healthy = models.filter((m) => !isModelInCooldown(m));
    const cooled = models.filter((m) => isModelInCooldown(m));
    const orderedModels = healthy.length > 0 ? [...healthy, ...cooled] : models;

    for (let i = 0; i < orderedModels.length; i++) {
      const model = orderedModels[i];
      // Skip cooled-down models in round 0 if a healthy candidate already exists unless all healthy fail
      const retriesForModel = isModelInCooldown(model) ? 0 : 1;
      try {
        const res = await withRetry(
          () => runForModel(model),
          retriesForModel,
          `${label}:${model}`,
          2000
        );
        clearModelCooldown(model);
        return res;
      } catch (err) {
        lastError = err;
        if (!isTransientGeminiError(err)) {
          throw err;
        }
        const reason = classifyTransientReason(err);
        markModelCooldown(model, reason.startsWith('429') ? 120000 : 90000);
        if (i < orderedModels.length - 1) {
          console.log(
            `[Gemini] ${label} routing next attempt from ${model} to ${orderedModels[i + 1]} (${reason}).`
          );
        }
      }
    }
  }

  throw lastError;
}
