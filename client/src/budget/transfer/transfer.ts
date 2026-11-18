/**
 * Budget transfer archive codecs: build the export zip (Plan.tsv +
 * Register.tsv) from a Budget and parse archives/loose TSVs back into a
 * canonical TransferPayload.
 *
 * Amounts are client CENTS (integers); the server converts to milliunits (x10).
 * Parse never throws — problems collect into errors[] / warnings[].
 */

import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';

import { budgetMonth, categoryFigures } from '../domain/zeroSum';
import type { Budget } from '../domain/types';

import { TRANSFER_PAYEE_RE } from '@shared/domain/transfers';
import { budgetToPayload, pairTransfers as pairPayloadTransfers } from './payload';
import type { TransferPayload } from './payload';
import {
  parseTsv,
  tsvRow,
  formatMoney,
  parseMoney,
  formatDate,
  parseDate,
  formatMonthCell,
  parseMonthCell,
  formatCleared,
  parseCleared,
} from './tsv';

/**
 * A budget member as the archive needs them: ids are not portable between
 * budgets, so persons travel as EMAIL and are resolved against the target
 * budget's members on import (unknown / blank = Shared).
 */
export interface TransferPerson {
  user_id: string;
  email: string | null;
}

export interface TransferOptions {
  now?: Date;
  /** Budget members: id -> email on export, email -> id on import. */
  people?: readonly TransferPerson[];
}

/** Trailing, optional columns (older archives lack them and still import). */
export const PLAN_PERSON_COLUMN = 'Person';
export const REGISTER_PERSON_COLUMN = 'Account Person';

const emailOf = (people: readonly TransferPerson[] | undefined, userId: string | null | undefined): string =>
  (userId && people?.find((p) => p.user_id === userId)?.email) || '';

export const PLAN_SUFFIX = ' - Plan.tsv';
export const REGISTER_SUFFIX = ' - Register.tsv';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** `yyyy-MM-dd HH-mm` stamp used in archive entry and zip names. */
function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    ` ${p(date.getHours())}-${p(date.getMinutes())}`
  );
}

const monthOfDate = (date: string): number => Number(date.slice(0, 4)) * 100 + Number(date.slice(5, 7));

/** Contiguous month keys from the first to the last month with a non-upcoming transaction or an assignment. */
function ledgerMonths(budget: Budget): number[] {
  const keys: number[] = [];
  for (const t of budget.transactions) if (!t.upcoming) keys.push(monthOfDate(t.date));
  for (const c of budget.categories) keys.push(...Object.keys(c.assigned).map(Number));
  if (keys.length === 0) return [];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const months: number[] = [];
  for (let m = first; m <= last; m = m % 100 === 12 ? m + 89 : m + 1) months.push(m);
  return months;
}

/** Plan.tsv text: one row per category per month (month asc, group order, category order). */
function buildPlanTsv(budget: Budget, people?: readonly TransferPerson[]): string {
  // Months come from the engine's view (spec L3): every month from the first
  // ledger month (earliest non-upcoming transaction or assignment) to the last
  // one, gaps included (they carry forward). The derived activity cache is not
  // consulted; every figure in the rows comes from the engine.
  const sorted = ledgerMonths(budget);

  // The Person column only exists when someone is assigned: a budget without
  // persons exports the exact reference format.
  const withPerson = budget.categories.some((c) => emailOf(people, c.userId) !== '');
  let tsv = tsvRow([
    'Month', 'Category Group/Category', 'Category Group', 'Category', 'Assigned', 'Activity', 'Available',
    ...(withPerson ? [PLAN_PERSON_COLUMN] : []),
  ]);
  for (const month of sorted) {
    // Assigned / Activity / Available are the engine's unified figures, so
    // card payment categories export their funded - payments and Available.
    const bm = budgetMonth(budget, month);
    for (const group of budget.groups) {
      for (const category of budget.categories) {
        if (category.groupId !== group.id) continue;
        const figures = categoryFigures(bm, category.id);
        tsv += tsvRow([
          formatMonthCell(month),
          `${group.name}: ${category.name}`,
          group.name,
          category.name,
          formatMoney(figures.assigned),
          formatMoney(figures.activity),
          formatMoney(figures.available),
          ...(withPerson ? [emailOf(people, category.userId)] : []),
        ]);
      }
    }
  }
  return tsv;
}

