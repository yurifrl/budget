import { describe, expect, it } from 'bun:test';

import { MONEY_MASK_TEXT, formatDateWith } from '@/domain/format';
import { DEFAULT_FMT_PREFS } from '@/domain/fmtPrefs';
import {
  archivedBudgetLabel,
  canManageBudget,
  deleteBudgetNote,
  fmtPreviewText,
  freshStartHint,
  isDeleteArmed,
  manageBudgetHint,
  ownerOnlyHint,
  splitBudgets,
} from './settings.logic';

const fmtDate = (iso: string) => formatDateWith(DEFAULT_FMT_PREFS, iso);

describe('owner-only actions', () => {
  it('only the owner manages the budget; unknown counts as not the owner', () => {
    expect(canManageBudget({ is_owner: true })).toBe(true);
    expect(canManageBudget({ is_owner: false })).toBe(false);
    expect(canManageBudget(undefined)).toBe(false);
    expect(canManageBudget(null)).toBe(false);
  });

  it('the hint names the owner when known', () => {
    expect(ownerOnlyHint({ name: ' Ana ', email: 'ana@x.test' })).toBe('Only the owner (Ana) can rename, archive or delete this budget.');
    expect(ownerOnlyHint({ name: null, email: 'ana@x.test' })).toContain('(ana@x.test)');
    expect(ownerOnlyHint(null)).toBe('Only the owner can rename, archive or delete this budget.');
  });
});

describe('splitBudgets', () => {
  const rows = [
    { id: 'a', name: 'Home', archived_at: null },
    { id: 'b', name: 'Old', archived_at: '2026-01-02T03:04:05.000Z' },
    { id: 'c', name: 'Work' },
    { id: 'd', name: 'Older', archived_at: '2025-01-02T03:04:05.000Z' },
    { id: 'e', name: 'Empty stamp', archived_at: '' },
  ];
  it('splits by archived_at, keeping list order in both halves', () => {
    const { active, archived } = splitBudgets(rows);
    expect(active.map((b) => b.id)).toEqual(['a', 'c', 'e']);
    expect(archived.map((b) => b.id)).toEqual(['b', 'd']);
  });
  it('null, missing and empty archived_at all count as active', () => {
    expect(splitBudgets(rows).active.map((b) => b.name)).toEqual(['Home', 'Work', 'Empty stamp']);
  });
  it('an unloaded list is two empty lists', () => {
    expect(splitBudgets(undefined)).toEqual({ active: [], archived: [] });
    expect(splitBudgets([])).toEqual({ active: [], archived: [] });
  });
});

describe('archivedBudgetLabel', () => {
  it('appends the formatted archive date', () => {
    const b = { name: 'Old', archived_at: '2026-01-02' };
    expect(archivedBudgetLabel(b, fmtDate)).toBe(`Old · ${fmtDate('2026-01-02')}`);
    expect(archivedBudgetLabel(b, fmtDate)).toBe('Old · 02/01/2026');
    // The API sends a timestamp.
    expect(archivedBudgetLabel({ name: 'Old', archived_at: '2026-11-18T22:03:58.457Z' }, fmtDate)).toBe('Old · 18/11/2026');
  });
  it('is the bare name without an archive date', () => {
    expect(archivedBudgetLabel({ name: 'Home', archived_at: null }, fmtDate)).toBe('Home');
    expect(archivedBudgetLabel({ name: 'Home' }, fmtDate)).toBe('Home');
  });
});

describe('freshStartHint', () => {
  it('names the current budget twice', () => {
    expect(freshStartHint({ name: 'Home' })).toBe(
      'Archives "Home" — renamed with the archive timestamp, every row kept — and starts a new "Home". Kept: accounts, linked-account balances and history through today, scheduled transactions, targets, category and payee setup. Reset: budgeted amounts, month notes, category activity. Archived budgets stay in Open Budget.',
    );
  });
  it('asks for a budget when there is none', () => {
    expect(freshStartHint(undefined)).toBe('Switch to a budget first.');
    expect(freshStartHint(null)).toBe('Switch to a budget first.');
  });
  it('a budget with an empty name still gets the explainer', () => {
    expect(freshStartHint({ name: '' }).startsWith('Archives ""')).toBe(true);
  });
});

describe('manageBudgetHint', () => {
  it('active budget: what archiving does', () => {
    expect(manageBudgetHint('Home', false)).toBe(
      'Archives "Home" — every row is kept. Archived budgets stay in Open Budget.',
    );
  });
  it('archived budget: unarchive or delete', () => {
    expect(manageBudgetHint('Home', true)).toBe(
      '"Home" is archived. Unarchive to bring it back, or delete it permanently.',
    );
  });
});

describe('deleteBudgetNote', () => {
  it('names the budget', () => {
    expect(deleteBudgetNote('Home')).toBe(
      'Deletes "Home" and every transaction, account, category and setting in it. This cannot be undone.',
    );
  });
});

describe('isDeleteArmed', () => {
  it('arms on "delete" in any case, ignoring surrounding whitespace', () => {
    expect(isDeleteArmed('delete')).toBe(true);
    expect(isDeleteArmed('  DELETE ')).toBe(true);
    expect(isDeleteArmed('Delete')).toBe(true);
  });
  it('stays disarmed otherwise', () => {
    expect(isDeleteArmed('')).toBe(false);
    expect(isDeleteArmed('delet')).toBe(false);
    expect(isDeleteArmed('delete it')).toBe(false);
    expect(isDeleteArmed('de lete')).toBe(false);
  });
});

describe('fmtPreviewText', () => {
  it('default prefs', () => {
    expect(fmtPreviewText(DEFAULT_FMT_PREFS, false)).toBe('R$\u00a01.314,51 · 30/06/2026'); // NBSP after the symbol
  });
  it('follows currency, placement, number locale and date format', () => {
    const us = fmtPreviewText(
      { currency: 'USD', currencyPlacement: 'hidden', numberLocale: 'en-US', dateFormat: 'MM/DD/YYYY' },
      false,
    );
    expect(us).toBe('1,314.51 · 06/30/2026');
  });
  it('masks the amount but not the date', () => {
    expect(fmtPreviewText(DEFAULT_FMT_PREFS, true)).toBe(`${MONEY_MASK_TEXT} · 30/06/2026`);
  });
});
