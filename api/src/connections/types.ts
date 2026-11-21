/**
 * The Connections port — the only surface the server core (routes, store,
 * sync engine, poller) is allowed to know about.
 *
 * A bank aggregator is integrated by implementing `BankAggregator` in its own
 * adapter folder under `./adapters/<provider>/` and registering it in
 * `./registry.ts` (one line per provider). Everything provider-specific —
 * payload schemas, pagination quirks, webhook headers, env keys — stays
 * inside the adapter; this file stays provider-neutral.
 *
 * Vocabulary: a *connection* is the bank link (one row per upstream item);
 * "external" ids are the provider's ids for items, accounts and transactions.
 */

/**
 * Lifecycle of a connection as the core models it. `quota_exhausted` is
 * stale-not-broken: the provider's monthly quota is spent, so syncing pauses
 * until `connections.next_poll_at` (the start of next month).
 */
export type ConnectionStatus = 'connected' | 'unauthorized' | 'disconnected' | 'error' | 'quota_exhausted' | 'paused';
// `paused` is set by the core, never by a provider: the connection's key set
// may not be used by its owner right now (see ./keys.ts).

/**
 * Which key set created a connection's upstream item. A provider item is
 * reachable only with the credentials that created it, so every call for a
 * connection uses this key set and no other.
 *  - shared: the installation's keys (provider env), gated per user by the
 *    'shared-pluggy-key' feature
 *  - own:    the owner's own key set (public.connection_credentials)
 */
export type KeySource = 'shared' | 'own';

/** A user's own key set for a provider, decrypted, as an adapter consumes it. */
export type ProviderCredentials = {
  clientId: string;
  clientSecret: string;
};

/** What an inbound webhook asks the core to do. */
export type DeliveryAction = 'sync' | 'status' | 'ignore';

/** Provider-reported state of one upstream item (no side effects to read). */
export type ItemState = {
  status: ConnectionStatus;
  /** ISO timestamp of the provider's last refresh of the item, when reported. */
  lastUpdatedAt: string | null;
};

export type ExternalAccountType = 'BANK' | 'CREDIT';

/** Latest credit-card statement, integer milliunits. */
export type CreditBill = {
  total: number | null;
  dueDate: string | null;
  minimumPayment: number | null;
};

/**
 * Credit-card details for a CREDIT upstream account (integer milliunits,
 * magnitudes — all non-negative). Needed because issuers such as Itau report
 * `balance = 0` for cards. Every field is null when the provider did not
 * report it.
 *
 * `used` rule: the provider's total credit line ("LIMITE_CREDITO_TOTAL",
 * falling back to the largest reported line) `used` amount when present, since
 * the top-level limit/available fields are unreliable for shared multi-card
 * limits; otherwise `limit - available`. `limit`/`available` come
 * from that same line so the three figures stay consistent.
 */
export type CreditDetails = {
  limit: number | null;
  available: number | null;
  used: number | null;
  minimumPayment: number | null;
  dueDate: string | null;
  latestBill: CreditBill | null;
};

/** An upstream account discovered for a connection. Amounts are integer milliunits. */
export type ExternalAccount = {
  externalId: string;
  name: string;
  type: ExternalAccountType;
  currencyCode: string | null;
  /** Signed integer milliunits; null when the provider did not report a balance. */
  balance: number | null;
  /** Human institution name (bank/card issuer), when known. */
  institution: string | null;
  /** Credit-card details; null for BANK accounts (and when none were reported). */
  credit?: CreditDetails | null;
};

/** One upstream transaction, normalized for the sync engine. Amounts are integer milliunits. */
export type AggregatedTransaction = {
  externalId: string;
  /** The upstream account the transaction belongs to. */
  externalAccountId: string;
  description: string;
  /**
   * Signed integer milliunits, normalized by the adapter for EVERY account type:
   * negative = money leaving you (a purchase, incl. card purchases), positive
   * = money arriving (incl. card bill payments). Providers whose credit
   * accounts use the opposite convention invert inside the adapter — the sync
   * engine applies no per-type logic.
   */
  amount: number;
  /** Upstream cleared/completed state — import policy (e.g. always uncleared) stays engine-side. */
  cleared: boolean;
  /** ISO date (YYYY-MM-DD) or full ISO timestamp, as reported upstream. */
  date: string;
  currencyCode: string | null;
};

/**
 * A classified inbound webhook payload. `raw` keeps the untouched body so the
 * dedupe ledger can store exactly what was delivered.
 */
