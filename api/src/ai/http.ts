/**
 * The one HTTP path provider adapters use. Adds a deadline and normalizes
 * failures into `AiProviderError`; adapters only build URLs, headers and
 * bodies, and parse the JSON they get back.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import { AiProviderError } from './errors';

export type FetchInit = RequestInit & {
  /**
   * Bun extension, not part of the fetch spec: socket idle timeout in ms;
   * `false` disables it. Bun's default is 5 minutes, reset on every byte
   * (https://bun.com/reference/globals/BunFetchRequestInit/timeout).
   */
  timeout?: number | false;
};

/**
 * Structural minimum the helper needs from fetch. NOT `typeof fetch`: Bun's
 * global type requires a `preconnect` method, which would force test doubles
 * to carry it.
 */
export type FetchLike = (input: string | URL | Request, init?: FetchInit) => Promise<Response>;

export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_MODELS_TIMEOUT_MS = 15_000;

/**
 * Cap assumed when the caller does not set one. 16k is Anthropic's documented
 * default (thinking counts toward it) and a conservative assumption for the
 * other providers; a 60 s deadline would abort long non-streaming generations
 * while the provider keeps billing them.
 */
const DEFAULT_ASSUMED_MAX_TOKENS = 16_000;
/** Conservative output speed used to size a chat deadline from its token cap. */
const CHAT_MIN_OUTPUT_TOKENS_PER_SECOND = 25;

/**
 * Deadline for one chat call: the 60 s floor, or enough for the requested cap
 * (16k -> 640 s, whether the cap was passed or assumed).
 */
export function chatTimeoutMs(maxTokens?: number): number {
  const cap = maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_ASSUMED_MAX_TOKENS;
  return Math.max(DEFAULT_CHAT_TIMEOUT_MS, Math.ceil((cap / CHAT_MIN_OUTPUT_TOKENS_PER_SECOND) * 1000));
}

export type JsonRequest = {
  provider: AiProviderId;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /**
   * What the deadline means. Default `transient` (a non-chat request did no
   * work); chat adapters pass `timeout` and leave retry policy to the caller.
   */
  timeoutKind?: 'transient' | 'timeout';
  /** Caller cancellation (for example a cancelled Temporal activity). */
  signal?: AbortSignal;
  /**
   * Chat only: Bun's 5-minute socket idle timer would fire before a 640 s
   * deadline on a silent non-streaming call, so disable it and let the
   * AbortSignal govern the whole request.
   */
  disableSocketIdleTimeout?: boolean;
  fetch?: FetchLike;
};

/**
 * Combine the deadline with the caller's signal; abort as soon as either does.
 * `release` drops the caller-signal listener when the request ends, so a
 * long-lived Temporal cancellation signal does not accumulate one per call.
 */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; release: () => void } {
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: deadline, release: () => {} };
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const source of [deadline, signal]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const listener = () => controller.abort(source.reason);
    source.addEventListener('abort', listener, { once: true });
    listeners.push(() => source.removeEventListener('abort', listener));
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const remove of listeners) remove();
    },
  };
}

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
  // OpenAI documents 401 for a key without the endpoint's scope (for example
  // /models lacking api.model.read); its only documented 403 is a country or
  // territory block. Neither proves the key can do the call, so both mean the
  // key cannot be verified here.
  if (res.status === 401 || res.status === 403) return new AiProviderError('auth', message, res.status, null, provider);
  if (res.status === 429) return new AiProviderError('rate_limited', message, res.status, retryAfterMs(res), provider);
  if (res.status === 408 || res.status >= 500) return new AiProviderError('transient', message, res.status, null, provider);
  return new AiProviderError('permanent', message, res.status, null, provider);
}

/** One failure shape for a deadline, a caller abort, or a transport error. */
function transportError(
  err: unknown,
  request: JsonRequest,
  timeoutMs: number,
  timeoutKind: 'transient' | 'timeout',
  status: number | null = null,
): AiProviderError {
  if (request.signal?.aborted) {
    return new AiProviderError(timeoutKind, `${request.provider} request was cancelled`, status, null, request.provider);
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new AiProviderError(timeoutKind, `${request.provider} request timed out after ${timeoutMs} ms`, status, null, request.provider);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new AiProviderError('transient', `${request.provider} request failed: ${detail}`, status, null, request.provider);
}

/** Perform one JSON request. Throws `AiProviderError` for every failure shape. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const fetchImpl = request.fetch ?? fetch;
  const timeoutMs = request.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
  const timeoutKind = request.timeoutKind ?? 'transient';
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...request.headers,
  };
  const deadline = withDeadline(request.signal, timeoutMs);
  const init: FetchInit = {
    method: request.method ?? 'GET',
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: deadline.signal,
    ...(request.disableSocketIdleTimeout ? { timeout: false } : {}),
  };
  try {
    let res: Response;
    try {
      res = await fetchImpl(request.url, init);
    } catch (err) {
      throw transportError(err, request, timeoutMs, timeoutKind);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw transportError(err, request, timeoutMs, timeoutKind, res.status);
    }
    if (!res.ok) throw errorFromResponse(request.provider, res, text);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new AiProviderError('bad_response', `${request.provider} answered with invalid JSON`, res.status, null, request.provider);
    }
  } finally {
    deadline.release();
  }
}
