/**
 * People — pure domain logic for "who an account belongs to" (multi-user
 * sharing). A household shares one budget; an account optionally belongs to
 * one budget member (`Account.userId`), null meaning Shared. Presentation
 * helpers for a member live here (one definition: rail chip, picker rows),
 * together with the budget-wide "by person" filter (Plan, Reflect, Spending).
 */

import type { AvatarPerson, PersonAvatar } from './avatar';

import { recomputeActivity } from './engine';
import { t } from './i18n';
import { categoryFigures, sumFigures, type BudgetMonth } from './zeroSum';
import type { Account, Budget, Category, Cents, MonthKey, Transaction } from './types';

/** A budget member as the UI sees them (the members API row). */
export interface Person {
  user_id: string;
  /** Null for a placeholder person (grouping only; an email can be linked later). */
  email: string | null;
  name: string | null;
  /** Generated-look seed + uploaded-photo version (the app-wide avatar contract). */
  avatar: PersonAvatar;
  is_owner: boolean;
  /** The viewer. */
  is_me: boolean;
  /** Invited but has never signed in. */
  pending: boolean;
}

/** Label of the null person, in the active language. */
export function sharedLabel(): string {
  return t('people.shared');
}

/** Display label: the trimmed name when set, else the email, else a neutral fallback. */
export function personLabel(person: Pick<Person, 'email' | 'name'>): string {
  const name = person.name?.trim();
  return name || person.email || t('people.unnamed');
}

/**
 * Connection status badge for a person row: a placeholder has no email yet
 * ('placeholder' → "No email"), an invitee has an email but has never signed
 * in ('invited'), everyone else null. One definition for the People pane.
 */
export function personStatus(person: Pick<Person, 'email' | 'pending'>): 'placeholder' | 'invited' | null {
  if (person.email === null) return 'placeholder';
  return person.pending ? 'invited' : null;
}

/** First word of the name ("Ana Maria" → "Ana"); with no name, the email's local part (compact chips). */
export function personFirstName(person: Pick<Person, 'email' | 'name'>): string {
  const name = person.name?.trim();
  if (name) return name.split(/\s+/)[0];
  return person.email ? person.email.split('@')[0] : t('people.unnamed');
}

/**
 * THE adapter from a budget member to `<Avatar person>` — screens never
 * hand-assemble this shape.
 */
export function toAvatarPerson(person: Pick<Person, 'user_id' | 'email' | 'name' | 'avatar'>): AvatarPerson {
  return { id: person.user_id, avatar: person.avatar, name: personLabel(person), email: person.email };
}

/**
 * Overlay the signed-in user's own live profile (name + look, from the profile
 * module's cache) onto their members row. The members list is cached by
 * RTK Query in the budget api; editing the profile only updates the profile
 * cache, so without this overlay every avatar of "me" in Budget would stay
 * stale until the members list refetched.
 */
export function withMyProfile<P extends Pick<Person, 'is_me' | 'name' | 'avatar'>>(
  people: readonly P[],
  me: { name: string | null; avatar: PersonAvatar } | undefined,
): P[] {
  if (!me) return [...people];
  return people.map((p) => (p.is_me ? { ...p, name: me.name, avatar: me.avatar } : p));
}

/** Longest display name the server accepts (mirrors the members contract). */
const PERSON_NAME_MAX = 80;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteCheck =
  | { ok: true; email: string | undefined; name: string | undefined }
  | { ok: false; error: string };

/**
 * Validate the "add a person" form before sending (the server re-checks).
 * Either an email (plausible, not already a member; name optional) or, with no
 * email, a name — a placeholder person to link an email to later. The email is
 * normalized the way the server does (trimmed, lowercased).
 */
export function checkInvite(rawEmail: string, rawName: string, people: readonly Person[]): InviteCheck {
  const email = rawEmail.trim().toLowerCase();
  const name = rawName.trim();
  if (name.length > PERSON_NAME_MAX) return { ok: false, error: t('invite.nameTooLong', { max: PERSON_NAME_MAX }) };
  if (!email) {
    if (!name) return { ok: false, error: t('invite.nameRequired') };
    return { ok: true, email: undefined, name };
  }
  if (!EMAIL_SHAPE.test(email) || email.length > 254) return { ok: false, error: t('invite.emailInvalid') };
  const existing = people.find((p) => p.email?.toLowerCase() === email);
  if (existing) return { ok: false, error: t('invite.alreadyMember', { name: personLabel(existing) }) };
  return { ok: true, email, name: name || undefined };
}