export type Delivery = {
  eventId: string;
  event: string;
  /** The connection (upstream item) the event refers to, when identifiable. */
  externalItemId: string | null;
  /** App-scoped user identity carried by the payload, when present. */
  clientUserId: string | null;
  /** sync = enqueue a coalesced sync; status = apply `status`; ignore = record only. */
  action: DeliveryAction;
  /** For action 'status': the lifecycle state the event reports. */
  status?: ConnectionStatus;
  raw: unknown;
};

/** Input for minting a connect token. */
export type ConnectTokenInput = {
  /** App-scoped user identity the connection belongs to. */
  clientUserId: string;
  /** Provider institution/connector id — mints a token for a NEW connection. */
  connectorId?: number;
  /** Existing external item id — mints a re-auth token for an EXISTING connection. */
  itemId?: string;
  /** Where the provider should POST webhook events for the new connection. */
  webhookUrl?: string;
  oauthRedirectUri?: string;
  /** Ask the provider to refuse a duplicate connection for the same account. */
  avoidDuplicates?: boolean;
};

/** Credential bundle a client app needs to drive the provider's connect widget. */
export type ConnectToken = {
  /** Short-lived token for the connect widget. */
  token: string;
  /** The provider's client id, needed by widget SDK variants that init from id + token. */
  clientId: string | null;
  /** Hosted widget URL, when the provider supplies one (hosted-connect flows). */
  widgetUrl: string | null;
};

export type ListTransactionsInput = {
  /** ISO date (inclusive) — lower bound of the pull window. */
  from?: string;
  /** ISO date (inclusive) — upper bound of the pull window. */
  to?: string;
  /**
   * 1-based page hint for page-addressed providers. Cursor-based providers
   * return one bounded pull and report `hasMore` instead; callers must not
   * loop on `hasMore` — re-pull the window on the next sync cycle.
   */
  page?: number;
};

/**
 * The provider-neutral bank aggregator port. New aggregator = new adapter
 * implementing this interface; the core never learns provider details.
 */
export interface BankAggregator {
  /** Where these credentials point — 'sandbox' keeps auto-sync polling off. */
  readonly environment: 'sandbox' | 'production';

  /**
   * Check the credentials this aggregator was built with against the provider
   * (one cheap call, no item touched). False = the provider refused the pair;
   * any other failure (network, 5xx) is thrown.
   */
  verifyCredentials(): Promise<boolean>;

  /**
   * Can these credentials reach the upstream item? False = the provider says
   * the item does not exist for them (it belongs to another key set); any
   * other failure is thrown. One provider call, no side effects.
   */
  hasItem(externalItemId: string): Promise<boolean>;

  /** Mint a connect token for the widget, scoped to `clientUserId`. */
  createConnectToken(input: ConnectTokenInput): Promise<ConnectToken>;

  /** Discover the upstream accounts of the connection with this external item id. */
  listExternalAccounts(externalItemId: string): Promise<ExternalAccount[]>;

  /**
   * Pull transactions for one upstream account. Returns a bounded pull with
   * `hasMore` signalling that more exists beyond the adapter's pull cap (the
   * next sync cycle re-pulls the window — see ListTransactionsInput.page).
   */
  listTransactions(
    externalAccountId: string,
    input?: ListTransactionsInput,
  ): Promise<{ transactions: AggregatedTransaction[]; hasMore: boolean }>;

  /** Remove the connection upstream. Idempotent: already-gone is not an error. */
  deleteConnection(externalItemId: string): Promise<void>;

  /**
   * The human bank name for one connection ("Itaú Unibanco PF"), when the
   * provider reports it; null when it does not. Drives the connection's
   * display name on the banks page and the account editor.
   */
  fetchInstitution(externalItemId: string): Promise<string | null>;

  /**
   * Classify an inbound webhook body. Unrecognizable payloads → null (the
   * webhook route turns that into 400).
   */
  mapWebhookDelivery(payload: unknown): Delivery | null;

  /**
   * Read the item's current state (one provider call). Used by the sweep
   * (`lastUpdatedAt` vs our watermark) and before a pull to spot revoked
   * consent / exhausted quota. Failures are thrown as AggregatorError.
   */
  getItemState(externalItemId: string): Promise<ItemState>;

  /** Map a provider item status onto the generic lifecycle. */
  mapStatus(providerStatus: string): ConnectionStatus;

  /**
   * True when the request headers authenticate the webhook call (dual-header
   * shared-secret check). An unconfigured adapter always answers false — the
   * webhook route fails closed separately for that case.
   */
  verifyWebhookHeaders(headers: Headers): boolean;
}
