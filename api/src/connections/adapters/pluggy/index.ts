/**
 * Pluggy adapter for the Connections port.
 *
 * The only place the vendor's identity is allowed to surface — env keys
 * (`PLUGGY_*`), webhook headers, payload schemas, upstream status names.
 * Implements the provider-neutral `BankAggregator` from `../..\/types` by
 * delegating to the salvaged HTTP client (`./client`) and reshaping upstream
 * payloads onto the port's types.
 */

import { timingSafeEqual } from 'crypto';

import type {
  AggregatedTransaction,
  BankAggregator,
  CreditDetails,
  ExternalAccountType,
  ConnectToken,
  ConnectTokenInput,
  ConnectionStatus,
  Delivery,
  ExternalAccount,
  ItemState,
  ListTransactionsInput,
} from '../../types';
import { AggregatorError } from '../../errors';

import { PluggyClient, PluggyConfigError, PluggyError, loadPluggyConfig, pluggyEnv, type FetchLike, type PluggyConfig } from './client';
import { CreditData, WebhookEvent, type Account, type Bill, type Item, type Transaction } from './types';

/**
 * Upstream item status → generic connection lifecycle. `unauthorized` means
 * the stored credentials stopped working — the widget re-auth flow owns the
 * repair (status set salvaged from the quarry's re-auth set); unknown
 * statuses fail loud rather than pretending health.
 */
const STATUS_BY_PROVIDER: Record<string, ConnectionStatus> = {
  UPDATED: 'connected',
  UPDATING: 'connected',
  ACCOUNT_UPDATED: 'connected',
  PROCESSING: 'connected',
  LOGIN_ERROR: 'unauthorized',
  WAITING_USER_ACTION: 'unauthorized',
  MFA_CHALLENGE: 'unauthorized',
  OUTDATED: 'error',
  // Some products refreshed, some did not. Healthy unless statusDetail carries
  // the quota warning (see itemStateFrom).
  PARTIAL_SUCCESS: 'connected',
};

/** `statusDetail` warning code Pluggy uses when the monthly API quota is spent. */
const QUOTA_WARNING_CODE = '423';

/** True when any `{ code: 423 | '423' }` object appears anywhere in a statusDetail tree. */
export function hasQuotaWarning(detail: unknown, depth = 0): boolean {
  if (detail == null || typeof detail !== 'object' || depth > 6) return false;
  if (Array.isArray(detail)) return detail.some((d) => hasQuotaWarning(d, depth + 1));
  const record = detail as Record<string, unknown>;
  if (record.code != null && String(record.code) === QUOTA_WARNING_CODE) return true;
  return Object.values(record).some((v) => hasQuotaWarning(v, depth + 1));
}

/** Item → generic state: PARTIAL_SUCCESS + 423 is `quota_exhausted` (stale, not broken). */
export function itemStateFrom(item: Pick<Item, 'status' | 'lastUpdatedAt'> & { statusDetail?: unknown }): ItemState {
  const status =
    item.status === 'PARTIAL_SUCCESS' && hasQuotaWarning(item.statusDetail) ? 'quota_exhausted' : mapItemStatus(item.status);
  return { status, lastUpdatedAt: item.lastUpdatedAt ?? null };
}

/**
 * Vendor error → provider-neutral taxonomy. 401/403 on a data call means the
 * item's consent/credentials died (the client already retried once with a
 * fresh API key); a failed API-key exchange is OUR config, not the user's bank.
 */
export function classifyPluggyError(err: unknown): AggregatorError {
  if (err instanceof AggregatorError) return err;
  if (err instanceof PluggyConfigError) return new AggregatorError('permanent', err.message);
  if (err instanceof PluggyError) {
    if (/authentication failed/i.test(err.message)) return new AggregatorError('permanent', err.message);
    if (err.status === 401 || err.status === 403) return new AggregatorError('auth', err.message);
    if (err.status === 429) return new AggregatorError('rate_limited', err.message, err.retryAfterMs);
    if (err.status === 0 || err.status === 408 || err.status >= 500) return new AggregatorError('transient', err.message);
    return new AggregatorError('permanent', err.message);
  }
  // Non-Pluggy failures (zod payload drift, fetch internals) — retry, then surface.
  return new AggregatorError('transient', err instanceof Error ? err.message : String(err));
}

