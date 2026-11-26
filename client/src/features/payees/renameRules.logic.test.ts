import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import type { RenameRuleRevertResult, RenameRuleRow } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import {
  EMPTY_EDITOR,
  NEW_KEY,
  appliedMessage,
  closedAccountIds,
  conversionEntries,
  conversionPlan,
  conversionTargets,
  defaultConversionTarget,
  editorReducer,
  editorRows,
  groupPayees,
  hasLegacyTransferRule,
  planCommit,
  revertedMessage,
  ruleMatchFromLabel,
  skippedLines,
  targetHasRule,
  waitingSummary,
  visibleEntries,
  transferPayeeLabel,
  withRule,
  withoutRule,
  type EditorState,
  type SavedRule,
} from './renameRules.logic';

afterEach(() => setLocale('en'));

const payee = (over: Partial<PayeeAdminRow> = {}): PayeeAdminRow => ({
  id: 'p1',
  name: 'Padaria',
  transfer_account_id: null,
  transfer_rule: null,
  transfer_rule_account_id: null,
  deleted: false,
  hidden: false,
  categorization_mode: 'auto',
  default_category_id: null,
  rename_match_type: null,
  rename_condition: null,
  transaction_count: 0,
  last_used_date: null,
  inferred_category_id: null,
  inferred_category_name: null,
  ...over,
});

const transfer = (id: string, account: string, accountId: string, over: Partial<PayeeAdminRow> = {}) =>
  payee({ id, name: `Transfer : ${account}`, transfer_account_id: accountId, transfer_account_name: account, ...over });

const rule = (id: string, match_type: SavedRule['match_type'], condition: string, payee_id = 'p1'): RenameRuleRow => ({
  id,
  payee_id,
  match_type,
  condition,
  created_at: '2026-11-25T00:00:00Z',
});

const run = (actions: Parameters<typeof editorReducer>[1][], from: EditorState = EMPTY_EDITOR) =>
  actions.reduce(editorReducer, from);

describe('editor reducer and rows', () => {
  const saved: SavedRule[] = [
    { id: 'r1', match_type: 'is', condition: 'UBER *TRIP' },
    { id: 'r2', match_type: 'starts_with', condition: 'PIX' },
  ];
  const base = { matchType: 'is' as const, condition: 'UBER *TRIP' };

  test('stored rules show as they are, oldest first, nothing dirty', () => {
    const rows = editorRows(saved, EMPTY_EDITOR);
    expect(rows.map((r) => [r.key, r.ruleId, r.fields.condition, r.dirty])).toEqual([
      ['r1', 'r1', 'UBER *TRIP', false],
      ['r2', 'r2', 'PIX', false],
    ]);
  });

  test('an edit overlays one row only and marks it dirty; edits keep the other fields', () => {
    const s = run([{ type: 'edit', key: 'r1', base, patch: { condition: 'UBER' } }]);
    const rows = editorRows(saved, s);
    expect(rows[0]).toMatchObject({ fields: { matchType: 'is', condition: 'UBER' }, dirty: true });
    expect(rows[1]!.dirty).toBe(false);
  });

  test('a draft equal to the stored rule (after trimming) is not dirty', () => {
    const s = run([{ type: 'edit', key: 'r1', base, patch: { condition: ' UBER *TRIP ' } }]);
    expect(editorRows(saved, s)[0]!.dirty).toBe(false);
  });

  test('the new row comes last, is always dirty, and opens once', () => {
    const s = run([{ type: 'openNew' }, { type: 'openNew' }]);
    const rows = editorRows(saved, s);
    expect(rows.map((r) => r.key)).toEqual(['r1', 'r2', NEW_KEY]);
    expect(rows[2]).toMatchObject({ ruleId: null, dirty: true, fields: { matchType: 'contains', condition: '' } });
  });

  test('saving then failing keeps the draft and shows the error; editing clears the error', () => {
    let s = run([{ type: 'openNew' }, { type: 'edit', key: NEW_KEY, base, patch: { condition: 'IFOOD' } }, { type: 'saving', key: NEW_KEY }]);
    expect(editorRows([], s)[0]!.saving).toBe(true);
    s = run([{ type: 'failed', key: NEW_KEY, message: 'exists' }], s);
    expect(editorRows([], s)[0]).toMatchObject({ saving: false, error: 'exists', fields: { condition: 'IFOOD' } });
    s = run([{ type: 'edit', key: NEW_KEY, base, patch: { condition: 'IFOOD 2' } }], s);
    expect(editorRows([], s)[0]!.error).toBeNull();
  });

  test('saved and drop remove the draft, the saving flag and the error', () => {
    const s = run([{ type: 'edit', key: 'r1', base, patch: { condition: 'x' } }, { type: 'failed', key: 'r1', message: 'no' }, { type: 'drop', key: 'r1' }]);
    expect(s).toEqual(EMPTY_EDITOR);
    expect(run([{ type: 'openNew' }, { type: 'saving', key: NEW_KEY }, { type: 'saved', key: NEW_KEY }])).toEqual(EMPTY_EDITOR);
  });
});

