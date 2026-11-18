/**
 * Seed data — a realistic but entirely FAKE budget. SHARED CONTRACT.
 *
 * NO real financials, no real payees, no bank sync. All amounts are integer
 * cents. Activity maps are DERIVED from the seeded transactions so the data is
 * internally consistent with the engine.
 *
 * Every account balance equals the sum of its transactions (docs/budget-engine-spec.md
 * L1): opening money is a "Starting Balance" row dated before the first
 * activity (cash in, card debt as an uncategorized outflow), and the card
 * payment on 2026-06-10 is a linked transfer (both legs, `transferAccountId`).
 *
 * Tuned so the current month (202606) shows the full pill spectrum:
 *   green  : Academia, Mercado, Farmacia, Saude, Celular
 *   yellow : Psiquiatra (R$800 needed by the 30th), Transporte, Ifood,
 *            Itau Cartão (payment: R$2.000 assigned, debt not covered)
 *   gray   : Diversão
 *   credit : Comer Fora (overspent on the card, no cash overspend; yellow style)
 * Ready to Assign comes out to R$25.715,00 (see engine.test.ts).
 */

import { recomputeActivity } from "../engine";
import type {
  Account,
  Budget,
  Category,
  CategoryGroup,
  CategoryTarget,
  MonthKey,
  Transaction,
} from "../types";

export const CURRENT_MONTH: MonthKey = 202606;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_MES = "grp-mes";
const GROUP_CC = "grp-cc-payments";

const groups: CategoryGroup[] = [
  {
    id: GROUP_MES,
    name: "Mes",
    categoryIds: [
      "cat-academia",
      "cat-mercado",
      "cat-psiquiatra",
      "cat-transporte",
      "cat-diversao",
      "cat-comer-fora",
      "cat-farmacia",
      "cat-ifood",
      "cat-saude",
      "cat-celular",
    ],
  },
  {
    id: GROUP_CC,
    name: "Credit Card Payments",
    isCreditCardPayments: true,
    categoryIds: ["cat-nubank-payment"],
  },
];

// ---------------------------------------------------------------------------
// Categories (assigned only; activity is derived from transactions below)
// ---------------------------------------------------------------------------

/** Seed drafts carry the unified target minus its categoryId — injected from
 * the owning category id below (single source: `category.target`, nc5). */
type SeedCategoryDraft = Omit<Category, "activity" | "target"> & {
  assigned: Record<MonthKey, number>;
  target?: Omit<CategoryTarget, "categoryId">;
};

const seedCategoryDrafts: SeedCategoryDraft[] = [
  {
    id: "cat-academia",
    groupId: GROUP_MES,
    name: "Academia",
    assigned: { 202605: 12000, 202606: 12000 },
    target: { kind: "monthly", amountCents: 12000, config: {} },
    notes: "Mensalidade da academia.",
  },
  {
    id: "cat-mercado",
    groupId: GROUP_MES,
    name: "Mercado",
    assigned: { 202604: 95000, 202605: 110000, 202606: 120000 },
    target: { kind: "monthly", amountCents: 120000, config: {} },
  },
  {
    id: "cat-psiquiatra",
    groupId: GROUP_MES,
    name: "Psiquiatra",
    assigned: {},
    target: { kind: "custom", amountCents: 80000, config: { byDate: "2026-06-30" } },
    notes: "Consulta mensal.",
  },
  {
    id: "cat-transporte",
    groupId: GROUP_MES,
    name: "Transporte",
    assigned: { 202604: 9000, 202606: 10000 },
    target: { kind: "monthly", amountCents: 30000, config: {} },
  },
  {
    id: "cat-diversao",
    groupId: GROUP_MES,
    name: "Diversão",
    assigned: {},
  },
  {
    id: "cat-comer-fora",
    groupId: GROUP_MES,
    name: "Comer Fora",
    assigned: { 202606: 5000 },
  },
  {
    id: "cat-farmacia",
    groupId: GROUP_MES,
    name: "Farmacia",
    assigned: { 202606: 6000 },
  },
  {
    id: "cat-ifood",
    groupId: GROUP_MES,
    name: "Ifood",
    assigned: { 202604: 15000, 202605: 18000, 202606: 12000 },
    target: { kind: "monthly", amountCents: 20000, config: {} },
  },
  {
    id: "cat-saude",
    groupId: GROUP_MES,
    name: "Saude",
    assigned: { 202606: 50000 },
    target: { kind: "monthly", amountCents: 50000, config: {} },
  },
  {
    id: "cat-celular",
    groupId: GROUP_MES,
    name: "Celular",
    assigned: { 202606: 9000 },
    target: { kind: "monthly", amountCents: 9000, config: {} },
  },
  {
    id: "cat-nubank-payment",
    groupId: GROUP_CC,
    name: "Itau Cartão",
    assigned: { 202606: 200000 },
    notes: "Reserva para pagar a fatura do cartão.",
  },
];