/** Webhook `item/error` codes that mean the user must re-authenticate. */
const AUTH_ERROR_CODE = /CREDENTIAL|LOGIN|CONSENT|LOCKED|AUTH/i;

/** Webhook events that mean "new data is likely available". */
const SYNC_EVENTS = new Set(['transactions/created', 'transactions/updated', 'transactions/deleted', 'item/updated']);

/** Pluggy transaction statuses that mean the amount is final. */
const CLEARED_BY_PROVIDER: Record<string, boolean> = {
  POSTED: true,
  BALANCED: true,
};

/** Pluggy's Open-Finance wrapper connector — hosts in-widget bank choices; its
 *  name is never the bank itself. */
const OF_WRAPPER_NAME = 'MeuPluggy';

/** Webhook secret env key — read per call so tests can rotate it freely. */
const WEBHOOK_SECRET_ENV = 'PLUGGY_WEBHOOK_SECRET';

/**
 * Pluggy reports balances/amounts as currency-unit floats; the port's unit is
 * integer milliunits. This is the ONE conversion: rounded to whole cents first
 * (Pluggy amounts carry at most 2 decimals; the float noise of `x * 100` is
 * removed), then x10, so rows already stored by earlier syncs compare equal.
 */
const milliFrom = (amount: number): number => Math.round(amount * 100) * 10;

/** Constant-time compare of two same-length-ish byte strings. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a compare to keep timing uniform for wrong-length secrets.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Bearer token or custom header, both carrying PLUGGY_WEBHOOK_SECRET. */
export function webhookSecretFrom(headers: Headers, expected: string): string | null {
  const bearer = headers.get('authorization');
  if (bearer?.startsWith('Bearer ') && secretsMatch(bearer.slice('Bearer '.length).trim(), expected)) {
    return 'authorization';
  }
  const custom = headers.get('x-pluggy-webhook-secret');
  if (custom != null && secretsMatch(custom.trim(), expected)) {
    return 'x-pluggy-webhook-secret';
  }
  return null;
}

/** Map an upstream item status onto the generic connection lifecycle. */
export function mapItemStatus(providerStatus: string): ConnectionStatus {
  return STATUS_BY_PROVIDER[providerStatus] ?? 'error';
}

const milliOrNull = (amount: number | null | undefined): number | null =>
  amount == null ? null : milliFrom(amount);

/** Newest bill first: by dueDate, falling back to createdAt. */
function latestBillOf(bills: Bill[]): Bill | null {
  const key = (b: Bill) => b.dueDate ?? b.createdAt ?? '';
  return [...bills].sort((a, b) => key(b).localeCompare(key(a)))[0] ?? null;
}

/**
 * Credit details from `creditData` + the bills list. See `CreditDetails` for
 * the used/limit rule. A malformed creditData degrades to nulls, never throws.
 */
export function toCreditDetails(creditData: unknown, bills: Bill[] = []): CreditDetails {
  const parsed = CreditData.safeParse(creditData ?? {});
  const data = parsed.success ? parsed.data : null;
  const lines = data?.disaggregatedCreditLimits ?? [];
  const totalLines = lines.filter((l) => l.creditLineLimitType === 'LIMITE_CREDITO_TOTAL' && l.usedAmount != null);
  const pool = totalLines.length > 0 ? totalLines : lines.filter((l) => l.usedAmount != null);
  const line = [...pool].sort((a, b) => (b.limitAmount ?? 0) - (a.limitAmount ?? 0))[0];

  let limit = milliOrNull(data?.creditLimit);
  let available = milliOrNull(data?.availableCreditLimit);
  let used: number | null = null;
  if (line?.usedAmount != null) {
    used = milliFrom(line.usedAmount);
    limit = milliOrNull(line.limitAmount) ?? limit;
    available = milliOrNull(line.availableAmount) ?? (limit != null ? limit - used : available);
  } else if (limit != null && available != null) {
    used = Math.max(0, limit - available);
  }

  const bill = latestBillOf(bills);
  return {
    limit,
    available,
    used,
    minimumPayment: milliOrNull(data?.minimumPayment),
    dueDate: data?.balanceDueDate ?? null,
    latestBill:
      bill == null
        ? null
        : {
            total: milliOrNull(bill.totalAmount),
            dueDate: bill.dueDate ?? null,
            minimumPayment: milliOrNull(bill.minimumPaymentAmount),
          },
  };
}

