/**
 * Pure view logic of the home page: which budgets go in which section, what
 * a budget card says and offers, and what the page shows while the list is
 * loading, failed or empty. Reads the GET /budgets wire row (BudgetListRow),
 * so it lives beside the screen rather than in domain/.
 */
import type { BudgetListRow } from '@/budget/data/rows';

import { t } from './i18n';

type Row = Pick<BudgetListRow, 'id' | 'name' | 'archived_at' | 'is_owner' | 'owner' | 'member_count'>;

export interface HomeSections<T> {
  /** Budgets the person owns ("My budgets"). */
  mine: T[];
  /** Budgets someone else owns and shared with them ("Shared with me"). */
  shared: T[];
  /** Archived budgets, owned or shared: kept apart, as the budget switcher always did, and still openable. */
  archived: T[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/** Split the list into the page's sections, each sorted by name. */
export function homeSections<T extends Pick<Row, 'name' | 'archived_at' | 'is_owner'>>(
  rows: readonly T[] | undefined,
): HomeSections<T> {
  const all = [...(rows ?? [])].sort(byName);
  const live = all.filter((b) => !b.archived_at);
  return {
    mine: live.filter((b) => b.is_owner),
    shared: live.filter((b) => !b.is_owner),
    archived: all.filter((b) => b.archived_at),
  };
}

export type HomeView = 'loading' | 'error' | 'empty' | 'list';

/**
 * What the page shows. A list that fails after it was loaded once keeps
 * showing; zero budgets is its own first-run state, never a spinner.
 */
export function homeView(q: { data: readonly unknown[] | undefined; isError: boolean }): HomeView {
  if (q.data === undefined) return q.isError ? 'error' : 'loading';
  return q.data.length === 0 ? 'empty' : 'list';
}

/** "Only you" for a budget nobody else is on, else the head count (owner included). */
export function peopleLabel(memberCount: number): string {
  return memberCount <= 1 ? t('caption.onlyYou') : t('caption.people', { count: memberCount });
}

/** Who shared a budget: the owner's name, else their email; a legacy budget nobody claimed has no owner. */
export function sharedByLabel(owner: Row['owner']): string {
  const who = owner?.name?.trim() || owner?.email || null;
  return who ? t('caption.sharedBy', { name: who }) : t('caption.sharedWithYou');
}

/** The lines under a card's name: the people on it, preceded on a shared budget by who shared it. */
export function budgetCardCaption(b: Pick<Row, 'is_owner' | 'owner' | 'member_count'>): string[] {
  return b.is_owner ? [peopleLabel(b.member_count)] : [sharedByLabel(b.owner), t('caption.people', { count: b.member_count })];
}

/** Extra caption line of an archived budget (`archived_at` is a timestamp; the formatter takes a date). */
export function archivedNote(archivedAt: string | null | undefined, formatDate: (iso: string) => string): string | undefined {
  return archivedAt ? t('card.archivedOn', { date: formatDate(archivedAt.slice(0, 10)) }) : undefined;
}

export interface BudgetCardActions {
  /**
   * Label of the button that opens the people on the budget, or null for no
   * button. Any member may add a person (the API's rule); the owner's reads
   * "Invite" because sharing is theirs to start. Archived budgets get none.
   */
  people: 'Invite' | 'People' | null;
}

export function budgetCardActions(b: Pick<Row, 'archived_at' | 'is_owner'>): BudgetCardActions {
  if (b.archived_at) return { people: null };
  // eslint-disable-next-line budget-i18n/no-untranslated-string -- discriminator compared in BudgetCard, which renders it through t()
  return { people: b.is_owner ? 'Invite' : 'People' };
}

export const NAME_MAX = 80;

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** The new budget's name, checked before sending. */
export function checkBudgetName(raw: string): NameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, error: t('create.nameRequired') };
  if (name.length > NAME_MAX) return { ok: false, error: t('create.nameTooLong', { max: NAME_MAX }) };
  return { ok: true, name };
}

/** Headline: the first name when the profile has one. */
export function homeGreeting(me: { name: string | null } | undefined, view: HomeView): string {
  const first = me?.name?.trim().split(/\s+/)[0];
  if (view === 'empty') return first ? t('greeting.welcomeName', { name: first }) : t('greeting.welcome');
  return t('greeting.budgets');
}

/** First run: what there is to do, in two sentences that are true today. */
export function emptyBody(): string {
  return t('empty.body');
}

/**
 * Where a budget opens. The phone lands on its Overview tab; wider windows
 * on Plan (their rail has no Overview entry).
 */
export function budgetEntryRoute(isPhone: boolean): '/overview' | '/plan' {
  return isPhone ? '/overview' : '/plan';
}
