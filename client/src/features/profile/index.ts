/**
 * Profile feature — public barrel.
 *
 * The signed-in user's profile page (picture, display name) at `/profile`,
 * connected apps at `/connected-apps`, plus the small public surface other
 * features use to show "me": `useMe()` and `<MeAvatarButton />` (an avatar
 * that opens the profile). The api slice is mounted by `state/store.ts`.
 */
export { ConnectedAppsScreen } from './ConnectedAppsScreen';
export { ProfileScreen } from './ProfileScreen';
export { MeAvatarButton } from './MeAvatarButton';
export { useMe } from './useMe';
export type { Me } from '@/profile/model';
