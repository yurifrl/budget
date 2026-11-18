import { describe, expect, test } from 'bun:test';

import { budgetCreate, budgetList } from './budgets';

const id = '11111111-1111-4111-8111-111111111111';
const owner = { user_id: '22222222-2222-4222-8222-222222222222', name: 'Ana', email: 'ana@example.com', avatar: { seed: 's', image_version: null } };

describe('budget_list output', () => {
  test('every row says whether the caller owns it, who does, and how many people are on it', () => {
    const base = { id, name: 'Casa', archived_at: null };
    const out = budgetList.output!;
    const row = { ...base, is_owner: false, owner: null, member_count: 2 };
    expect(out.safeParse([row]).success).toBe(true);
    expect(out.safeParse([]).success).toBe(true);
    for (const missing of ['is_owner', 'owner', 'member_count'] as const) {
      const rest = Object.fromEntries(Object.entries(row).filter(([k]) => k !== missing));
      expect(out.safeParse([rest]).success, missing).toBe(false);
    }
    expect(out.safeParse([{ ...row, member_count: -1 }]).success).toBe(false);
    expect(out.parse([{ ...row, owner }])[0]!.owner).toEqual(owner);
    expect(out.safeParse([{ ...row, owner: { name: 'Ana' } }]).success).toBe(false);
  });

  test('the other budget operations keep the plain row (no list-only fields required)', () => {
    expect(budgetCreate.output!.safeParse({ id, name: 'Casa' }).success).toBe(true);
  });
});
