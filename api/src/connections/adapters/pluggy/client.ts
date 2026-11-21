import { z } from '@shared/zod';

import {
  Account,
  Bill,
  Category,
  Connector,
  ConnectTokenResponse,
  Investment,
  Item,
  Loan,
  PluggyAuthResponse,
  Transaction,
  paginated,
  type Account as AccountT,
  type Bill as BillT,
  type Category as CategoryT,
  type Connector as ConnectorT,
  type ConnectTokenResponse as ConnectTokenT,
  type Investment as InvestmentT,
  type Item as ItemT,
  type Loan as LoanT,
  type Transaction as TransactionT,
} from './types';

// ---- config ----------------------------------------------------------------

/**
 * Structural minimum the client needs from a fetch implementation.
 * Deliberately NOT `typeof fetch`: Bun's global fetch type requires a
 * `preconnect` method, which would force test doubles to carry it.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Credentials + identity the client reads. Property names match the source repo's `Config`. */
export type PluggyConfig = {
  pluggyClientId: string;
  pluggyClientSecret: string;
  pluggyBaseUrl: string;
  sandbox: boolean;
  itemIds: string[];
  clientUserId: string;
};

const boolFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Same env var names (and defaults) as the source repo, minus server-level PORT/AUTH_TOKEN. */
export const PluggyEnvSchema = z.object({
  PLUGGY_CLIENT_ID: z.string().min(1, 'PLUGGY_CLIENT_ID is required'),
  PLUGGY_CLIENT_SECRET: z.string().min(1, 'PLUGGY_CLIENT_SECRET is required'),
  PLUGGY_BASE_URL: z.string().url().default('https://api.pluggy.ai'),
  PLUGGY_SANDBOX: boolFromEnv.default(true),
  // `.default` must precede the transform: ZodDefault short-circuits the inner pipeline.
  PLUGGY_ITEM_IDS: z
    .string()
    .default('')
    .transform((s) => (s.trim().length === 0 ? [] : s.trim().split(',').map((s) => s.trim()))),
  CLIENT_USER_ID: z.string().default('syscd-app'),
});

type EnvRecord = Record<string, string | undefined>;
let providerEnv: EnvRecord = {};

/** Entrypoints hand over their env once at boot; this feature never reads `process.env`. */
export function configurePluggyEnv(env: EnvRecord): void {
  providerEnv = env;
}

export const pluggyEnv = (): EnvRecord => providerEnv;

export class PluggyConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid Pluggy configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

/**
 * Validate env into `PluggyConfig`. Throws `PluggyConfigError` with one bullet per issue.
 * Call sites pass this (or a zero-arg closure around it) to `PluggyClient`, so a bad env
 * surfaces on first use — never at import time.
 */
export function loadPluggyConfig(env: Record<string, string | undefined> = pluggyEnv()): PluggyConfig {
  const parsed = PluggyEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new PluggyConfigError(parsed.error.issues.map((i) => i.message));
  }
  const e = parsed.data;
  return {
    pluggyClientId: e.PLUGGY_CLIENT_ID,
    pluggyClientSecret: e.PLUGGY_CLIENT_SECRET,
    pluggyBaseUrl: e.PLUGGY_BASE_URL.replace(/\/+$/, ''),
    sandbox: e.PLUGGY_SANDBOX,
    itemIds: e.PLUGGY_ITEM_IDS,
    clientUserId: e.CLIENT_USER_ID,
  };
}

/**
 * The non-credential part of the env (base URL, sandbox switch). A user's own
 * key set runs on these; the shared PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET
 * are not needed for it.
 */
const PluggyOwnEnvSchema = PluggyEnvSchema.pick({ PLUGGY_BASE_URL: true, PLUGGY_SANDBOX: true, CLIENT_USER_ID: true });

/** Empty-string values dropped, so a blank field in a secret store reads as unset. */
const withoutBlanks = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));

/**
 * Config for a user's OWN key set: their client id and secret, the
 * installation's base URL and sandbox switch. Never `PLUGGY_ITEM_IDS` (those
 * belong to the shared application). Blank env values count as unset here
 * (the shared loader above still takes them literally: budget-hd3).
 */