/** Reshape one upstream account onto the port's external account. */
export function toExternalAccount(account: Account, bills?: Bill[]): ExternalAccount {
  return {
    ...(account.type === 'CREDIT' ? { credit: toCreditDetails(account.creditData, bills) } : {}),
    externalId: account.id,
    name: (account.name ?? '').trim(),
    type: account.type,
    currencyCode: account.currencyCode ?? null,
    balance: account.balance == null ? null : milliFrom(account.balance),
    institution: typeof account.institution === 'string' ? account.institution : null,
  };
}

/** Reshape one upstream transaction onto the port's aggregated transaction. */
export function toAggregatedTransaction(txn: Transaction, accountType: ExternalAccountType = 'BANK'): AggregatedTransaction {
  const status = txn.status?.toUpperCase();
  return {
    externalId: txn.id,
    externalAccountId: txn.accountId,
    description: (txn.description ?? '').trim(),
    // Pluggy credit accounts report purchases POSITIVE and bill payments
    // NEGATIVE; the port contract is "negative = money leaving you".
    amount: accountType === 'CREDIT' ? -milliFrom(txn.amount) : milliFrom(txn.amount),
    cleared: status != null && (CLEARED_BY_PROVIDER[status] ?? false),
    date: txn.date,
    currencyCode: null,
  };
}

export type PluggyAggregatorOptions = {
  /** Fixed config, or a lazy provider (env read deferred to first use). */
  config?: PluggyConfig | (() => PluggyConfig);
  /** Test seam — overrides the global fetch used for provider calls. */
  fetchImpl?: FetchLike;
  /** Test seam — clock for API-key expiry math. */
  now?: () => number;
  /** Shared webhook secret; defaults to `PLUGGY_WEBHOOK_SECRET` per call. */
  webhookSecret?: string | (() => string | undefined);
};

export class PluggyAggregator implements BankAggregator {
  private readonly client: PluggyClient;
  private readonly options: PluggyAggregatorOptions;
  /** Upstream account id → type, learned from listings; sync calls listTransactions by id only. */
  private readonly accountTypes = new Map<string, ExternalAccountType>();

  constructor(options: PluggyAggregatorOptions = {}) {
    this.options = options;
    const config = options.config ?? loadPluggyConfig;
    this.client = new PluggyClient(config, options.fetchImpl, options.now);
  }

  /** Same config the client resolves — lazy so env keys fail on first use. */
  get environment(): 'sandbox' | 'production' {
    return this.client.environment;
  }

  async verifyCredentials(): Promise<boolean> {
    return this.client.verifyCredentials();
  }

  async createConnectToken(input: ConnectTokenInput): Promise<ConnectToken> {
    const upstream = await this.client.createConnectToken({
      ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      clientUserId: input.clientUserId,
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
      ...(input.oauthRedirectUri !== undefined ? { oauthRedirectUri: input.oauthRedirectUri } : {}),
      ...(input.avoidDuplicates !== undefined ? { avoidDuplicates: input.avoidDuplicates } : {}),
    });
    return {
      token: upstream.accessToken,
      clientId: this.client.clientId,
      // Production /connect_token returns only {accessToken}; the widget URL is
      // the documented embed form (sandbox echoes a ready-made connectUrl).
      // The hosted widget reads `connect_token` from the query string
      // (verified in the connect.pluggy.ai bundle), never `token`.
      widgetUrl:
        upstream.connectUrl ??
        `https://connect.pluggy.ai/?connect_token=${encodeURIComponent(upstream.accessToken)}`,
    };
  }

  async listExternalAccounts(externalItemId: string): Promise<ExternalAccount[]> {
    const accounts = await this.client.listAccounts({ itemId: externalItemId }).catch((e) => {
      throw classifyPluggyError(e);
    });
    for (const account of accounts) this.accountTypes.set(account.id, account.type);
    return Promise.all(
      accounts.map(async (account) => {
        if (account.type !== 'CREDIT') return toExternalAccount(account);
        // Bills are best-effort: a failure must not hide the account itself.
        const bills = await this.client.listBills({ accountId: account.id, pageSize: 12 }).catch(() => []);
        return toExternalAccount(account, bills);
      }),
    );
  }

  private async accountType(externalAccountId: string): Promise<ExternalAccountType> {
    const known = this.accountTypes.get(externalAccountId);
    if (known) return known;
    const type = (await this.client.getAccount(externalAccountId)).type;
    this.accountTypes.set(externalAccountId, type);
    return type;
  }

