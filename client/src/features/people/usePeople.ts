/**
 * usePeople — the budget's members as UI `Person`s, the one way screens read
 * them (rail, picker, plan filter, register header, People pane).
 *
 * Cache coherence: members are cached by RTK Query in the budget api, while
 * the viewer's own name/picture live in the profile module's cache (edited on
 * /profile). Rather than refetch, the viewer's row is overlaid with the live
 * profile (`useMe()`, the profile barrel) — an edit on /profile shows in every
 * Budget avatar instantly, with no reload, refetch or cross-module wiring.
 */

import { useMemo } from 'react';

import { useMe } from '@/features/profile';

import { useGetBudgetMembersQuery } from '@/budget/data/api';
import { personFor, withMyProfile, type Person } from '@/domain/people';

export interface PeopleModel {
  /** Budget members (empty until loaded), with the viewer's row live. */
  people: Person[];
  /** The viewer's row, when they are a member. */
  me: Person | undefined;
  /** Whether the viewer may add/remove people (owner or admin). */
  canManage: boolean;
  isLoading: boolean;
  /** Resolve an account's `user_id` (null / unknown = Shared = null). */
  personOf: (userId: string | null) => Person | null;
}

export function usePeople(budgetId: string | null): PeopleModel {
  const members = useGetBudgetMembersQuery({ budgetId: budgetId ?? '' }, { skip: !budgetId });
  const { me: profile } = useMe();
  const people = useMemo(() => withMyProfile(members.data?.members ?? [], profile), [members.data, profile]);
  return {
    people,
    me: people.find((p) => p.is_me),
    canManage: members.data?.can_manage ?? false,
    isLoading: members.isLoading,
    personOf: (userId) => personFor(people, userId),
  };
}