describe('planCommit', () => {
  const stored: SavedRule = { id: 'r1', match_type: 'is', condition: 'UBER' };

  test('no draft sends nothing', () => {
    expect(planCommit(stored, undefined)).toEqual({ kind: 'none' });
  });

  test('a new rule is added with a trimmed condition; an empty one is not', () => {
    expect(planCommit(null, { matchType: 'starts_with', condition: ' PIX ' })).toEqual({
      kind: 'add',
      rule: { match_type: 'starts_with', condition: 'PIX' },
    });
    expect(planCommit(null, { matchType: 'contains', condition: '  ' })).toEqual({ kind: 'none' });
  });

  test('a stored rule is updated when the type or the text changed, not when it did not', () => {
    expect(planCommit(stored, { matchType: 'contains', condition: 'UBER' })).toEqual({
      kind: 'update',
      ruleId: 'r1',
      rule: { match_type: 'contains', condition: 'UBER' },
    });
    expect(planCommit(stored, { matchType: 'is', condition: ' UBER ' })).toEqual({ kind: 'none' });
  });

  test('an emptied stored rule is not sent (it is removed only by the remove button)', () => {
    expect(planCommit(stored, { matchType: 'is', condition: '' })).toEqual({ kind: 'none' });
  });
});

describe('ruleMatchFromLabel', () => {
  test('adopts an exact label of the four types, any case', () => {
    expect(ruleMatchFromLabel('Starts with')).toBe('starts_with');
    expect(ruleMatchFromLabel(' ENDS WITH ')).toBe('ends_with');
    expect(ruleMatchFromLabel('is')).toBe('is');
    expect(ruleMatchFromLabel('Contains')).toBe('contains');
  });

  test('adopts the pt-BR label while pt-BR is active, and still the English one', () => {
    setLocale('pt-BR');
    expect(ruleMatchFromLabel('Começa com')).toBe('starts_with');
    expect(ruleMatchFromLabel('starts with')).toBe('starts_with');
  });

  test('anything else is not a type', () => {
    expect(ruleMatchFromLabel('Start')).toBeUndefined();
    expect(ruleMatchFromLabel('')).toBeUndefined();
  });
});

describe('apply messages', () => {
  const skipped = { edited: 2, transfer: 1, reconciled: 0, bank_rules: 0, unknown_text: 3 };

  test('skipped lines list only the reasons with rows, in a fixed order', () => {
    expect(skippedLines(skipped)).toEqual(['2 you edited', '1 already a transfer', '3 whose bank text is not known']);
    expect(skippedLines({ edited: 0, transfer: 0, reconciled: 0, bank_rules: 0, unknown_text: 0 })).toEqual([]);
  });

  test('skipped lines in pt-BR', () => {
    setLocale('pt-BR');
    expect(skippedLines({ ...skipped, edited: 1, unknown_text: 0, transfer: 0 })).toEqual(['1 que você editou']);
  });

  test('the toast after an apply', () => {
    expect(appliedMessage(1)).toBe('1 past transaction updated.');
    expect(appliedMessage(4)).toBe('4 past transactions updated.');
    expect(appliedMessage(0)).toBe('Nothing changed.');
  });

  test('the toast after an undo says what was put back and what was left', () => {
    const r = (reverted: number, skippedRows: RenameRuleRevertResult['skipped']): RenameRuleRevertResult => ({ reverted, skipped: skippedRows });
    expect(revertedMessage(r(3, []))).toBe('3 transactions put back.');
    expect(revertedMessage(r(2, [{ transaction_id: 'a', reason: 'changed_since' }]))).toBe('2 transactions put back, 1 left as it is.');
    expect(revertedMessage(r(1, [{ transaction_id: 'a', reason: 'changed_since' }]))).toBe('1 transaction put back, 1 left as it is.');
    expect(revertedMessage(r(1, [{ transaction_id: 'a', reason: 'changed_since' }, { transaction_id: 'b', reason: 'changed_since' }]))).toBe('1 transaction put back, 2 left as they are.');
    expect(revertedMessage(r(0, [{ transaction_id: 'a', reason: 'already_reverted' }]))).toBe('That change was already undone.');
  });

  test('pt-BR agrees in number on both halves', () => {
    setLocale('pt-BR');
    const sk = (n: number): RenameRuleRevertResult['skipped'] => Array.from({ length: n }, (_, i) => ({ transaction_id: `t${i}`, reason: 'changed_since' as const }));
    expect(revertedMessage({ reverted: 1, skipped: sk(1) })).toBe('1 transação restaurada, 1 mantida como está.');
    expect(revertedMessage({ reverted: 2, skipped: sk(1) })).toBe('2 transações restauradas, 1 mantida como está.');
    expect(revertedMessage({ reverted: 1, skipped: sk(3) })).toBe('1 transação restaurada, 3 mantidas como estão.');
  });
});