/** Final seed categories: each draft's target gets its categoryId stamped from
 * the owning category (the unified `CategoryTarget` is category-bound, nc5). */
const seedCategories: Category[] = seedCategoryDrafts.map(({ target, ...rest }) => ({
  ...rest,
  activity: {},
  target: target ? { ...target, categoryId: rest.id } : undefined,
}));

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const ACCOUNT_CHECKING = "acc-itau-cc";
const ACCOUNT_CREDIT = "acc-nubank";

const accounts: Account[] = [
  {
    id: ACCOUNT_CHECKING,
    name: "Itau Conta Corrente",
    type: "checking",
    group: "CASH",
    onBudget: true,
    clearedBalance: 2942000,
    unclearedBalance: -5500,
    lastReconciledAt: "2025-11-15T12:00:00Z",
    userId: null,
  },
  {
    id: ACCOUNT_CREDIT,
    name: "Itau Cartão",
    type: "credit",
    group: "CREDIT",
    onBudget: true,
    clearedBalance: -335369,
    unclearedBalance: -10000,
    lastReconciledAt: null,
    userId: null,
  },
];

// ---------------------------------------------------------------------------
// Transactions (drive category activity)
// ---------------------------------------------------------------------------

let txnSeq = 0;
function txn(t: Omit<Transaction, "id" | "upcoming" | "repeatRuleId">): Transaction {
  return { id: `txn-${String(++txnSeq).padStart(3, "0")}`, ...t, repeatRuleId: null, upcoming: false };
}

