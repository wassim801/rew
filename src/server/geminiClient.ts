import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;

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
        timeout: 90000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('DEADLINE_EXCEEDED') ||
    msg.includes('Deadline expired') ||
    msg.includes('high demand') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('abort')
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  label = 'gemini-call'
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
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[Gemini] ${label} attempt ${attempt + 1}/${maxRetries + 1} failed in ${Date.now() - t0}ms: ${msg.slice(0, 200)}`
      );
      if (!isTransientGeminiError(err) || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 900 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

export async function withModelFallback<T>(
  models: string[],
  runForModel: (model: string) => Promise<T>,
  label = 'gemini-call'
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const retriesForModel = i < models.length - 1 ? 0 : 1;
    try {
      return await withRetry(() => runForModel(model), retriesForModel, `${label}:${model}`);
    } catch (err) {
      lastError = err;
      if (!isTransientGeminiError(err) || i === models.length - 1) {
        throw err;
      }
      console.log(`[Gemini] ${label} falling back from ${model} to ${models[i + 1]} due to transient error.`);
    }
  }
  throw lastError;
}