describe('groupPayees', () => {
  const all = [
    payee({ id: 'a', name: 'Padaria' }),
    payee({ id: 'x', name: 'Zeca', hidden: true }),
    payee({ id: 'gone', name: 'Old', deleted: true }),
    transfer('t2', 'Nubank Card', 'acc2'),
    transfer('t1', 'Itau Checking', 'acc1'),
    transfer('t3', 'Old Savings', 'acc3'),
    payee({ id: 'sb', name: 'Starting Balance' }),
  ];
  const closed = closedAccountIds([
    { id: 'acc1', group: 'CASH' },
    { id: 'acc3', group: 'CLOSED' },
  ]);

  test('two groups; deleted payees are dropped; hidden ones stay', () => {
    const g = groupPayees(all, '', closed);
    expect(g.payees.map((p) => p.id)).toEqual(['a', 'x', 'sb']);
    expect(g.transfers.map((p) => p.id)).toEqual(['t1', 't2', 't3']);
  });

  test('open accounts come first by name, closed ones last', () => {
    const g = groupPayees(all, '', new Set(['acc1']));
    expect(g.transfers.map((p) => p.id)).toEqual(['t2', 't3', 't1']);
  });

  test('search filters both groups, by the account name too', () => {
    expect(groupPayees(all, '  nubank ', closed)).toEqual({ payees: [], transfers: [all[3]!] });
    expect(groupPayees(all, 'padaria', closed).transfers).toEqual([]);
  });

  test('pt-BR search finds a system payee by its displayed or stored name', () => {
    setLocale('pt-BR');
    expect(groupPayees(all, 'saldo', closed).payees.map((p) => p.id)).toEqual(['sb']);
    expect(groupPayees(all, 'balance', closed).payees.map((p) => p.id)).toEqual(['sb']);
    expect(groupPayees(all, 'transferência : nubank', closed).transfers.map((p) => p.id)).toEqual(['t2']);
  });

  test('a transfer payee is labelled with its account current name', () => {
    expect(transferPayeeLabel(transfer('t', 'Renamed', 'acc', { name: 'Transfer : Old name' }))).toBe('Transfer : Renamed');
    setLocale('pt-BR');
    expect(transferPayeeLabel(transfer('t', 'Renamed', 'acc'))).toBe('Transferência : Renamed');
  });
});

const accts = [
  { id: 'acc1', group: 'CASH' as const, onBudget: true },
  { id: 'acc2', group: 'CASH' as const, onBudget: true },
];

