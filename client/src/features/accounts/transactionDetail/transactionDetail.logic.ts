/**
 * View logic of the transaction page (TransactionDetailScreen): the known
 * fields as label/value rows, timestamps, and the bank's raw payload turned
 * into a flat, indented key/value tree. Raw keys and values are data: shown
 * as received, never translated.
 */

import { todayIso, type MoneyFormat } from '@/domain/format';
import type { TransactionDetails } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';

import { t } from './i18n';

type Detail = TransactionDetails['transaction'];

/** One label/value line of a section; `mono` marks ids (selectable, monospace). */
export interface FieldRow {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}

/** Signed milliunits to the formatted amount (Hide Amounts respected). */
export function formatMilli(fmt: Pick<MoneyFormat, 'formatMoney'>, milli: number): string {
  return fmt.formatMoney(milliToCents(milli));
}

/** An ISO timestamp as the budget's date format plus local HH:MM. */
export function formatTimestamp(fmt: Pick<MoneyFormat, 'formatDate'>, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${fmt.formatDate(todayIso(at))} ${hh}:${mm}`;
}

function clearedLabel(cleared: Detail['cleared']): string {
  if (cleared === 'cleared') return t('value.cleared');
  if (cleared === 'reconciled') return t('value.reconciled');
  return t('value.uncleared');
}

function categoryLabel(txn: Detail): string {
  if (txn.subtransactions.length > 0) return t('value.split');
  return txn.category_name ?? t('value.uncategorized');
}

/**
 * The "Details" section: the register fields formatted. Optional fields
 * (memo, flag, import id, ...) appear only when set; the ids last.
 */
export function detailFields(
  txn: Detail,
  fmt: Pick<MoneyFormat, 'formatMoney' | 'formatDate'>,
  names: { payee: string; flag: string | null },
): FieldRow[] {
  const rows: (FieldRow | null)[] = [
    { key: 'date', label: t('field.date'), value: fmt.formatDate(txn.date) },
    { key: 'payee', label: t('field.payee'), value: names.payee },
    { key: 'category', label: t('field.category'), value: categoryLabel(txn) },
    { key: 'account', label: t('field.account'), value: txn.account_name },
    { key: 'amount', label: t('field.amount'), value: formatMilli(fmt, txn.amount) },
    txn.memo ? { key: 'memo', label: t('field.memo'), value: txn.memo } : null,
    { key: 'cleared', label: t('field.cleared'), value: clearedLabel(txn.cleared) },
    { key: 'approved', label: t('field.approved'), value: txn.approved ? t('value.yes') : t('value.no') },
    names.flag ? { key: 'flag', label: t('field.flag'), value: names.flag } : null,
    txn.repeat_rule_id
      ? { key: 'repeat', label: t('field.repeat'), value: txn.upcoming ? t('value.upcoming') : txn.repeat }
      : null,
    txn.matched_transaction_id
      ? { key: 'matched', label: t('field.matched'), value: txn.matched_transaction_id, mono: true }
      : null,
    txn.import_payee_name_original
      ? { key: 'importPayee', label: t('field.importPayee'), value: txn.import_payee_name_original }
      : null,
    txn.import_id ? { key: 'importId', label: t('field.importId'), value: txn.import_id, mono: true } : null,
    { key: 'id', label: t('field.id'), value: txn.id, mono: true },
  ];
  return rows.filter((r): r is FieldRow => r !== null);
}

/** One line of the raw tree. Containers carry a count; scalars a printable value. */
export interface RawLine {
  /** Path from the root (`merchant.name`, `tags[0]`); unique, used as the React key. */
  path: string;
  depth: number;
  /** Object key or `[i]` array index; null only for a scalar root. */
  key: string | null;
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** Scalars: the value as text (strings verbatim, `""` when empty). */
  value?: string;
  /** Containers: number of fields / items (0 renders as `{}` / `[]`). */
  count?: number;
}

/**
 * Every field of a JSON value, depth-first in the provider's key order:
 * objects and arrays become a header line followed by their children one
 * level deeper; null, empty strings and empty containers stay visible.
 */
export function rawLines(value: unknown): RawLine[] {
  const out: RawLine[] = [];
  // The root container has no header line: its children start at depth 0.
  const walk = (v: unknown, key: string | null, path: string, depth: number, root: boolean) => {
    const childDepth = root ? 0 : depth + 1;
    if (Array.isArray(v)) {
      if (!root) out.push({ path, depth, key, kind: 'array', count: v.length });
      v.forEach((item, i) => walk(item, `[${i}]`, `${path}[${i}]`, childDepth, false));
      return;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (!root) out.push({ path, depth, key, kind: 'object', count: entries.length });
      for (const [k, child] of entries) walk(child, k, path ? `${path}.${k}` : k, childDepth, false);
      return;
    }
    out.push({ path: path || '$', depth, key, ...scalar(v) });
  };
  walk(value, null, '', 0, true);
  return out;
}

function scalar(v: unknown): Pick<RawLine, 'kind' | 'value'> {
  if (v === null || v === undefined) return { kind: 'null', value: 'null' };
  if (typeof v === 'string') return { kind: 'string', value: v === '' ? '""' : v };
  if (typeof v === 'number') return { kind: 'number', value: String(v) };
  if (typeof v === 'boolean') return { kind: 'boolean', value: String(v) };
  return { kind: 'string', value: String(v) };
}

/** Text after a container's key: `{}` / `[]` when empty, else the localized field/item count. */
export function containerSummary(line: Pick<RawLine, 'kind' | 'count'>): string {
  const count = line.count ?? 0;
  if (line.kind === 'object') return count === 0 ? '{}' : t('raw.fields', { count });
  return count === 0 ? '[]' : t('raw.items', { count });
}

/** The payload as pretty JSON for Copy JSON. */
export function rawJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