const transactions: Transaction[] = [
  // --- 202606 (current month) ---
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-02",
    payee: "Salário",
    categoryId: null,
    memo: "Pagamento mensal",
    outflow: 0,
    inflow: 1380000,
    cleared: "cleared",
    approved: true,
    repeat: "monthly",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-03",
    payee: "Smart Fit",
    categoryId: "cat-academia",
    memo: "",
    outflow: 12000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "monthly",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-06-05",
    payee: "Pão de Açúcar",
    categoryId: "cat-mercado",
    memo: "Compra da semana",
    outflow: 45000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-08",
    payee: "Hortifruti",
    categoryId: "cat-mercado",
    memo: "",
    outflow: 40000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-06-09",
    payee: "Posto Shell",
    categoryId: "cat-transporte",
    memo: "Gasolina",
    outflow: 8000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-06-11",
    payee: "Restaurante Madero",
    categoryId: "cat-comer-fora",
    memo: "Jantar",
    outflow: 9000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-06-12",
    payee: "iFood",
    categoryId: "cat-ifood",
    memo: "",
    outflow: 10000,
    inflow: 0,
    cleared: "uncleared",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-10",
    payee: "Vivo",
    categoryId: "cat-celular",
    memo: "Conta do celular",
    outflow: 9000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "monthly",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-13",
    payee: "Transferência PIX",
    categoryId: null,
    memo: "Precisa de categoria",
    outflow: 5500,
    inflow: 0,
    cleared: "uncleared",
    approved: false,
    repeat: "never",
  }),

  // --- 202605 ---
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-05-04",
    payee: "Carrefour",
    categoryId: "cat-mercado",
    memo: "",
    outflow: 60000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-05-12",
    payee: "Pão de Açúcar",
    categoryId: "cat-mercado",
    memo: "",
    outflow: 50000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-05-15",
    payee: "iFood",
    categoryId: "cat-ifood",
    memo: "",
    outflow: 18000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-05-03",
    payee: "Smart Fit",
    categoryId: "cat-academia",
    memo: "",
    outflow: 12000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "monthly",
  }),
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-05-02",
    payee: "Salário",
    categoryId: null,
    memo: "",
    outflow: 0,
    inflow: 1380000,
    cleared: "reconciled",
    approved: true,
    repeat: "monthly",
  }),

  // --- 202604 ---
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-04-10",
    payee: "Extra",
    categoryId: "cat-mercado",
    memo: "",
    outflow: 95000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-04-14",
    payee: "iFood",
    categoryId: "cat-ifood",
    memo: "",
    outflow: 15000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-04-18",
    payee: "Posto Ipiranga",
    categoryId: "cat-transporte",
    memo: "Gasolina",
    outflow: 9000,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),

  // --- opening money: Starting Balance rows dated before the first activity ---
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-04-01",
    payee: "Starting Balance",
    categoryId: null,
    memo: "",
    outflow: 0,
    inflow: 500000,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-04-01",
    payee: "Starting Balance",
    categoryId: null,
    memo: "",
    outflow: 271369,
    inflow: 0,
    cleared: "reconciled",
    approved: true,
    repeat: "never",
  }),

  // --- card payment: a linked transfer, both legs ---
  txn({
    accountId: ACCOUNT_CHECKING,
    date: "2026-06-10",
    payee: `Transfer : Itau Cartão`,
    categoryId: null,
    memo: "Pagamento parcial da fatura",
    outflow: 100000,
    inflow: 0,
    cleared: "cleared",
    approved: true,
    repeat: "never",
    transferAccountId: ACCOUNT_CREDIT,
  }),
  txn({
    accountId: ACCOUNT_CREDIT,
    date: "2026-06-10",
    payee: `Transfer : Itau Conta Corrente`,
    categoryId: null,
    memo: "Pagamento parcial da fatura",
    outflow: 0,
    inflow: 100000,
    cleared: "cleared",
    approved: true,
    repeat: "never",
    transferAccountId: ACCOUNT_CHECKING,
  }),
];

// ---------------------------------------------------------------------------
// Assemble — derive activity from transactions
// ---------------------------------------------------------------------------

const months: MonthKey[] = [202604, 202605, 202606];

/** Build a fresh seeded budget (new object graph each call). */
export function createSeedBudget(): Budget {
  const categories: Category[] = seedCategories.map((c) => ({
    ...c,
    assigned: { ...c.assigned },
    activity: {},
  }));

  const budget: Budget = {
    bundles: [],
    id: "budget-casa",
    name: "Casa",
    currentMonth: CURRENT_MONTH,
    months: [...months],
    groups: groups.map((g) => ({ ...g, categoryIds: [...g.categoryIds] })),
    categories,
    accounts: accounts.map((a) => ({ ...a })),
    transactions: transactions.map((t) => ({ ...t })),
    monthNotes: {
      202606: "Mês com consulta no psiquiatra — lembrar de financiar.",
    },
  };

  // Derive activity maps from transactions (source of truth).
  const activity = recomputeActivity(budget);
  for (const cat of budget.categories) {
    cat.activity = { ...(activity[cat.id] ?? {}) };
  }

  return budget;
}

/** A ready-to-use seeded budget singleton (clone via createSeedBudget for isolation). */
export const seedBudget: Budget = createSeedBudget();
