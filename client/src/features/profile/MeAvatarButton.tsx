/** The current user's avatar as a button that opens the profile page (app chrome entry point). */
import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import { Avatar } from '@/ui/avatar/Avatar';

import { useMe } from './useMe';

export function MeAvatarButton({ size = 32 }: { size?: number }) {
  const router = useRouter();
  const { me } = useMe();
  if (!me) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open profile"
      hitSlop={6}
      onPress={() => router.push('/profile')}>
      <Avatar person={me} size={size} />
    </Pressable>
  );
}
