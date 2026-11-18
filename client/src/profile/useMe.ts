import { useGetMeQuery } from './api';
import type { Me } from './model';

/**
 * The signed-in user ("me"), with their avatar — the profile module's public
 * hook so other modules can show the current person without touching its api.
 */
export function useMe(): { me: Me | undefined; isLoading: boolean; isError: boolean } {
  const { data, isLoading, isError } = useGetMeQuery();
  return { me: data, isLoading, isError };
}