describe('old "treat as transfer" rule', () => {
  test('only auto and account rules of an ordinary payee are converted; never stays', () => {
    expect(hasLegacyTransferRule(payee({ transfer_rule: 'auto' }))).toBe(true);
    expect(hasLegacyTransferRule(payee({ transfer_rule: 'account', transfer_rule_account_id: 'acc1' }))).toBe(true);
    expect(hasLegacyTransferRule(payee({ transfer_rule: 'never' }))).toBe(false);
    expect(hasLegacyTransferRule(payee({ transfer_rule: null }))).toBe(false);
    expect(hasLegacyTransferRule(transfer('t', 'X', 'acc', { transfer_rule: 'auto' }))).toBe(false);
  });

  test('an account rule starts on that account; an auto rule starts on none', () => {
    const targets = conversionTargets([transfer('t1', 'A', 'acc1'), transfer('t2', 'B', 'acc2'), payee()], accts);
    expect(defaultConversionTarget(payee({ transfer_rule: 'account', transfer_rule_account_id: 'acc2' }), targets)?.id).toBe('t2');
    expect(defaultConversionTarget(payee({ transfer_rule: 'auto' }), targets)).toBeNull();
    expect(defaultConversionTarget(payee({ transfer_rule: 'account', transfer_rule_account_id: 'gone' }), targets)).toBeNull();
  });

  test('targets are the payees of open, on-budget accounts only', () => {
    const all = [transfer('t1', 'A', 'acc1'), transfer('t2', 'B', 'acc2'), transfer('t3', 'C', 'acc3'), transfer('t4', 'D', 'acc4')];
    const accounts = [
      { id: 'acc1', group: 'CASH' as const, onBudget: true },
      { id: 'acc2', group: 'CASH' as const, onBudget: false },
      { id: 'acc3', group: 'CLOSED' as const, onBudget: true },
      { id: 'acc4', group: 'CREDIT' as const, onBudget: true },
    ];
    expect(conversionTargets(all, accounts).map((p) => p.id)).toEqual(['t1', 't4']);
    // An account rule that pointed at an off-budget account starts on nothing.
    expect(defaultConversionTarget(payee({ transfer_rule: 'account', transfer_rule_account_id: 'acc2' }), conversionTargets(all, accounts))).toBeNull();
  });
});

describe('conversion entries and plan', () => {
  test('"is <name>" first, then one entry per own renaming rule (same type and text, moved)', () => {
    const p = payee({ name: ' Uber ', rename_rules: [rule('r1', 'contains', 'UBER *TRIP'), rule('r2', 'starts_with', 'UBER EATS')] });
    expect(conversionEntries(p).map((e) => [e.matchType, e.text, e.moveFrom])).toEqual([
      ['is', 'Uber', null],
      ['contains', 'UBER *TRIP', 'r1'],
      ['starts_with', 'UBER EATS', 'r2'],
    ]);
  });

  test('an own rule that already is "is <name>" is that entry (moved, not duplicated)', () => {
    const p = payee({ name: 'Uber', rename_rules: [rule('r1', 'is', 'uber')] });
    expect(conversionEntries(p).map((e) => [e.matchType, e.text, e.moveFrom])).toEqual([['is', 'uber', 'r1']]);
  });

  test('no rules: just "is <name>"', () => {
    expect(conversionEntries(payee({ name: 'Pagamento fatura' })).map((e) => [e.matchType, e.text])).toEqual([['is', 'Pagamento fatura']]);
  });

  test('the plan trims, drops blanks and duplicates, and flags a loose pattern that is too short', () => {
    const entries = [
      { key: 'a', matchType: 'is' as const, text: ' Uber ', moveFrom: null },
      { key: 'b', matchType: 'is' as const, text: 'uber', moveFrom: 'r1' },
      { key: 'c', matchType: 'contains' as const, text: ' ', moveFrom: null },
      { key: 'd', matchType: 'contains' as const, text: 'U', moveFrom: null },
      { key: 'e', matchType: 'is' as const, text: 'U', moveFrom: null },
    ];
    const plan = conversionPlan(entries);
    expect(plan.rules.map((r) => [r.key, r.matchType, r.text])).toEqual([
      ['a', 'is', 'Uber'],
      ['d', 'contains', 'U'],
      ['e', 'is', 'U'],
    ]);
    expect(plan.tooShort).toEqual(['d']);
  });

  test('a transfer payee that already holds a rule is told apart (a conversion that stopped half-way)', () => {
    const target = transfer('t1', 'A', 'acc1', { rename_rules: [rule('r', 'contains', ' uber *trip', 't1')] });
    expect(targetHasRule(target, { matchType: 'contains', text: 'UBER *TRIP' })).toBe(true);
    expect(targetHasRule(target, { matchType: 'is', text: 'UBER *TRIP' })).toBe(false);
    expect(targetHasRule(transfer('t2', 'B', 'acc2'), { matchType: 'is', text: 'x' })).toBe(false);
  });

  test('waiting rows: how many, and how far Ready to Assign goes down (cards and off-budget accounts do not move it)', () => {
    const accounts = [
      { id: 'chk', onBudget: true, group: 'CASH' as const },
      { id: 'card', onBudget: true, group: 'CREDIT' as const },
      { id: 'off', onBudget: false, group: 'CASH' as const },
    ];
    const w = (accountId: string, outflow: number, inflow = 0, over = {}) => ({ payeeId: 'p1', transferPending: 'waiting' as const, accountId, outflow, inflow, upcoming: false, ...over });
    const txns = [
      w('chk', 4500),
      w('chk', 0, 1000),
      w('card', 9000),
      w('off', 7000),
      w('chk', 100, 0, { upcoming: true }),
      w('chk', 100, 0, { payeeId: 'p2' }),
      w('chk', 100, 0, { transferPending: undefined }),
    ];
    expect(waitingSummary(accounts, txns as never, 'p1')).toEqual({ count: 4, cents: 3500 });
    expect(waitingSummary(accounts, txns as never, 'none')).toEqual({ count: 0, cents: 0 });
  });
});

