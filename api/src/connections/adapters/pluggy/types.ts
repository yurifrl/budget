import { z } from '@shared/zod';

/**
 * Pluggy API response schemas.
 *
 * Deliberately lenient (`passthrough`, most fields optional): the aggregator's
 * payloads evolve and vary per connector. We only validate the fields our
 * tools actually read; everything else flows through untouched.
 */

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      results: z.array(item),
      page: z.number().optional(),
      totalPages: z.number().optional(),
      total: z.number().optional(),
      totalItems: z.number().optional(),
      nextPage: z.string().nullish(),
    })
    .passthrough();

export const ItemStatus = z.enum([
  'UPDATED',
  'UPDATING',
  'OUTDATED',
  'LOGIN_ERROR',
  'WAITING_USER_ACTION',
  'MFA_CHALLENGE',
  'ACCOUNT_UPDATED',
  'PROCESSING',
  'PARTIAL_SUCCESS',
]);

export const Connector = z
  .object({
    id: z.number(),
    name: z.string(),
    url: z.string().nullish(),
    primaryColor: z.string().nullish(),
    type: z.string().nullish(),
    sandbox: z.boolean().nullish(),
  })
  .passthrough();
export type Connector = z.infer<typeof Connector>;

export const Item = z
  .object({
    id: z.string(),
    /** Legacy flat fields — current items nest the connector as an object. */
    connectorId: z.number().nullish(),
    connectorName: z.string().nullish(),
    connector: Connector.nullish(),
    status: ItemStatus,
    clientUserId: z.string().nullish(),
    createdAt: z.string().nullish(),
    lastUpdatedAt: z.string().nullish(),
    lastSuccessfulAt: z.string().nullish(),
    executionStatus: z.string().nullish(),
  })
  .passthrough();
export type Item = z.infer<typeof Item>;

export const AccountType = z.enum(['BANK', 'CREDIT']);

/** One Open-Finance credit line ("LIMITE_CREDITO_TOTAL" etc.). All amounts BRL floats. */
export const DisaggregatedCreditLimit = z
  .object({
    creditLineLimitType: z.string().nullish(),
    consolidationType: z.string().nullish(),
    identificationNumber: z.string().nullish(),
    lineName: z.string().nullish(),
    limitAmount: z.number().nullish(),
    usedAmount: z.number().nullish(),
    availableAmount: z.number().nullish(),
  })
  .passthrough();

/**
 * `Account.creditData` for CREDIT accounts. Tolerant: every field nullish, and
 * a malformed payload is parsed via safeParse at the read site (never throws).
 */
export const CreditData = z
  .object({
    creditLimit: z.number().nullish(),
    availableCreditLimit: z.number().nullish(),
    minimumPayment: z.number().nullish(),
    balanceDueDate: z.string().nullish(),
    balanceCloseDate: z.string().nullish(),
    disaggregatedCreditLimits: z.array(DisaggregatedCreditLimit).nullish(),
  })
  .passthrough();
export type CreditData = z.infer<typeof CreditData>;

export const Account = z
  .object({
    id: z.string(),
    itemId: z.string(),
    type: AccountType,
    name: z.string().nullish(),
    balance: z.number().nullish(),
    currencyCode: z.string().nullish(),
    number: z.string().nullish(),
    owner: z.string().nullish(),
    taxNumber: z.string().nullish(),
    institution: z.unknown().nullish(),
    creditData: z.unknown().nullish(),
    lastRefreshedAt: z.string().nullish(),
  })
  .passthrough();
export type Account = z.infer<typeof Account>;

export const CreditCardMetadata = z
  .object({
    billId: z.string().nullish(),
    closingDate: z.string().nullish(),
    dueDate: z.string().nullish(),
    isInstalment: z.boolean().nullish(),
    instalmentNumber: z.number().nullish(),
    totalInstalments: z.number().nullish(),
  })
  .passthrough();

export const Transaction = z
  .object({
    id: z.string(),
    accountId: z.string(),
    amount: z.number(),
    date: z.string(),
    description: z.string().nullish(),
    status: z.string().nullish(),
    type: z.string().nullish(),
    category: z.unknown().nullish(),
    providerCode: z.string().nullish(),
    creditCardMetadata: CreditCardMetadata.nullish(),
  })
  .passthrough();
export type Transaction = z.infer<typeof Transaction>;

export const Investment = z
  .object({
    id: z.string(),
    itemId: z.string(),
    type: z.string().nullish(),
    name: z.string().nullish(),
    balance: z.number().nullish(),
    amount: z.number().nullish(),
    currencyCode: z.string().nullish(),
    profitability: z.unknown().nullish(),
    lastRefreshedAt: z.string().nullish(),
  })
  .passthrough();
export type Investment = z.infer<typeof Investment>;

export const Loan = z
  .object({
    id: z.string(),
    itemId: z.string(),
    kind: z.string().nullish(),
    type: z.string().nullish(),
    name: z.string().nullish(),
    outstandingBalance: z.number().nullish(),
    contractCurrency: z.string().nullish(),
    lastRefreshedAt: z.string().nullish(),
  })
  .passthrough();
export type Loan = z.infer<typeof Loan>;

export const BillCharge = z
  .object({ type: z.string().nullish(), additionalInfo: z.string().nullish(), amount: z.number().nullish() })
  .passthrough();

export const Bill = z
  .object({
    id: z.string(),
    // Pluggy /bills rows carry NO accountId (the account is the query filter).
    accountId: z.string().nullish(),
    billClosingDate: z.string().nullish(),
    dueDate: z.string().nullish(),
    totalAmount: z.number().nullish(),
    totalAmountCurrencyCode: z.string().nullish(),
    minimumPaymentAmount: z.number().nullish(),
    allowsInstallments: z.boolean().nullish(),
    financeCharges: z.array(z.unknown()).nullish(),
    payments: z.array(z.unknown()).nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();
export type Bill = z.infer<typeof Bill>;

export const Category = z
  .object({ id: z.string(), name: z.string(), description: z.string().nullish(), group: z.string().nullish() })
  .passthrough();
export type Category = z.infer<typeof Category>;

export const PluggyAuthResponse = z
  .object({ apiKey: z.string(), expirationDate: z.string().nullish() })
  .passthrough();

export const ConnectTokenResponse = z
  .object({
    accessToken: z.string(),
    // Production returns {accessToken} only — connectUrl is a sandbox-only field.
    connectUrl: z.string().optional(),
    itemId: z.string().nullish(),
  })
  .passthrough();
export type ConnectTokenResponse = z.infer<typeof ConnectTokenResponse>;

/**
 * Inbound webhook event body — identity fields only (passthrough keeps the
 * rest, the raw body goes into the dedupe ledger untouched).
 */
export const WebhookEvent = z
  .object({
    event: z.string().min(1),
    eventId: z.string().min(1),
    itemId: z.string().min(1).optional(),
    clientUserId: z.string().min(1).optional(),
  })
  .passthrough();
export type WebhookEvent = z.infer<typeof WebhookEvent>;