/** Validate the "Link email" form for a placeholder (same email rules, no name). */
export function checkLinkEmail(rawEmail: string): { ok: true; email: string } | { ok: false; error: string } {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { ok: false, error: t('invite.emailRequired') };
  if (!EMAIL_SHAPE.test(email) || email.length > 254) return { ok: false, error: t('invite.emailInvalid') };
  return { ok: true, email };
}

/** Resolve an account's `userId` against the member list (null/unknown → null = Shared). */
export function personFor<P extends Pick<Person, 'user_id'>>(
  people: readonly P[],
  userId: string | null,
): P | null {
  if (userId === null) return null;
  return people.find((p) => p.user_id === userId) ?? null;
}

// ---------------------------------------------------------------------------
// Budget-wide "by person" filter
// ---------------------------------------------------------------------------

/**
 * Which slice of the budget the screens show (one selection shared by Plan,
 * Reflect and Spending). A plain string so it serializes in
 * Redux: 'all' (household, no filtering), 'shared' (accounts with no person),
 * or a member's user id. Ids are uuids, so they never collide with the two
 * reserved words.
 */
export type PersonFilter = string;

export const PERSON_ALL = 'all';
export const PERSON_SHARED = 'shared';

/** category id -> month -> activity cents (the engine's `recomputeActivity` shape). */
export type ActivityMap = Record<string, Record<MonthKey, Cents>>;

/** Whether an account belongs to the selected person ('all' matches everything). */
export function accountMatchesPerson(account: Pick<Account, 'userId'>, person: PersonFilter): boolean {
  if (person === PERSON_ALL) return true;
  if (person === PERSON_SHARED) return account.userId === null;
  return account.userId === person;
}

/** Transactions that sit on the selected person's accounts ('all' returns every one). */
export function transactionsForPerson(budget: Budget, person: PersonFilter): Transaction[] {
  if (person === PERSON_ALL) return budget.transactions;
  const accountIds = new Set(
    budget.accounts.filter((a) => accountMatchesPerson(a, person)).map((a) => a.id),
  );
  return budget.transactions.filter((t) => accountIds.has(t.accountId));
}

/**
 * The budget narrowed to one person's ACCOUNTS: their accounts and the
 * transactions on them. Categories, months and everything else stay whole (a
 * category total is then "what this person's accounts spent"). 'all' returns
 * the same object, so Everyone is exactly the unfiltered screen. Reflect and
 * Spending compute from this one definition.
 */
export function budgetForPerson(budget: Budget, person: PersonFilter): Budget {
  if (person === PERSON_ALL) return budget;
  return {
    ...budget,
    accounts: budget.accounts.filter((a) => accountMatchesPerson(a, person)),
    transactions: transactionsForPerson(budget, person),
  };
}

/** Scope label for account-based figures: null for Everyone, "Shared accounts" or "<First>’s accounts". */
export function personAccountsLabel(people: readonly Person[], person: PersonFilter): string | null {
  if (person === PERSON_ALL) return null;
  const found = personFor(people, person);
  if (person === PERSON_SHARED || !found) return t('people.sharedAccounts');
  return t('people.accountsOf', { name: personFirstName(found) });
}

/**
 * Per-category activity attributable to one person, derived with the engine's
 * own `recomputeActivity` over just their transactions. `null` for 'all' —
 * callers then fall back to the category's own (household) activity. Only
 * Activity is attributable; Assigned/Available/RTA stay household values.
 */
export function personActivity(budget: Budget, person: PersonFilter): ActivityMap | null {
  if (person === PERSON_ALL) return null;
  return recomputeActivity({ ...budget, transactions: transactionsForPerson(budget, person) });
}

/**
 * A category's activity in the engine's month under the selected person (`map`
 * null = household, straight from the engine). Payment categories have no
 * per-person split, so they always show the household figure.
 */
export function activityFor(bm: BudgetMonth, categoryId: string, map: ActivityMap | null): Cents {
  const figures = categoryFigures(bm, categoryId);
  if (!map || figures.kind === 'payment') return figures.activity;
  return map[categoryId]?.[bm.month] ?? 0;
}

/** Sum of `activityFor` across categories (group row / month totals). */
export function sumActivityFor(bm: BudgetMonth, categories: readonly Pick<Category, 'id'>[], map: ActivityMap | null): Cents {
  return categories.reduce((sum, c) => sum + activityFor(bm, c.id, map), 0);
}

// ---------------------------------------------------------------------------
// Category ownership (Plan rows)
// ---------------------------------------------------------------------------

