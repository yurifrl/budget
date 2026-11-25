/**
 * Pure rules of the Renaming card of Manage Payees: the editor reducer (one
 * draft per rule row, a "new rule" row, per-row saving and error state), what
 * a commit sends, the "Apply to past transactions" summary lines, and the
 * conversion of an old "treat as transfer" rule into a renaming rule.
 * Wire-typed (PayeeAdminRow), so it lives beside the screen.
 */

import { labels } from '@shared/i18n';
import { MIN_RULE_PATTERN_LENGTH, ruleMatchTypes, type RuleMatchType } from '@shared/domain/payees';
import { transferPayeeName } from '@shared/domain/transfers';

import type { RenameRulePreview, RenameRuleRevertResult, RenameRuleRow } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { displaySystemName, matchesSystemName } from '@/domain/systemNames';
import type { Account, Transaction } from '@/domain/types';
import { t } from './i18n';

/** Display labels of the four match types in the active language. */
export const RULE_MATCH_LABEL: Record<RuleMatchType, string> = labels(t, {
  is: 'rule.is',
  starts_with: 'rule.startsWith',
  ends_with: 'rule.endsWith',
  contains: 'rule.contains',
});

/** Picker order of the match types. */
export const RULE_MATCH_ORDER: readonly RuleMatchType[] = ['is', 'starts_with', 'ends_with', 'contains'];

/** The type typed into the matcher, when it is exactly one of the labels (active language or English). */
export function ruleMatchFromLabel(text: string): RuleMatchType | undefined {
  const typed = text.trim().toLowerCase();
  return ruleMatchTypes.find(
    (m) => RULE_MATCH_LABEL[m].toLowerCase() === typed || m.replace('_', ' ') === typed,
  );
}

// --- editor state -----------------------------------------------------------

/** The editable fields of one rule row. */
export interface RuleFields {
  matchType: RuleMatchType;
  condition: string;
}

/** A stored rule, as the payee row lists it. */
export interface SavedRule {
  id: string;
  match_type: RuleMatchType;
  condition: string;
}

/** Key of the row for a rule that is not stored yet (at most one at a time). */
export const NEW_KEY = 'new';

export interface EditorState {
  /** Unsaved edits by rule id (or NEW_KEY). A key without a draft shows the stored rule. */
  drafts: Record<string, RuleFields>;
  /** Rows with a request in flight: a second commit of the same row is ignored. */
  saving: Record<string, true>;
  /** The last failure of a row, already translated. */
  errors: Record<string, string>;
}

export const EMPTY_EDITOR: EditorState = { drafts: {}, saving: {}, errors: {} };

export type EditorAction =
  | { type: 'edit'; key: string; base: RuleFields; patch: Partial<RuleFields> }
  | { type: 'openNew' }
  | { type: 'saving'; key: string }
  | { type: 'saved'; key: string }
  | { type: 'failed'; key: string; message: string }
  | { type: 'drop'; key: string }
  | { type: 'reset' };

const without = <V>(map: Record<string, V>, key: string): Record<string, V> => {
  const { [key]: _gone, ...rest } = map;
  return rest;
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'edit':
      return {
        ...state,
        drafts: { ...state.drafts, [action.key]: { ...(state.drafts[action.key] ?? action.base), ...action.patch } },
        errors: without(state.errors, action.key),
      };
    case 'openNew':
      return state.drafts[NEW_KEY]
        ? state
        : { ...state, drafts: { ...state.drafts, [NEW_KEY]: { matchType: 'contains', condition: '' } } };
    case 'saving':
      return { ...state, saving: { ...state.saving, [action.key]: true }, errors: without(state.errors, action.key) };
    case 'saved':
    case 'drop':
      return {
        drafts: without(state.drafts, action.key),
        saving: without(state.saving, action.key),
        errors: without(state.errors, action.key),
      };
    case 'failed':
      return { ...state, saving: without(state.saving, action.key), errors: { ...state.errors, [action.key]: action.message } };
    case 'reset':
      return EMPTY_EDITOR;
  }
}