/** Register.tsv text: one row per transaction, date descending. */
function buildRegisterTsv(budget: Budget, now: Date, people?: readonly TransferPerson[]): string {
  const payload = budgetToPayload(budget, { now });
  const rows = payload.transactions
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : a.i - b.i));

  const withPerson = payload.accounts.some((a) => emailOf(people, a.userId) !== '');
  let tsv = tsvRow([
    'Account', 'Flag', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category',
    'Memo', 'Outflow', 'Inflow', 'Cleared', ...(withPerson ? [REGISTER_PERSON_COLUMN] : []),
  ]);
  for (const { t, i } of rows) {
    const source = budget.transactions[i]; // payload rows follow budget.transactions; balance rows have none
    // Transfer legs (and split parents, whose legs own the categories) carry no
    // category in YNAB; the importer reads an empty category as uncategorized.
    const noCategory = t.transferPeerIndex !== null || TRANSFER_PAYEE_RE.test(t.payee) ||
      !!source?.transferAccountId || (source?.splits?.length ?? 0) > 0;
    const account = payload.accounts[t.accountIndex]?.name ?? '';
    // Uncategorized inflows (cash income, card statement credits) are YNAB's "Inflow: Ready to Assign".
    const readyToAssign = t.categoryIndex === null && t.inflow > 0 && !noCategory;
    let group = '';
    let name = '';
    let compound = '';
    if (readyToAssign) {
      group = 'Inflow';
      name = 'Ready to Assign';
      compound = 'Inflow: Ready to Assign';
    } else if (t.categoryIndex !== null) {
      const category = payload.categories[t.categoryIndex];
      group = payload.groups[category.groupIndex] ?? '';
      name = category.name;
      compound = group === '' ? '' : `${group}/${name}`;
    }
    tsv += tsvRow([
      account,
      t.flag,
      formatDate(t.date),
      t.payee,
      compound,
      group,
      name,
      t.memo,
      formatMoney(t.outflow),
      formatMoney(t.inflow),
      formatCleared(t.cleared),
      ...(withPerson ? [emailOf(people, payload.accounts[t.accountIndex]?.userId)] : []),
    ]);
  }
  return tsv;
}

/**
 * Build the transfer export: zip name plus bytes containing the two TSV
 * entries named `<BudgetName> as of <stamp> - Plan.tsv` / `- Register.tsv`.
 */