  async fetchInstitution(externalItemId: string): Promise<string | null> {
    const item = await this.client.getItem(externalItemId);
    // The connector name is the bank identity ("Itaú Unibanco PF"). Current
    // items nest it at `connector.name`; legacy items carry flat fields, and
    // some connectors instead expose an institution object — prefer whichever
    // carries a usable human name. `institution` is typed unknown by the Item
    // schema; narrow at the read site instead of casting.
    const raw: unknown = item.institution;
    const nested = raw != null && typeof raw === 'object' && 'name' in raw ? raw.name : undefined;
    const fromItem = [item.connector?.name, item.connectorName, nested].find(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    );
    // MeuPluggy (Pluggy's Open-Finance wrapper, connector 200) hosts bank
    // choices made inside the widget — its name is not a bank. Open-Finance
    // items carry no participant field anywhere on the item; the bank shows
    // up only in the account names ("Nu Pagamentos S.A. - Instituição de
    // Pagamento", "itau"), so fall through to those.
    const fromWrapper = fromItem === OF_WRAPPER_NAME;
    if (fromItem != null && !fromWrapper) return fromItem.trim();
    const accounts = await this.client.listAccounts({ itemId: externalItemId });
    const bank = accounts.find((account) => account.type === 'BANK') ?? accounts[0];
    // Legal names suffix the brand ("Nu Pagamentos S.A. - Instituição de
    // Pagamento") — keep the leading brand chunk only.
    const label = (bank?.name ?? '').split(' - ')[0].trim();
    return label !== '' ? label : null;
  }

  async listTransactions(
    externalAccountId: string,
    input: ListTransactionsInput = {},
  ): Promise<{ transactions: AggregatedTransaction[]; hasMore: boolean }> {
    let upstream: Awaited<ReturnType<PluggyClient['listTransactions']>>;
    let type: ExternalAccountType;
    try {
      type = await this.accountType(externalAccountId);
      upstream = await this.client.listTransactions({
        accountId: externalAccountId,
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
      });
    } catch (e) {
      throw classifyPluggyError(e);
    }
    return {
      transactions: upstream.results.map((txn) => toAggregatedTransaction(txn, type)),
      hasMore: upstream.hasMore,
    };
  }

  async deleteConnection(externalItemId: string): Promise<void> {
    try {
      await this.client.deleteItem(externalItemId);
    } catch (err) {
      // Already gone upstream — deletion is idempotent.
      if (err instanceof PluggyError && err.status === 404) return;
      throw err;
    }
  }

  mapWebhookDelivery(payload: unknown): Delivery | null {
    const parsed = WebhookEvent.safeParse(payload);
    if (!parsed.success) return null;
    const { event } = parsed.data;
    const base = {
      eventId: parsed.data.eventId,
      event,
      externalItemId: parsed.data.itemId ?? null,
      clientUserId: parsed.data.clientUserId ?? null,
      raw: payload,
    };
    if (SYNC_EVENTS.has(event)) return { ...base, action: 'sync' };
    if (event === 'item/waiting_user_action') return { ...base, action: 'status', status: 'unauthorized' };
    if (event === 'item/error') {
      const code = (parsed.data as { error?: { code?: unknown } }).error?.code;
      return { ...base, action: 'status', status: typeof code === 'string' && AUTH_ERROR_CODE.test(code) ? 'unauthorized' : 'error' };
    }
    return { ...base, action: 'ignore' };
  }

  async getItemState(externalItemId: string): Promise<ItemState> {
    try {
      return itemStateFrom(await this.client.getItem(externalItemId));
    } catch (e) {
      throw classifyPluggyError(e);
    }
  }

  mapStatus(providerStatus: string): ConnectionStatus {
    return mapItemStatus(providerStatus);
  }

  verifyWebhookHeaders(headers: Headers): boolean {
    const expected = this.webhookSecret();
    if (expected == null || expected.length === 0) return false; // fail closed
    return webhookSecretFrom(headers, expected) != null;
  }

  private webhookSecret(): string | undefined {
    if (this.options.webhookSecret === undefined) {
      return pluggyEnv()[WEBHOOK_SECRET_ENV];
    }
    return typeof this.options.webhookSecret === 'function'
      ? this.options.webhookSecret()
      : this.options.webhookSecret;
  }
}