/** The member who owns a category (null/absent = Shared). */
export function categoryOwnerId(category: Pick<Category, 'userId'>): string | null {
  return category.userId ?? null;
}

/**
 * Categories the Plan shows for the selection. Everyone: all. Shared: only
 * Shared ones. A member: the ones they own PLUS the Shared ones (a household
 * envelope is still part of their plan; the grid dims it, see
 * `isSharedInPersonView`). Order is preserved.
 */
export function categoriesForPerson<C extends Pick<Category, 'userId'>>(
  categories: readonly C[],
  person: PersonFilter,
): C[] {
  if (person === PERSON_ALL) return [...categories];
  if (person === PERSON_SHARED) return categories.filter((c) => categoryOwnerId(c) === null);
  return categories.filter((c) => {
    const owner = categoryOwnerId(c);
    return owner === null || owner === person;
  });
}

/** True for a Shared category listed under a member's view (rendered secondary). */
export function isSharedInPersonView(category: Pick<Category, 'userId'>, person: PersonFilter): boolean {
  return person !== PERSON_ALL && person !== PERSON_SHARED && categoryOwnerId(category) === null;
}

/** A member is selected but owns no category yet (drives the "assign one" hint). */
export function memberOwnsNoCategories(categories: readonly Pick<Category, 'userId'>[], person: PersonFilter): boolean {
  if (person === PERSON_ALL || person === PERSON_SHARED) return false;
  return !categories.some((c) => categoryOwnerId(c) === person);
}

/** Distinct owners (first-appearance order) among categories; Shared is not an owner. */
export function distinctOwners(categories: readonly Pick<Category, 'userId'>[]): string[] {
  const seen: string[] = [];
  for (const c of categories) {
    const owner = categoryOwnerId(c);
    if (owner !== null && !seen.includes(owner)) seen.push(owner);
  }
  return seen;
}

/** Whether anything in the budget already carries a person (accounts or categories). */
export function anyPersonAssigned(
  accounts: readonly Pick<Account, 'userId'>[],
  categories: readonly Pick<Category, 'userId'>[],
): boolean {
  return accounts.some((a) => a.userId !== null) || categories.some((c) => categoryOwnerId(c) !== null);
}

/**
 * Whether the Plan's person row shows: someone besides the viewer is in the
 * budget, or a person is already assigned somewhere. A solo budget with
 * nothing assigned gets the "add people" prompt instead.
 */
export function showPersonRow(
  people: readonly Pick<Person, 'is_me'>[],
  accounts: readonly Pick<Account, 'userId'>[],
  categories: readonly Pick<Category, 'userId'>[],
): boolean {
  return people.some((p) => !p.is_me) || anyPersonAssigned(accounts, categories);
}

export interface MonthTotals {
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

/**
 * Month summary under the selection, from the engine's unified figures
 * (payment categories included). Assigned/Available sum the categories the
 * Plan shows for it (`categoriesForPerson`); Activity is the person's own
 * (their accounts' transactions, via `map`; household when `map` is null).
 */
export function monthTotalsForPerson(
  bm: BudgetMonth,
  categories: readonly Category[],
  person: PersonFilter,
  map: ActivityMap | null,
): MonthTotals {
  const visible = categoriesForPerson(categories, person);
  const { assigned, available } = sumFigures(bm, visible.map((c) => c.id));
  return { assigned, available, activity: sumActivityFor(bm, categories, map) };
}

/** Group header roll-up over the categories the Plan shows (not the whole group). */
export function rollupForPerson(
  bm: BudgetMonth,
  categories: readonly Category[],
  person: PersonFilter,
  map: ActivityMap | null,
): MonthTotals {
  return monthTotalsForPerson(bm, categoriesForPerson(categories, person), PERSON_ALL, map);
}

/** Summary-card scope label: null for Everyone, "Shared categories", or "<First>'s categories". */
export function personFilterScopeLabel(people: readonly Person[], person: PersonFilter): string | null {
  if (person === PERSON_ALL) return null;
  const found = personFor(people, person);
  if (person === PERSON_SHARED || !found) return t('people.sharedCategories');
  return t('people.categoriesOf', { name: personFirstName(found) });
}

/** Display label of the selection: null for 'all', Shared, the member's label, or 'Former member'. */
export function personFilterLabel(people: readonly Person[], person: PersonFilter): string | null {
  if (person === PERSON_ALL) return null;
  if (person === PERSON_SHARED) return sharedLabel();
  const found = personFor(people, person);
  return found ? personLabel(found) : t('people.formerMember');
}
