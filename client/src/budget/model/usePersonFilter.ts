/**
 * usePersonFilter — the Plan's "by person" selection plus its derived Activity
 * map, computed once per render path (PlanScreen owns the call and hands the
 * result to the inspector / mobile detail). All logic is in domain/people.ts;
 * this hook only wires state + members + memoization.
 */

import { useMemo } from 'react';

import { useAppSelector } from '@/store/hooks';

import {
  memberOwnsNoCategories,
  personAccountsLabel,
  personActivity,
  personFor,
  personFilterLabel,
  personFilterScopeLabel,
  showPersonRow,
  type ActivityMap,
  type Person,
  type PersonFilter,
} from '../domain/people';
import type { Budget } from '../domain/types';
import { usePeople } from './usePeople';
import { selectPersonFilter } from '../state/ui';

export interface PersonFilterModel {
  person: PersonFilter;
  /** Budget members (empty until loaded). */
  people: Person[];
  /** Label of the selection; null when 'all'. */
  label: string | null;
  /** The selected member (null for Everyone, Shared, or a former member). */
  selected: Person | null;
  /** Per-person activity map; null when 'all' or not requested (use household activity). */
  activity: ActivityMap | null;
  /** "<First>’s accounts" / "Shared accounts"; null for Everyone (Reflect, Spending). */
  accountsLabel: string | null;
  /** Summary scope label ("Ana’s categories" / "Shared categories"); null for Everyone. */
  scopeLabel: string | null;
  /** Whether the person row shows (others in the budget, or any person assigned). */
  showRow: boolean;
  /** A member is selected who owns no category yet (drives the inline hint). */
  ownsNone: boolean;
}

export function usePersonFilter(
  budget: Budget | undefined,
  budgetId: string | null,
  opts: { activity?: boolean } = {},
): PersonFilterModel {
  const person = useAppSelector((s) => selectPersonFilter(s));
  const { people } = usePeople(budgetId);
  const wantActivity = opts.activity === true;
  const activity = useMemo(
    () => (budget && wantActivity ? personActivity(budget, person) : null),
    [budget, person, wantActivity],
  );
  const label = useMemo(() => personFilterLabel(people, person), [people, person]);
  const selected = useMemo(() => personFor(people, person), [people, person]);
  const accountsLabel = useMemo(() => personAccountsLabel(people, person), [people, person]);
  const scopeLabel = useMemo(() => personFilterScopeLabel(people, person), [people, person]);
  const showRow = useMemo(
    () => showPersonRow(people, budget?.accounts ?? [], budget?.categories ?? []),
    [people, budget],
  );
  const ownsNone = useMemo(
    () => memberOwnsNoCategories(budget?.categories ?? [], person),
    [budget, person],
  );
  return { person, people, label, selected, activity, accountsLabel, scopeLabel, showRow, ownsNone };
}