export function buildTransferZip(
  budget: Budget,
  opts?: TransferOptions,
): { zipName: string; bytes: Uint8Array } {
  const now = opts?.now ?? new Date();
  const asOf = stamp(now);
  const zipName = `Budget Export - ${budget.name} as of ${asOf}.zip`;
  const prefix = `${budget.name} as of ${asOf}`;
  const bytes = zipSync({
    [`${prefix}${PLAN_SUFFIX}`]: strToU8(buildPlanTsv(budget, opts?.people)),
    [`${prefix}${REGISTER_SUFFIX}`]: strToU8(buildRegisterTsv(budget, now, opts?.people)),
  });
  return { zipName, bytes };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ParseResult {
  payload?: TransferPayload;
  warnings: string[];
  errors: string[];
}

/** `Mon YYYY` cell -> `YYYY-MM-01`. */
function monthCellToFirstOfMonth(cell: string): string | null {
  const key = parseMonthCell(cell);
  if (key === null) return null;
  return `${Math.floor(key / 100)}-${String(key % 100).padStart(2, '0')}-01`;
}

interface Universe {
  groups: string[];
  /** Group name for a category index (same indices as categories). */
  groupOf: (index: number) => string;
  categories: { groupIndex: number; name: string; userId?: string | null }[];
  /** Case-insensitive resolution on (group, name); -1 when unknown. */
  resolve: (group: string, name: string) => number;
}

/** Parse Plan.tsv rows into the category universe + assignments. */
function parsePlan(
  tsv: string,
  people: readonly TransferPerson[] | undefined,
  warnings: string[],
  errors: string[],
): { universe: Universe; assignments: TransferPayload['assignments'] } {
  const { header, rows } = parseTsv(tsv);
  const personCol = header.indexOf(PLAN_PERSON_COLUMN);
  if (header[0] !== 'Month' || header[2] !== 'Category Group' || header[3] !== 'Category') {
    errors.push('Plan.tsv: unexpected header row');
    return emptyUniverse();
  }
  const universe: Universe = {
    groups: [],
    categories: [],
    groupOf: (index) => universe.groups[universe.categories[index]?.groupIndex ?? -1] ?? '',
    resolve: (group, name) => {
      const lowerGroup = group.trim().toLowerCase();
      const lowerName = name.trim().toLowerCase();
      return universe.categories.findIndex(
        (c) => c.name.toLowerCase() === lowerName &&
          (universe.groups[c.groupIndex] ?? '').toLowerCase() === lowerGroup,
      );
    },
  };
  const categoryKeys = new Map<string, number>();
  const assignments: TransferPayload['assignments'] = [];

  for (const row of rows) {
    const month = monthCellToFirstOfMonth(row[0] ?? '');
    if (month === null) {
      errors.push(`Plan.tsv: unparseable month cell ${JSON.stringify(row[0] ?? '')}`);
      continue;
    }
    let group = (row[2] ?? '').trim();
    let name = (row[3] ?? '').trim();
    if (group === '' && name === '') {
      const compound = (row[1] ?? '').split(':');
      if (compound.length === 2) {
        group = compound[0].trim();
        name = compound[1].trim();
      }
    }
    if (group === '' || name === '') {
      errors.push(`Plan.tsv: row without category ${JSON.stringify(row.slice(0, 4))}`);
      continue;
    }
    const key = `${group.toLowerCase()}\u0000${name.toLowerCase()}`;
    let categoryIndex = categoryKeys.get(key);
    if (categoryIndex === undefined) {
      const groupIndex = universe.groups.indexOf(group);
      categoryIndex = universe.categories.length;
      if (groupIndex === -1) universe.groups.push(group);
      universe.categories.push({ groupIndex: groupIndex === -1 ? universe.groups.length - 1 : groupIndex, name });
      categoryKeys.set(key, categoryIndex);
    }
    if (personCol !== -1) {
      const category = universe.categories[categoryIndex];
      if (category.userId === undefined) {
        const id = resolvePerson(row[personCol] ?? '', people, warnings, 'Plan.tsv');
        if (id !== undefined) category.userId = id;
      }
    }
    const assigned = parseMoney(row[4] ?? '');
    if (assigned !== null && assigned !== 0) {
      assignments.push({ categoryIndex, month, budgeted: assigned });
    }
  }
  return { universe, assignments };
}

/**
 * Person cell (email) -> member id against the target budget's members.
 * undefined = no value in the cell; null = unknown email (-> Shared, warned).
 */
function resolvePerson(
  cell: string,
  people: readonly TransferPerson[] | undefined,
  warnings: string[],
  file: string,
): string | null | undefined {
  const email = cell.trim().toLowerCase();
  if (email === '') return undefined;
  const found = people?.find((p) => p.email?.toLowerCase() === email);
  if (found) return found.user_id;
  const note = `${file}: ${email} is not a member of this budget -> Shared`;
  if (!warnings.includes(note)) warnings.push(note);
  return null;
}

/** Placeholder universe for a rejected Plan (parse errors already recorded). */
function emptyUniverse(): { universe: Universe; assignments: TransferPayload['assignments'] } {
  return { universe: { groups: [], categories: [], groupOf: () => '', resolve: () => -1 }, assignments: [] };
}

/** Parse Register.tsv rows into accounts + transactions. */
function parseRegister(
  tsv: string,
  universe: Universe,
  people: readonly TransferPerson[] | undefined,
  warnings: string[],
  errors: string[],
): { accounts: { name: string; userId?: string | null }[]; transactions: TransferPayload['transactions'] } {
  const { header, rows } = parseTsv(tsv);
  if (header[0] !== 'Account' || header[10] !== 'Cleared') {
    errors.push('Register.tsv: unexpected header row');
    return { accounts: [], transactions: [] };
  }
  const personCol = header.indexOf(REGISTER_PERSON_COLUMN);
  const accounts: { name: string; userId?: string | null }[] = [];
  const accountIndexByName = new Map<string, number>();
  const accountIndexOf = (name: string): number => {
    const key = name.trim().toLowerCase();
    const existing = accountIndexByName.get(key);
    if (existing !== undefined) return existing;
    const index = accounts.length;
    accounts.push({ name: name.trim() });
    accountIndexByName.set(key, index);
    return index;
  };

  const transactions: TransferPayload['transactions'] = [];
  const unmatched = new Set<string>();
  for (const row of rows) {
    const date = parseDate(row[2] ?? '');
    if (date === null) {
      errors.push(`Register.tsv: unparseable date cell ${JSON.stringify(row[2] ?? '')}`);
      continue;
    }
    const accountIndex = accountIndexOf(row[0] ?? '');
    if (personCol !== -1 && accounts[accountIndex].userId === undefined) {
      const id = resolvePerson(row[personCol] ?? '', people, warnings, 'Register.tsv');
      if (id !== undefined) accounts[accountIndex].userId = id;
    }
    const categoryIndex = resolveCategoryCell(row, universe, unmatched);

    const clearedRaw = (row[10] ?? '').trim();
    const cleared = parseCleared(clearedRaw);
    if (cleared === null && clearedRaw !== '') {
      warnings.push(`Register.tsv: unknown Cleared cell ${JSON.stringify(clearedRaw)} -> uncleared`);
    }
    transactions.push({
      accountIndex,
      date,
      payee: row[3] ?? '',
      categoryIndex,
      memo: row[7] ?? '',
      outflow: parseMoney(row[8] ?? '') ?? 0,
      inflow: parseMoney(row[9] ?? '') ?? 0,
      cleared: cleared ?? 'uncleared',
      flag: row[1] ?? '',
      transferPeerIndex: null,
    });
  }
  if (unmatched.size > 0) {
    errors.push(`Register.tsv: unknown categories: ${[...unmatched].sort().join(', ')}`);
  }
  return { accounts, transactions };
}

/** Resolve a register row's category cells to a universe index, or null. */
function resolveCategoryCell(
  row: string[],
  universe: Universe,
  unmatched: Set<string>,
): number | null {
  const groupCell = (row[5] ?? '').trim();
  const nameCell = (row[6] ?? '').trim();
  const compound = (row[4] ?? '').trim();
  const isReadyToAssign =
    nameCell.toLowerCase() === 'ready to assign' || groupCell.toLowerCase() === 'inflow' ||
    compound.toLowerCase() === 'inflow: ready to assign';
  if (isReadyToAssign) return null;

  let group = groupCell;
  let name = nameCell;
  if (group === '' && name === '' && compound === '') return null;
  if (group === '' && compound !== '') group = compound.split('/')[0]?.trim() ?? '';
  if (name === '' && compound !== '') name = compound.split('/')[1]?.trim() ?? '';
  if (group === '' && name === '') return null;
  if (group === '' || name === '') {
    unmatched.add(`${group.toLowerCase()}/${name.toLowerCase()}`);
    return null;
  }
  const index = universe.resolve(group, name);
  if (index === -1) unmatched.add(`${group.toLowerCase()}/${name.toLowerCase()}`);
  return index === -1 ? null : index;
}

function pairTransfers(
  transactions: TransferPayload['transactions'],
  accounts: { name: string }[],
  warnings: string[],
  errors: string[],
): void {
  for (const c of transactions) {
    const other = TRANSFER_PAYEE_RE.exec(c.payee)?.[1]?.trim() ?? null;
    if (other !== null && accounts.every((a) => a.name.toLowerCase() !== other.toLowerCase())) {
      errors.push(`Register.tsv: transfer payee names unknown account ${JSON.stringify(other)}`);
    }
  }
  pairPayloadTransfers(
    transactions,
    accounts.map((a) => a.name),
  );
  for (const c of transactions) {
    if (TRANSFER_PAYEE_RE.test(c.payee) && c.transferPeerIndex === null) {
      warnings.push(`Register.tsv: unpaired transfer transaction ${JSON.stringify(c.payee)}`);
    }
  }
}

/**
 * Parse transfer files (a .zip archive and/or loose TSVs whose names end with
 * the Plan/Register suffixes) into a TransferPayload. Both tables are
 * required; errors are collected, never thrown.
 */
export function parseTransferFiles(
  files: { name: string; bytes: Uint8Array }[],
  opts?: Pick<TransferOptions, 'people'>,
): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  let plan: string | undefined;
  let register: string | undefined;

  for (const file of files) {
    if (file.name.endsWith(PLAN_SUFFIX) || file.name.endsWith(REGISTER_SUFFIX)) {
      let text = '';
      try {
        text = strFromU8(file.bytes);
      } catch {
        errors.push(`${file.name}: not valid UTF-8`);
      }
      if (file.name.endsWith(PLAN_SUFFIX)) plan = plan ?? text;
      else register = register ?? text;
      continue;
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(file.bytes);
    } catch {
      errors.push(`${file.name}: not a readable zip archive`);
      continue;
    }
    for (const [entryName, bytes] of Object.entries(entries)) {
      if (entryName.endsWith(PLAN_SUFFIX)) plan = plan ?? strFromU8(bytes);
      else if (entryName.endsWith(REGISTER_SUFFIX)) register = register ?? strFromU8(bytes);
    }
  }

  if (plan === undefined || register === undefined) {
    errors.push('both Plan.tsv and Register.tsv are required');
    return { warnings, errors };
  }

  const { universe, assignments } = parsePlan(plan, opts?.people, warnings, errors);
  const { accounts, transactions } = parseRegister(register, universe, opts?.people, warnings, errors);
  pairTransfers(transactions, accounts, warnings, errors);
  return {
    payload: {
      groups: universe.groups,
      categories: universe.categories,
      accounts,
      transactions,
      assignments,
    },
    warnings,
    errors,
  };
}