describe('conversionPlan duplicates and keys', () => {
  test('two rows edited into the same rule: flagged, nothing silently dropped', () => {
    const entries = [
      { key: 'name', matchType: 'is' as const, text: 'Uber', moveFrom: null },
      { key: 'rule:x', matchType: 'is' as const, text: ' uber ', moveFrom: 'r1' },
    ];
    expect(conversionPlan(entries).duplicates).toEqual(['rule:x']);
    expect(conversionPlan(entries.slice(0, 1)).duplicates).toEqual([]);
  });

  test('an entry key survives a put-back that gives the rule a new id (so the person\'s edit stays)', () => {
    const before = payee({ name: 'U', rename_rules: [rule('old', 'contains', 'PIX JOAO')] });
    const after = payee({ name: 'U', rename_rules: [rule('new', 'contains', 'PIX JOAO')] });
    const edits = { edited: { 'rule:contains:pix joao': { text: 'PIX JOAO SP' } }, removed: [] as string[] };
    expect(visibleEntries(before, edits).map((e) => e.text)).toContain('PIX JOAO SP');
    expect(visibleEntries(after, edits).map((e) => [e.text, e.moveFrom])).toContainEqual(['PIX JOAO SP', 'new']);
  });
});

describe('visibleEntries follows the payee\'s current rules', () => {
  const base = payee({ name: 'Uber', rename_rules: [rule('r1', 'contains', 'UBER *TRIP'), rule('r2', 'starts_with', 'UBER EATS')] });
  const none = { edited: {}, removed: [] as string[] };

  test('no changes: the derived list', () => {
    expect(visibleEntries(base, none).map((e) => e.key)).toEqual(['name', 'rule:contains:uber *trip', 'rule:starts_with:uber eats']);
  });

  test('the person\'s removals and edits in the notice are kept, by key', () => {
    const list = visibleEntries(base, { edited: { 'rule:contains:uber *trip': { text: 'UBER *TRIP SP' } }, removed: ['name'] });
    expect(list.map((e) => [e.key, e.text])).toEqual([['rule:contains:uber *trip', 'UBER *TRIP SP'], ['rule:starts_with:uber eats', 'UBER EATS']]);
  });

  test('a rule removed in the Renaming card disappears from the list, even with an edit made on it', () => {
    const after = payee({ name: 'Uber', rename_rules: [rule('r2', 'starts_with', 'UBER EATS')] });
    const list = visibleEntries(after, { edited: { 'rule:contains:uber *trip': { text: 'x' } }, removed: [] });
    expect(list.map((e) => e.key)).toEqual(['name', 'rule:starts_with:uber eats']);
  });

  test('a rule changed in the card shows its new value; one added there appears and is moved', () => {
    const after = payee({ name: 'Uber', rename_rules: [rule('r1', 'is', 'UBER *TRIP'), rule('r3', 'ends_with', 'LTDA')] });
    expect(visibleEntries(after, none).map((e) => [e.key, e.matchType, e.moveFrom])).toEqual([
      ['name', 'is', null],
      ['rule:contains:uber *trip', 'is', 'r1'],
      ['rule:ends_with:ltda', 'ends_with', 'r3'],
    ]);
  });
});

describe('payee list patches', () => {
  const list = [payee({ id: 'p1', rename_rules: [rule('r1', 'is', 'A')] }), payee({ id: 'p2' })];

  test('withRule appends a new rule to its payee and replaces one with the same id', () => {
    const added = withRule(list, rule('r2', 'contains', 'B'));
    expect(added[0]!.rename_rules!.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(added[1]).toBe(list[1]!);
    const changed = withRule(list, rule('r1', 'starts_with', 'AA'));
    expect(changed[0]!.rename_rules).toEqual([rule('r1', 'starts_with', 'AA')]);
  });

  test('withoutRule drops one rule of one payee', () => {
    expect(withoutRule(list, 'p1', 'r1')[0]!.rename_rules).toEqual([]);
    expect(withoutRule(list, 'p2', 'r1')[0]).toBe(list[0]!);
  });
});
