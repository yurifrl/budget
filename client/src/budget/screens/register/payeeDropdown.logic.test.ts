import { describe, expect, test } from 'bun:test';

import type { PayeeAdminRow } from '../../data/rows';
import type { Account } from '../../domain/types';
import {
  anchorFromRect,
  enterTarget,
  highlightAfterKey,
  payeeMenu,
  payeePortalPlacement,
  payeeSections,
} from './payeeDropdown.logic';

const accounts = [
  { id: 'a1', name: 'Checking', group: 'CASH' },
  { id: 'a2', name: 'Card', group: 'CREDIT' },
  { id: 'a3', name: 'Broker', group: 'TRACKING' },
] as unknown as Account[];
const payees = [
  { id: 'p1', name: 'Padaria', hidden: false },
  { id: 'p2', name: 'Secret', hidden: true },
  { id: 'p3', name: 'Pharmacy', hidden: false },
] as unknown as PayeeAdminRow[];
const sections = (value: string, currentAccountId: string | null = 'a1') => payeeSections({ accounts, currentAccountId, payees, value });
const titles = (value: string) => sections(value).map((s) => s.title);

describe('payeeSections', () => {
  test('empty field: transfers to every other account, then visible saved payees', () => {
    expect(sections('')).toEqual([
      {
        title: 'Payments and Transfers',
        items: [
          { kind: 'transfer', key: 'transfer:a2', label: 'Transfer : Card', sub: 'Credit account', commit: 'Transfer : Card' },
          { kind: 'transfer', key: 'transfer:a3', label: 'Transfer : Broker', sub: 'Account', commit: 'Transfer : Broker' },
        ],
      },
      {
        title: 'Saved Payees',
        items: [
          { kind: 'payee', key: 'payee:p1', label: 'Padaria', commit: 'Padaria' },
          { kind: 'payee', key: 'payee:p3', label: 'Pharmacy', commit: 'Pharmacy' },
        ],
      },
    ]);
  });
  test('cash accounts are labelled; no current account lists them all', () => {
    expect(sections('', null)[0].items.map((i) => [i.label, i.sub])).toEqual([
      ['Transfer : Checking', 'Cash account'],
      ['Transfer : Card', 'Credit account'],
      ['Transfer : Broker', 'Account'],
    ]);
  });
  test('typing filters both lists by substring, case-insensitively; empty sections vanish', () => {
    expect(sections(' pHa ')).toEqual([{ title: 'Saved Payees', items: [{ kind: 'payee', key: 'payee:p3', label: 'Pharmacy', commit: 'Pharmacy' }] }]);
    expect(titles('card')).toEqual(['Payments and Transfers']);
    expect(sections('zzz')).toEqual([]);
  });
  test('an exact visible payee shows under Selected (checked) and stays in Saved Payees', () => {
    const s = sections('Padaria');
    expect(s[0]).toEqual({ title: 'Selected', items: [{ kind: 'selected', key: 'selected', label: 'Padaria', commit: 'Padaria', checked: true }] });
    expect(s.map((x) => x.title)).toEqual(['Selected', 'Saved Payees']);
  });
  test('Selected matches the trimmed value exactly (case-sensitive); hidden payees never show', () => {
    expect(titles('padaria')).toEqual(['Saved Payees']);
    expect(sections('Secret')).toEqual([]);
  });
  test('a held transfer shows under Selected, even one to the current account', () => {
    expect(sections('Transfer : Checking')).toEqual([
      { title: 'Selected', items: [{ kind: 'selected', key: 'selected-transfer', label: 'Transfer : Checking', commit: 'Transfer : Checking', checked: true }] },
    ]);
    expect(titles('Transfer : Card')).toEqual(['Selected', 'Payments and Transfers']);
  });
});

