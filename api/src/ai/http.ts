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
  if (res.status === 401 || res.status === 403) return new AiProviderError('auth', message, res.status);
  if (res.status === 429) return new AiProviderError('rate_limited', message, res.status, retryAfterMs(res));
  if (res.status === 408 || res.status >= 500) return new AiProviderError('transient', message, res.status);
  return new AiProviderError('permanent', message, res.status);
}

/** Perform one JSON request. Throws `AiProviderError` for every failure shape. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const fetchImpl = request.fetch ?? fetch;
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
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS),
    });
  } catch (err) {
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