export function loadPluggyOwnConfig(
  credentials: { clientId: string; clientSecret: string },
  env: Record<string, string | undefined> = pluggyEnv(),
): PluggyConfig {
  const parsed = PluggyOwnEnvSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    throw new PluggyConfigError(parsed.error.issues.map((i) => i.message));
  }
  const e = parsed.data;
  return {
    pluggyClientId: credentials.clientId,
    pluggyClientSecret: credentials.clientSecret,
    pluggyBaseUrl: e.PLUGGY_BASE_URL.replace(/\/+$/, ''),
    sandbox: e.PLUGGY_SANDBOX,
    itemIds: [],
    clientUserId: e.CLIENT_USER_ID,
  };
}

export class PluggyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    /** Parsed from RateLimit-Reset (seconds) else Retry-After on 429s. */
    public readonly retryAfterMs?: number,
  ) {
    super(`Pluggy API ${status}: ${message}`);
  }
}

export type ApiKeyCache = { apiKey: string; expiresAt: number };

const API_KEY_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 10_000;
/** Safety cap for page loops — aggregates hundreds of rows without runaway calls. */
const MAX_PAGES = 20;

export interface PageLoop {
  maxPages?: number;
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  retryOn401?: boolean;
  timeoutMs?: number;
};

export class PluggyClient {
  private keyCache?: ApiKeyCache;
  private keyInFlight?: Promise<string>;
  private configMemo?: PluggyConfig;
  constructor(
    private readonly configArg: PluggyConfig | (() => PluggyConfig),
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolved lazily so a provider (e.g. `loadPluggyConfig`) fails on first use, not import. */
  private get config(): PluggyConfig {
    this.configMemo ??= typeof this.configArg === 'function' ? this.configArg() : this.configArg;
    return this.configMemo;
  }

  /** Where the resolved credentials point — 'sandbox' keeps auto-sync off. */
  get environment(): 'sandbox' | 'production' {
    return this.config.sandbox ? 'sandbox' : 'production';
  }

  // ---- auth -----------------------------------------------------------------

  /** Fetch (or return cached) X-API-KEY. Single-flight; refreshes before expiry. */
  async getApiKey(): Promise<string> {
    const cached = this.keyCache;
    if (cached && cached.expiresAt - API_KEY_REFRESH_MARGIN_MS > this.now()) {
      return cached.apiKey;
    }
    this.keyInFlight ??= this.fetchApiKey().finally(() => (this.keyInFlight = undefined));
    return this.keyInFlight;
  }

  private async fetchApiKey(): Promise<string> {
    const res = await this.fetchImpl(new URL('/auth', this.config.pluggyBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.config.pluggyClientId,
        clientSecret: this.config.pluggyClientSecret,
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new PluggyError(res.status, `authentication failed — ${await safeBody(res)}`);
    }
    const parsed = PluggyAuthResponse.parse(await res.json());
    const expiresAt = parsed.expirationDate
      ? Date.parse(parsed.expirationDate)
      : this.now() + 2 * 60 * 60 * 1000;
    this.keyCache = { apiKey: parsed.apiKey, expiresAt: Number.isNaN(expiresAt) ? this.now() + 2 * 60 * 60 * 1000 : expiresAt };
    return parsed.apiKey;
  }

  /**
   * Is the configured client id + secret pair accepted? One POST /auth, the
   * cheapest call Pluggy has (200 = an API key, 401 = wrong pair; 400/403 are
   * a malformed or disabled pair). Anything else (network, 5xx) is thrown.
   */
  async verifyCredentials(): Promise<boolean> {
    try {
      await this.fetchApiKey();
      return true;
    } catch (err) {
      if (err instanceof PluggyError && (err.status === 400 || err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  private invalidateApiKey(): void {
    this.keyCache = undefined;
  }

  /** The provider client id, part of the widget credential bundle. */
  get clientId(): string {
    return this.config.pluggyClientId;
  }

  // ---- core request ----------------------------------------------------------

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.config.pluggyBaseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-API-KEY': await this.getApiKey(),
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof PluggyError) throw err;
      // Keep the lazy provider's typed failure intact (e.g. `new PluggyClient(loadPluggyConfig)`)
      if (err instanceof PluggyConfigError) throw err;
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new PluggyError(0, `request timed out after ${opts.timeoutMs ?? REQUEST_TIMEOUT_MS}ms`);
      }
      throw new PluggyError(0, `request failed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401 && (opts.retryOn401 ?? true)) {
      this.invalidateApiKey();
      return this.request<T>(method, path, { ...opts, retryOn401: false });
    }
    if (!res.ok) {
      throw new PluggyError(res.status, `${method} ${path} — ${await safeBody(res)}`, undefined, retryAfterMsFrom(res.headers));
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private async pageLoop<T, R>(fetchPage: (page: number) => Promise<{ results: T[]; hasMore: boolean }>, transform: (r: T) => R, maxPages: number): Promise<R[]> {
    const out: R[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { results, hasMore } = await fetchPage(page);
      for (const r of results) out.push(transform(r));
      if (!hasMore) break;
    }
    return out;
  }

  // ---- connectors ---------------------------------------------------------

  async listConnectors(): Promise<ConnectorT[]> {
    const parse = paginated(Connector);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', '/connectors', { query: { page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }

  /**
   * Mint a connect token. `itemId` selects the re-auth variant (token for an EXISTING
   * item, e.g. to update credentials), not just new connections.
   *
   * Deviation from verbatim: the source signature was `{ connectorId?, itemId? }` with
   * `clientUserId`/`sandbox` always taken from config. This port additionally accepts
   * optional `clientUserId`, `webhookUrl`, `oauthRedirectUri`, `avoidDuplicates` and
   * passes them through when defined (defaults unchanged) — PLUGGY-01's acceptance
   * requires these options.
   */
  async createConnectToken(input: {
    connectorId?: number;
    itemId?: string;
    clientUserId?: string;
    webhookUrl?: string;
    oauthRedirectUri?: string;
    avoidDuplicates?: boolean;
  }): Promise<ConnectTokenT> {
    return ConnectTokenResponse.parse(
      await this.request('POST', '/connect_token', {
        body: {
          ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
          ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          clientUserId: input.clientUserId ?? this.config.clientUserId,
          sandbox: this.config.sandbox,
          ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
          ...(input.oauthRedirectUri !== undefined ? { oauthRedirectUri: input.oauthRedirectUri } : {}),
          ...(input.avoidDuplicates !== undefined ? { avoidDuplicates: input.avoidDuplicates } : {}),
        },
      }),
    );
  }

  // ---- items ----------------------------------------------------------------

  /** Resolve connected items. Prefers config ids; falls back to /items by clientUserId. */
  async listItems(): Promise<ItemT[]> {
    if (this.config.itemIds.length > 0) {
      const items = await Promise.allSettled(
        this.config.itemIds.map((id) => Item.parse(this.request('GET', `/items/${id}`))),
      );
      const ok = items.filter((r): r is PromiseFulfilledResult<ItemT> => r.status === 'fulfilled').map((r) => r.value);
      if (ok.length > 0) return ok;
      // ids configured but all failed — surface errors, do not silently fall back
      const err = items.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (err) throw err.reason;
    }
    return this.listItemsByClientUserId();
  }

  private async listItemsByClientUserId(): Promise<ItemT[]> {
    const parse = paginated(Item);
    const all = await this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', '/items', { query: { page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
    return all.filter((i) => i.clientUserId === this.config.clientUserId);
  }

  async getItem(id: string): Promise<ItemT> {
    return Item.parse(await this.request('GET', `/items/${id}`));
  }

  async updateItem(id: string): Promise<ItemT> {
    return Item.parse(await this.request('PATCH', `/items/${id}`, { body: {} }));
  }

  async deleteItem(id: string): Promise<void> {
    await this.request('DELETE', `/items/${id}`);
  }

  // ---- accounts ------------------------------------------------------------

  async listAccounts(input: { itemId?: string; type?: 'BANK' | 'CREDIT' }): Promise<AccountT[]> {
    const parse = paginated(Account);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(
          await this.request('GET', '/accounts', { query: { itemId: input.itemId, type: input.type, page, pageSize: 100 } }),
        );
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }

  async getAccount(id: string): Promise<AccountT> {
    return Account.parse(await this.request('GET', `/accounts/${id}`));
  }

  async getAccountBalance(id: string): Promise<AccountT> {
    return Account.parse(await this.request('GET', `/accounts/${id}/balance`));
  }

  /** Credit card bills for an account (bills in Pluggy are per-card). */
  async listBills(input: { accountId: string; pageSize?: number }): Promise<BillT[]> {
    const parse = paginated(Bill);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(
          await this.request('GET', '/bills', { query: { accountId: input.accountId, page, pageSize: input.pageSize ?? 100 } }),
        );
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }

  // ---- transactions ---------------------------------------------------------

  /**
   * Cursor-paginated /v2/transactions. The v2 endpoint accepts only
   * `accountId` + `cursor` — `from`/`to` bounds are applied client-side
   * (date-only comparison) over the newest-first pages, stopping as soon as
   * a page dips below `from` since older pages cannot re-enter the window.
   * Collects up to `maxResults` and reports `hasMore` whenever the window is
   * not provably exhausted (cap or page valve hit).
   */
  async listTransactions(input: { accountId: string; from?: string; to?: string; maxResults?: number }): Promise<{ results: TransactionT[]; hasMore: boolean }> {
    const maxResults = input.maxResults ?? 1_000;
    const out: TransactionT[] = [];
    let cursor: string | undefined;
    let windowExhausted = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.request<{ results: unknown[]; nextPage?: string | null }>('GET', '/v2/transactions', {
        query: {
          accountId: input.accountId,
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });
      const parsed = z.array(Transaction).parse(body.results ?? []);
      for (const t of parsed) {
        const day = t.date.slice(0, 10);
        if ((input.from == null || day >= input.from) && (input.to == null || day <= input.to)) out.push(t);
      }
      const next = body.nextPage ?? undefined;
      // nextPage is a relative URL carrying the cursor (`/v2/transactions?cursor=x`);
      // tolerate a bare cursor token too — both shapes exist across API versions.
      cursor =
        next === undefined
          ? undefined
          : next.includes('?')
            ? (new URL(next, 'https://pluggy.invalid').searchParams.get('cursor') ?? undefined)
            : next;
      if (cursor === undefined) {
        windowExhausted = true;
        break;
      }
      if (out.length >= maxResults) break;
      // Newest-first: once a page dips below `from`, no older page re-enters.
      const oldestDay = parsed.at(-1)?.date.slice(0, 10);
      if (input.from != null && oldestDay != null && oldestDay < input.from) {
        windowExhausted = true;
        break;
      }
    }
    const results = out.slice(0, maxResults);
    return { results, hasMore: !windowExhausted };
  }

  // ---- investments ----------------------------------------------------------

  async listInvestments(input: { itemId?: string; type?: string }): Promise<InvestmentT[]> {
    const parse = paginated(Investment);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', '/investments', { query: { itemId: input.itemId, type: input.type, page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }

  async listInvestmentTransactions(investmentId: string): Promise<TransactionT[]> {
    const parse = paginated(Transaction);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', `/investments/${investmentId}/transactions`, { query: { page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }

  // ---- loans ----------------------------------------------------------------

  async listLoans(input: { itemId?: string }): Promise<LoanT[]> {
    const parse = paginated(Loan);
    const all = await this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', '/loans', { query: { page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
    return input.itemId ? all.filter((l) => l.itemId === input.itemId) : all;
  }

  // ---- categories -----------------------------------------------------------

  async listCategories(): Promise<CategoryT[]> {
    const parse = paginated(Category);
    return this.pageLoop(
      async (page) => {
        const p = parse.parse(await this.request('GET', '/categories', { query: { page, pageSize: 100 } }));
        return { results: p.results, hasMore: (p.totalPages ?? 1) > page };
      },
      (r) => r,
      MAX_PAGES,
    );
  }
}

/**
 * How long the provider asked us to wait: `RateLimit-Reset` (delta seconds)
 * wins, else `Retry-After` (delta seconds or an HTTP date). Undefined when
 * neither header is present/parseable.
 */
export function retryAfterMsFrom(headers: Headers, now: () => number = Date.now): number | undefined {
  const seconds = (v: string | null): number | undefined => {
    if (v == null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.ceil(n * 1000) : undefined;
  };
  const reset = seconds(headers.get('ratelimit-reset'));
  if (reset !== undefined) return reset;
  const retry = headers.get('retry-after');
  const delta = seconds(retry);
  if (delta !== undefined) return delta;
  const at = retry ? Date.parse(retry) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - now());
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300) || res.statusText;
  } catch {
    return res.statusText;
  }
}
