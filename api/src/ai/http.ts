/**
 * The one HTTP path provider adapters use. Adds a timeout and normalizes
 * failures into `AiProviderError`; adapters only build URLs, headers and
 * bodies, and parse the JSON they get back.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import { AiProviderError } from './errors';

/**
 * Structural minimum the helper needs from fetch. NOT `typeof fetch`: Bun's
 * global type requires a `preconnect` method, which would force test doubles
 * to carry it.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_MODELS_TIMEOUT_MS = 15_000;

/**
 * Conservative output speed used to size a chat deadline from its token cap.
 * Anthropic's default cap is 16k (thinking counts toward it), which at 25
 * tokens/s needs 640 s; a 60 s deadline would abort long generations while the
 * provider keeps billing them.
 */
const CHAT_MIN_OUTPUT_TOKENS_PER_SECOND = 25;

/** Deadline for one chat call: the 60 s floor, or enough for the requested cap. */
export function chatTimeoutMs(maxTokens?: number): number {
  if (!maxTokens || maxTokens <= 0) return DEFAULT_CHAT_TIMEOUT_MS;
  return Math.max(DEFAULT_CHAT_TIMEOUT_MS, Math.ceil((maxTokens / CHAT_MIN_OUTPUT_TOKENS_PER_SECOND) * 1000));
}

export type JsonRequest = {
  provider: AiProviderId;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  fetch?: FetchLike;
};

function upstreamMessage(text: string): string | null {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const raw = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message);
    if (typeof raw === 'string' && raw.trim()) return raw.replaceAll(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw body.
  }
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line ? line.slice(0, 300) : null;
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function errorFromResponse(provider: AiProviderId, res: Response, text: string): AiProviderError {
  const detail = upstreamMessage(text);
  const message = `${provider} API ${res.status}${detail ? `: ${detail}` : ''}`;
  // 401 = the key is not accepted; 403 = it authenticated but may not do this
  // (for example an OpenAI key without the Models Read permission).
  if (res.status === 401) return new AiProviderError('auth', message, res.status);
  if (res.status === 403) return new AiProviderError('forbidden', message, res.status);
  if (res.status === 429) return new AiProviderError('rate_limited', message, res.status, retryAfterMs(res));
  if (res.status === 408 || res.status >= 500) return new AiProviderError('transient', message, res.status);
  return new AiProviderError('permanent', message, res.status);
}

/** Perform one JSON request. Throws `AiProviderError` for every failure shape. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const fetchImpl = request.fetch ?? fetch;
  const timeoutMs = request.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...request.headers,
  };
  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A completion that hit its deadline may already have been generated (and
    // billed) upstream. Retrying a transient error would pay for the same work
    // again, so a timeout is permanent: the caller may re-run it deliberately.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AiProviderError('permanent', `${request.provider} request timed out after ${timeoutMs} ms`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new AiProviderError('transient', `${request.provider} request failed: ${detail}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AiProviderError('transient', `${request.provider} response could not be read: ${detail}`, res.status);
  }
  if (!res.ok) throw errorFromResponse(request.provider, res, text);
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new AiProviderError('bad_response', `${request.provider} answered with invalid JSON`, res.status);
  }
}