describe('payeeMenu', () => {
  test('rows = section items (+ create row when the query matches no label exactly) + Manage Payees', () => {
    const empty = payeeMenu(sections(''), '');
    expect(empty.flatRows).toHaveLength(4);
    expect(empty).toMatchObject({ showCreate: false, rowCount: 5 });
    const partial = payeeMenu(sections('pa'), 'pa');
    expect(partial.flatRows.map((r) => r.label)).toEqual(['Padaria']);
    expect(partial).toMatchObject({ showCreate: true, rowCount: 3 });
  });
  test('an exact label match (any case) hides the create row', () => {
    expect(payeeMenu(sections('padaria'), 'padaria')).toMatchObject({ showCreate: false, rowCount: 2 });
    expect(payeeMenu(sections('Padaria'), ' Padaria ')).toMatchObject({ showCreate: false, rowCount: 3 });
  });
  test('nothing matches: only create + manage', () => {
    expect(payeeMenu(sections('zzz'), 'zzz')).toMatchObject({ flatRows: [], showCreate: true, rowCount: 2 });
  });
});

describe('keyboard', () => {
  test('ArrowDown/ArrowUp clamp to the rows', () => {
    expect(highlightAfterKey(0, 'ArrowDown', 3)).toBe(1);
    expect(highlightAfterKey(2, 'ArrowDown', 3)).toBe(2);
    expect(highlightAfterKey(1, 'ArrowUp', 3)).toBe(0);
    expect(highlightAfterKey(0, 'ArrowUp', 3)).toBe(0);
  });
  test('Enter picks the highlighted item, then the create row, then Manage Payees', () => {
    const m = payeeMenu(sections('pa'), 'pa');
    expect(enterTarget(0, m)).toEqual({ kind: 'item', item: m.flatRows[0] });
    expect(enterTarget(1, m)).toEqual({ kind: 'create' });
    expect(enterTarget(2, m)).toEqual({ kind: 'manage' });
    const noCreate = payeeMenu(sections(''), '');
    expect(enterTarget(4, noCreate)).toEqual({ kind: 'manage' });
  });
});

describe('anchorFromRect', () => {
  const rect = { left: 10, top: 100, bottom: 130, width: 200 };
  test('document coordinates below the input, plus the viewport edges', () => {
    expect(anchorFromRect(null, rect, 5, 50)).toEqual({ left: 15, top: 180, width: 200, topVp: 100, bottomVp: 130 });
  });
  test('an unchanged measurement keeps the previous object (no re-render)', () => {
    const prev = anchorFromRect(null, rect, 5, 50);
    expect(anchorFromRect(prev, rect, 5, 50)).toBe(prev);
    expect(anchorFromRect(prev, { ...rect, top: 101 }, 5, 50)).not.toBe(prev);
  });
});

describe('payeePortalPlacement', () => {
  const anchor = { left: 15, top: 180, width: 200, topVp: 100, bottomVp: 130 };
  test('below the input when there is room; at least 260 wide; height capped at 240', () => {
    expect(payeePortalPlacement(anchor, { innerHeight: 800, scrollY: 50, scrollHeight: 2000 })).toEqual({ left: 15, top: 180, width: 260, maxHeight: 240 });
    expect(payeePortalPlacement({ ...anchor, width: 400 }, { innerHeight: 800, scrollY: 0, scrollHeight: 2000 }).width).toBe(400);
  });
  test('height shrinks to the space below, never under 160', () => {
    expect(payeePortalPlacement(anchor, { innerHeight: 340, scrollY: 0, scrollHeight: 2000 }).maxHeight).toBe(202);
    expect(payeePortalPlacement({ ...anchor, topVp: 20, bottomVp: 50 }, { innerHeight: 150, scrollY: 0, scrollHeight: 2000 }).maxHeight).toBe(160);
  });
  test('flips above when under 200px remain below and there is more room above', () => {
    const low = { left: 15, top: 630, width: 200, topVp: 550, bottomVp: 580 };
    expect(payeePortalPlacement(low, { innerHeight: 700, scrollY: 50, scrollHeight: 2000 })).toEqual({
      left: 15,
      bottom: 2000 - (550 + 50) + 2,
      width: 260,
      maxHeight: 240,
    });
  });
  test('stays below when the space above is not larger', () => {
    const p = payeePortalPlacement({ ...anchor, topVp: 40, bottomVp: 70 }, { innerHeight: 200, scrollY: 0, scrollHeight: 2000 });
    expect('top' in p).toBe(true);
  });
});
