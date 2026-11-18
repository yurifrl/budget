/**
 * Pure view-model for PayeeDropdown: the sectioned option list, the keyboard
 * row model and the web portal's anchor / placement maths.
 */

import { transferPayeeName } from '@shared/domain/transfers';

import type { PayeeAdminRow } from '@/budget/data/rows';
import type { Account } from '@/domain/types';

type ItemKind = 'selected' | 'transfer' | 'payee';

export interface PayeeItem {
  kind: ItemKind;
  key: string;
  label: string;
  sub?: string;
  /** The payee string committed into the field when picked. */
  commit: string;
  checked?: boolean;
}

export interface PayeeSection {
  title: string;
  items: PayeeItem[];
}

/**
 * Sections top to bottom: "Selected" (current payee, checkmark), "Payments
 * and Transfers" (one row per other budget account) and "Saved Payees"
 * (hidden payees excluded). Typing filters the last two by substring.
 */
export function payeeSections({
  accounts,
  currentAccountId,
  payees,
  value,
}: {
  accounts: readonly Account[];
  /** Row's transaction account — its own transfer row is omitted (no self-transfer). */
  currentAccountId?: string | null;
  payees: readonly PayeeAdminRow[];
  /** The field's text. */
  value: string;
}): PayeeSection[] {
  const query = value.trim().toLowerCase();
  const trimmedValue = value.trim();
  const transferItems: PayeeItem[] = accounts
    .filter((a) => a.id !== currentAccountId)
    .map((a) => ({
      kind: 'transfer' as const,
      key: `transfer:${a.id}`,
      label: transferPayeeName(a.name),
      sub: a.group === 'CASH' ? 'Cash account' : a.group === 'CREDIT' ? 'Credit account' : 'Account',
      commit: transferPayeeName(a.name),
    }));
  const payeeItems: PayeeItem[] = payees
    .filter((p) => !p.hidden)
    .map((p) => ({
      kind: 'payee' as const,
      key: `payee:${p.id}`,
      label: p.name,
      commit: p.name,
    }));

  const matches = (s: string) => s.toLowerCase().includes(query);
  const filterItems = (list: PayeeItem[]) => (query ? list.filter((i) => matches(i.label)) : list);

  const visiblePayee = payees.find((p) => !p.hidden && p.name === trimmedValue);
  // A selected transfer (committed from Payments and Transfers, or an
  // existing "Transfer : <account>" transaction being edited) shows under
  // Selected too — including a transfer to the current account, which the
  // option list omits but the field can still hold.
  const visibleTransfer = accounts.find((a) => transferPayeeName(a.name) === trimmedValue);
  const selectedRow: PayeeItem | null = visiblePayee
    ? { kind: 'selected' as const, key: 'selected', label: visiblePayee.name, commit: visiblePayee.name, checked: true }
    : visibleTransfer
      ? {
          kind: 'selected' as const,
          key: 'selected-transfer',
          label: transferPayeeName(visibleTransfer.name),
          commit: transferPayeeName(visibleTransfer.name),
          checked: true,
        }
      : null;
  const selectedSection: PayeeSection | null = selectedRow ? { title: 'Selected', items: [selectedRow] } : null;

  const transfers = filterItems(transferItems);
  const saved = filterItems(payeeItems);
  return [
    ...(selectedSection ? [selectedSection] : []),
    ...(transfers.length ? [{ title: 'Payments and Transfers', items: transfers }] : []),
    ...(saved.length ? [{ title: 'Saved Payees', items: saved }] : []),
  ];
}

/** Keyboard row model: section rows, then the create row, then Manage Payees. */
export interface PayeeMenu {
  /** Flat pick list for keyboard highlight. */
  flatRows: PayeeItem[];
  /** "Use … as payee": a typed query matching no option label exactly. */
  showCreate: boolean;
  /** flatRows + create row (if shown) + the Manage Payees row. */
  rowCount: number;
}

export function payeeMenu(sections: readonly PayeeSection[], value: string): PayeeMenu {
  const query = value.trim().toLowerCase();
  const trimmedValue = value.trim();
  const flatRows = sections.flatMap((s) => s.items);
  const hasExactMatch =
    query.length > 0 && (flatRows.some((r) => r.label.toLowerCase() === query) || trimmedValue.length === 0);
  const showCreate = !!query && !hasExactMatch;
  // +1 create row (typed query with no exact match), +1 Manage Payees row.
  return { flatRows, showCreate, rowCount: flatRows.length + (showCreate ? 1 : 0) + 1 };
}

/** ArrowDown / ArrowUp: move the highlight, clamped to the rows. */
export function highlightAfterKey(highlight: number, key: 'ArrowDown' | 'ArrowUp', rowCount: number): number {
  return key === 'ArrowDown' ? Math.min(highlight + 1, rowCount - 1) : Math.max(highlight - 1, 0);
}

/**
 * Enter picks the highlighted row (mirrors the core Combobox): a section
 * item, the create row just below them, else Manage Payees.
 */
export function enterTarget(
  highlightedIndex: number,
  menu: Pick<PayeeMenu, 'flatRows' | 'showCreate'>,
): { kind: 'item'; item: PayeeItem } | { kind: 'create' } | { kind: 'manage' } | { kind: 'none' } {
  if (highlightedIndex < menu.flatRows.length) {
    const item = menu.flatRows[highlightedIndex];
    return item ? { kind: 'item', item } : { kind: 'none' };
  }
  if (menu.showCreate && highlightedIndex === menu.flatRows.length) return { kind: 'create' };
  return { kind: 'manage' };
}

/** Web portal anchor: document-space rect (left/top/width) of the container plus its viewport edges. */
export interface PayeeAnchor {
  left: number;
  top: number;
  width: number;
  topVp: number;
  bottomVp: number;
}

/**
 * Document coordinates: body is static in RN-web, so a body-level absolute
 * dropdown stays glued to the input across page scroll. Returns `prev` when
 * nothing moved, so a scroll/resize listener does not re-render.
 */
export function anchorFromRect(
  prev: PayeeAnchor | null,
  rect: { left: number; top: number; bottom: number; width: number },
  scrollX: number,
  scrollY: number,
): PayeeAnchor {
  const left = rect.left + scrollX;
  const top = rect.bottom + scrollY;
  return prev &&
    prev.left === left &&
    prev.top === top &&
    prev.width === rect.width &&
    prev.topVp === rect.top &&
    prev.bottomVp === rect.bottom
    ? prev
    : { left, top, width: rect.width, topVp: rect.top, bottomVp: rect.bottom };
}

/**
 * Viewport-aware portal placement: flip above the input when there's no
 * room below for a useful dropdown (short windows), and cap the height to
 * the available space so the pinned Manage Payees row stays on-screen.
 */
export function payeePortalPlacement(
  anchor: PayeeAnchor,
  viewport: { innerHeight: number; scrollY: number; /** document.documentElement.scrollHeight */ scrollHeight: number },
): { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number }) {
  const spaceBelow = viewport.innerHeight - anchor.bottomVp;
  const flipUp = spaceBelow < 200 && anchor.topVp > spaceBelow;
  const maxHeight = Math.max(160, Math.min(240, (flipUp ? anchor.topVp : spaceBelow) - 8));
  return flipUp
    ? {
        left: anchor.left,
        bottom: viewport.scrollHeight - (anchor.topVp + viewport.scrollY) + 2,
        width: Math.max(anchor.width, 260),
        maxHeight,
      }
    : { left: anchor.left, top: anchor.top, width: Math.max(anchor.width, 260), maxHeight };
}
