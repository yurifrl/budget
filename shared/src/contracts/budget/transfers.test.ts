import { describe, expect, test } from 'bun:test';

import { transactionRowSchema } from './outputs';
import {
  payeesSetTransferRule,
  payeesTransferRuleGet,
  transferSuggestionsList,
  transfersLink,
  transfersMark,
  transfersUnlink,
} from './transfers';

const b = '11111111-1111-4111-8111-111111111111';
const t1 = '22222222-2222-4222-8222-222222222222';
const t2 = '33333333-3333-4333-8333-333333333333';

const leg = {
  transaction_id: t1,
  account_id: b,
  account_name: 'Itau',
  date: '2026-11-03',
  amount: -3_000_000,
  payee_name: 'Pix enviado',
  bank_label: 'Same person transfer',
  untouched: true,
};

describe('transfer contracts', () => {
  test('suggestion rows carry the row, the candidates with their distance, confidence and basis', () => {
    const row = { id: t1, confidence: 'sure', basis: 'unique', leg, candidates: [{ ...leg, transaction_id: t2, amount: 3_000_000, days_apart: 0 }] };
    expect(transferSuggestionsList.output!.safeParse([row]).success).toBe(true);
    expect(transferSuggestionsList.output!.safeParse([{ ...row, confidence: 'maybe' }]).success).toBe(false);
    expect(transferSuggestionsList.input.safeParse({ budget_id: b }).success).toBe(true);
  });

  test('link takes pairs (or an account) and an optional remember flag; ids and modes are validated', () => {
    expect(transfersLink.input.safeParse({ budget_id: b, links: [{ transaction_id: t1, counterpart_id: t2 }], remember_payee: true }).success).toBe(true);
    expect(transfersLink.input.safeParse({ budget_id: b, links: [] }).success).toBe(false);
    expect(transfersLink.output!.safeParse({ linked: [t1, t2], rules_created: 1, warnings: [] }).success).toBe(true);
    const warning = { transaction_id: t1, counterpart_id: t2, rule: 'card_payment_other_bank' };
    expect(transfersLink.output!.safeParse({ linked: [t1, t2], rules_created: 0, warnings: [warning] }).success).toBe(true);
    expect(transfersLink.output!.safeParse({ linked: [], rules_created: 0, warnings: [{ ...warning, rule: 'nope' }] }).success).toBe(false);
    expect(transfersUnlink.input.safeParse({ budget_id: b, transaction_ids: ['nope'] }).success).toBe(false);
    expect(transfersMark.input.safeParse({ budget_id: b, transaction_ids: [t1], state: null }).success).toBe(true);
    expect(transfersMark.input.safeParse({ budget_id: b, transaction_ids: [t1], state: 'manual' }).success).toBe(false);
  });

  test('payee rule: modes, wait days bounded, read shape', () => {
    expect(payeesSetTransferRule.input.safeParse({ id: t1, budget_id: b, mode: 'auto', wait_days: 5 }).success).toBe(true);
    expect(payeesSetTransferRule.input.safeParse({ id: t1, budget_id: b, mode: 'auto', wait_days: 0 }).success).toBe(false);
    expect(payeesSetTransferRule.input.safeParse({ id: t1, budget_id: b, mode: 'sometimes' }).success).toBe(false);
    const rule = { payee_id: t1, mode: 'account', account_id: b, no_match: 'outside', wait_days: 5, since: null, past_rows: 92, linked: 0 };
    expect(payeesTransferRuleGet.output!.safeParse(rule).success).toBe(true);
  });

  test('register rows may carry the transfer summary fields; stored rows without them still parse', () => {
    const base = transactionRowSchema.shape;
    expect('transfer_suggestion' in base && 'transfer_pending' in base && 'transfer_link_method' in base).toBe(true);
    const partial = transactionRowSchema.pick({ transfer_suggestion: true, transfer_pending: true, transfer_link_method: true });
    expect(partial.safeParse({}).success).toBe(true);
    expect(partial.safeParse({ transfer_suggestion: { confidence: 'choose', candidate_count: 2, counterpart_id: null }, transfer_pending: 'waiting', transfer_link_method: 'rule' }).success).toBe(true);
    expect(partial.safeParse({ transfer_pending: 'later' }).success).toBe(false);
  });
});