export interface EditorRow {
  key: string;
  /** The stored rule's id; null for the new row. */
  ruleId: string | null;
  fields: RuleFields;
  /** The fields differ from the stored rule (always true for the new row). */
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

/** The rows to render: the stored rules (oldest first, as listed) with their drafts overlaid, then the new row when open. */
export function editorRows(rules: readonly SavedRule[], state: EditorState): EditorRow[] {
  const row = (key: string, ruleId: string | null, saved: RuleFields): EditorRow => {
    const fields = state.drafts[key] ?? saved;
    return {
      key,
      ruleId,
      fields,
      dirty: ruleId === null || fields.matchType !== saved.matchType || fields.condition.trim() !== saved.condition,
      saving: !!state.saving[key],
      error: state.errors[key] ?? null,
    };
  };
  const rows = rules.map((r) => row(r.id, r.id, { matchType: r.match_type, condition: r.condition }));
  if (state.drafts[NEW_KEY]) rows.push(row(NEW_KEY, null, state.drafts[NEW_KEY]));
  return rows;
}

export type CommitPlan =
  | { kind: 'none' }
  | { kind: 'add'; rule: { match_type: RuleMatchType; condition: string } }
  | { kind: 'update'; ruleId: string; rule: { match_type: RuleMatchType; condition: string } };

/**
 * What committing a row sends. The condition is trimmed. Nothing is sent when
 * the row has no draft, the condition is empty (an emptied stored rule is not
 * removed by accident: the row goes back to the stored rule; a new row is just
 * dropped) or nothing changed.
 */
export function planCommit(rule: SavedRule | null, draft: RuleFields | undefined): CommitPlan {
  if (!draft) return { kind: 'none' };
  const condition = draft.condition.trim();
  if (condition === '') return { kind: 'none' };
  const next = { match_type: draft.matchType, condition };
  if (!rule) return { kind: 'add', rule: next };
  if (rule.match_type === next.match_type && rule.condition === condition) return { kind: 'none' };
  return { kind: 'update', ruleId: rule.id, rule: next };
}

// --- apply to past transactions ---------------------------------------------

type Skipped = RenameRulePreview['skipped'];

const SKIPPED_ORDER = ['edited', 'transfer', 'reconciled', 'bank_rules', 'unknown_text'] as const;

/** The reasons a matching row is left alone, with their counts; zero counts are left out. */
export function skippedLines(skipped: Skipped): string[] {
  const lines: string[] = [];
  for (const reason of SKIPPED_ORDER) {
    const count = skipped[reason];
    if (count <= 0) continue;
    switch (reason) {
      case 'edited':
        lines.push(t('apply.skipped.edited', { count }));
        break;
      case 'transfer':
        lines.push(t('apply.skipped.transfer', { count }));
        break;
      case 'reconciled':
        lines.push(t('apply.skipped.reconciled', { count }));
        break;
      case 'bank_rules':
        lines.push(t('apply.skipped.bankRules', { count }));
        break;
      case 'unknown_text':
        lines.push(t('apply.skipped.unknownText', { count }));
        break;
    }
  }
  return lines;
}

/** The toast after an apply. */
export function appliedMessage(changed: number): string {
  return changed > 0 ? t('apply.done', { count: changed }) : t('apply.doneNone');
}

/** The toast after an undo: rows put back, and the rows left as they are. */
export function revertedMessage(result: RenameRuleRevertResult): string {
  const left = result.skipped.length;
  if (result.skipped.some((s) => s.reason === 'already_reverted')) return t('apply.undone.already');
  return left > 0
    ? t('apply.undone.partial', { count: result.reverted, left })
    : t('apply.undone', { count: result.reverted });
}

// --- list groups --------------------------------------------------------------

/** Name shown for a transfer payee: "Transfer : <the account's current name>". */
export function transferPayeeLabel(p: Pick<PayeeAdminRow, 'name' | 'transfer_account_name'>): string {
  return displaySystemName(p.transfer_account_name ? transferPayeeName(p.transfer_account_name) : p.name);
}

export interface PayeeGroups {
  /** Ordinary payees, in the order the server lists them. */
  payees: PayeeAdminRow[];
  /** Transfer payees: accounts that are open first, closed ones last; each part by account name. */
  transfers: PayeeAdminRow[];
}

/** The ids of the accounts that are closed. */
export function closedAccountIds(accounts: readonly Pick<Account, 'id' | 'group'>[]): Set<string> {
  return new Set(accounts.filter((a) => a.group === 'CLOSED').map((a) => a.id));
}

/** Split the list into the two groups, filtered by the search text (matches the stored and the displayed name). */
export function groupPayees(all: readonly PayeeAdminRow[], search: string, closed: ReadonlySet<string>): PayeeGroups {
  const q = search.trim().toLowerCase();
  const payees: PayeeAdminRow[] = [];
  const transfers: PayeeAdminRow[] = [];
  for (const p of all) {
    if (p.deleted) continue;
    if (p.transfer_account_id === null) {
      if (!q || matchesSystemName(p.name, q)) payees.push(p);
    } else if (!q || matchesSystemName(p.name, q) || transferPayeeLabel(p).toLowerCase().includes(q)) {
      transfers.push(p);
    }
  }
  const isClosed = (p: PayeeAdminRow) => (p.transfer_account_id !== null && closed.has(p.transfer_account_id) ? 1 : 0);
  transfers.sort((a, b) => isClosed(a) - isClosed(b) || transferPayeeLabel(a).localeCompare(transferPayeeLabel(b)));
  return { payees, transfers };
}

// --- old "treat as transfer" rule -> renaming rule -----------------------------

/**
 * Whether the payee still carries an old "treat as transfer" rule that has to
 * be turned into a renaming rule on an account's transfer payee: "auto" (the
 * account decided per row) and "account" (a fixed one). "never" stays as the
 * "Never a transfer" choice.
 */
export function hasLegacyTransferRule(p: Pick<PayeeAdminRow, 'transfer_rule' | 'transfer_account_id'>): boolean {
  return p.transfer_account_id === null && (p.transfer_rule === 'auto' || p.transfer_rule === 'account');
}

/**
 * Transfer payees an old rule can be converted onto: the payees of OPEN,
 * ON-BUDGET accounts (the old rule refused off-budget ones; closed ones take
 * no new rows). By account name.
 */
export function conversionTargets(
  all: readonly PayeeAdminRow[],
  accounts: readonly Pick<Account, 'id' | 'group' | 'onBudget'>[],
): PayeeAdminRow[] {
  const open = new Set(accounts.filter((a) => a.onBudget && a.group !== 'CLOSED').map((a) => a.id));
  return groupPayees(all, '', new Set())
    .transfers.filter((p) => p.transfer_account_id !== null && open.has(p.transfer_account_id))
    .sort((x, y) => transferPayeeLabel(x).localeCompare(transferPayeeLabel(y)));
}

/** The transfer payee of the account an "account" rule pointed at; null for "auto" or an account that is gone. */
export function defaultConversionTarget(
  p: Pick<PayeeAdminRow, 'transfer_rule' | 'transfer_rule_account_id'>,
  targets: readonly PayeeAdminRow[],
): PayeeAdminRow | null {
  if (p.transfer_rule !== 'account' || !p.transfer_rule_account_id) return null;
  return targets.find((x) => x.transfer_account_id === p.transfer_rule_account_id) ?? null;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * One rule the conversion will create on the chosen account's transfer payee.
 * `moveFrom` is the id of a renaming rule of the converted payee itself that
 * is MOVED (a rule belongs to one payee, so it is removed there and added on
 * the transfer payee); null for a new rule.
 */
export interface ConversionEntry {
  key: string;
  matchType: RuleMatchType;
  text: string;
  moveFrom: string | null;
}

/**
 * What a conversion starts with, shown to the person before Convert: every
 * renaming rule the payee has (bank text that reaches the payee through them
 * keeps counting as a transfer candidate), plus "is <payee name>" (rows whose
 * payee is already this payee, however the text got there) unless one of the
 * rules already is exactly that. Nothing is created until Convert.
 */
export function conversionEntries(payee: Pick<PayeeAdminRow, 'name' | 'rename_rules'>): ConversionEntry[] {
  const own: ConversionEntry[] = (payee.rename_rules ?? []).map((r) => ({
    key: `rule:${r.id}`,
    matchType: r.match_type,
    text: r.condition,
    moveFrom: r.id,
  }));
  const hasName = own.some((e) => e.matchType === 'is' && norm(e.text) === norm(payee.name));
  return hasName ? own : [{ key: 'name', matchType: 'is', text: payee.name.trim(), moveFrom: null }, ...own];
}

export interface ConversionPlan {
  /** The rules to create, trimmed, in order, without duplicates. */
  rules: (ConversionEntry & { text: string })[];
  /** Keys of entries a "contains / starts with / ends with" rule of fewer than the minimum characters. */
  tooShort: string[];
}

/** The entries as they will be sent: blank ones dropped, duplicates merged, loose short patterns flagged. */
export function conversionPlan(entries: readonly ConversionEntry[]): ConversionPlan {
  const seen = new Set<string>();
  const rules: ConversionPlan['rules'] = [];
  const tooShort: string[] = [];
  for (const e of entries) {
    const text = e.text.trim();
    if (text === '') continue;
    const id = `${e.matchType}\u0000${norm(text)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (e.matchType !== 'is' && text.length < MIN_RULE_PATTERN_LENGTH) tooShort.push(e.key);
    rules.push({ ...e, text });
  }
  return { rules, tooShort };
}

/** True when the transfer payee already holds that exact rule (a conversion that stopped half-way). */
export function targetHasRule(target: Pick<PayeeAdminRow, 'rename_rules'>, rule: { matchType: RuleMatchType; text: string }): boolean {
  return (target.rename_rules ?? []).some((r) => r.match_type === rule.matchType && norm(r.condition) === norm(rule.text));
}

/** How many of the payee's transactions are held as transfers waiting for their other side (they need a category or a link once the old rule is off). */
export function waitingCount(transactions: readonly Pick<Transaction, 'payeeId' | 'transferPending'>[], payeeId: string): number {
  return transactions.filter((t) => t.payeeId === payeeId && t.transferPending === 'waiting').length;
}

// --- keeping the payee list in step with a saved rule ----------------------------

/** The list with `rule` added to its payee (or replacing the rule of that id). */
export function withRule(list: readonly PayeeAdminRow[], rule: RenameRuleRow): PayeeAdminRow[] {
  return list.map((p) => {
    if (p.id !== rule.payee_id) return p;
    const rules = p.rename_rules ?? [];
    const next = rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
    return { ...p, rename_rules: next };
  });
}

/** The list without one rule of one payee. */
export function withoutRule(list: readonly PayeeAdminRow[], payeeId: string, ruleId: string): PayeeAdminRow[] {
  return list.map((p) => (p.id === payeeId ? { ...p, rename_rules: (p.rename_rules ?? []).filter((r) => r.id !== ruleId) } : p));
}
