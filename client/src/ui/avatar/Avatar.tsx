/**
 * `<Avatar>` — the one way a person's picture is drawn anywhere in the app.
 *
 *   <Avatar person={{ id, avatar }} size={24} />
 *
 * `avatar` is the API's PersonAvatar shape (see types.ts). With a photo
 * (`image_version != null`) the uploaded image is shown via expo-image
 * (disk-cached; the versioned URL is immutable); the generated avatar renders
 * underneath while it loads and permanently if it fails. Image auth matches
 * the rest of the app: cookie on web, Bearer token headers on native
 * (useAuthHeaders).
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useAuthHeaders } from '@/platform/api/useAuthHeaders';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { AvatarArt } from './AvatarArt';
import type { AvatarPerson, PersonAvatar } from './types';
import { avatarImageUri } from './url';

export interface AvatarProps {
  /** Full person (preferred): id + avatar, optional name/email for the a11y label. */
  person?: AvatarPerson;
  /** Minimal alternative to `person`. */
  id?: string;
  avatar?: PersonAvatar;
  /** Accessibility label override. */
  label?: string;
  size?: number;
  /** Outline color (e.g. the surface color, to separate overlapping avatars). */
  ring?: string;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ person, id, avatar, label, size = 32, ring, style }: AvatarProps) {
  const userId = person?.id ?? id;
  const look = person?.avatar ?? avatar;
  const a11y = label ?? person?.name ?? person?.email ?? undefined;
  const ringWidth = ring ? Math.max(1.5, Math.round(size * 0.07)) : 0;
  const inner = size - ringWidth * 2;

  const { apiUrl } = useService(Tokens.Config);
  const headers = useAuthHeaders();
  const [failedVersion, setFailedVersion] = useState<number | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  const version = look?.image_version ?? null;
  const showPhoto = !!userId && version !== null && failedVersion !== version && headers !== null;
  const photoReady = showPhoto && loadedVersion === version;

  return (
    <View
      accessible={!!a11y}
      accessibilityRole="image"
      accessibilityLabel={a11y}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: ringWidth,
          borderColor: ring ?? 'transparent',
          overflow: 'hidden',
        },
        style,
      ]}>
      {photoReady ? null : <AvatarArt seed={look?.seed ?? userId ?? ''} size={inner} />}
      {showPhoto ? (
        <Image
          source={{ uri: avatarImageUri(apiUrl, userId!, version!), headers }}
          style={{ position: 'absolute', left: 0, top: 0, width: inner, height: inner, opacity: photoReady ? 1 : 0 }}
          contentFit="cover"
          onLoad={() => setLoadedVersion(version)}
          onError={() => setFailedVersion(version)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}
