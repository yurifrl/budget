/**
 * Avatar section of the profile: big avatar (tap = change photo), photo
 * actions, and the "Pick a look" grid of generated candidates.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { Avatar } from '@/ui/avatar/Avatar';
import { colors } from '@/ui/theme';

import { useRemoveAvatarMutation, useUpdateMeMutation, useUploadAvatarMutation } from '@/profile/api';
import { candidateSeeds, displayName, uploadErrorMessage, type Me } from '@/profile/model';
import { t } from './i18n';
import { pickAvatarImage } from './pickAvatarImage';
import { ui } from './ui';

const HERO = 144;
const TILE = 60;

function asApiError(e: unknown): { status?: number | string; message?: string } {
  return typeof e === 'object' && e !== null ? (e as { status?: number | string; message?: string }) : {};
}

function Button({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[ui.button, primary && ui.buttonPrimary, disabled && ui.buttonDisabled]}>
      <Text style={ui.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function AvatarEditor({ me }: { me: Me }) {
  const [upload, { isLoading: uploading }] = useUploadAvatarMutation();
  const [remove, { isLoading: removing }] = useRemoveAvatarMutation();
  const [update] = useUpdateMeMutation();
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState(() => candidateSeeds(me.avatar.seed));

  const hasPhoto = me.avatar.image_version !== null;
  const busy = uploading || removing;

  async function changePhoto() {
    setError(null);
    try {
      const picked = await pickAvatarImage();
      if (picked) await upload(picked.blob).unwrap();
    } catch (e) {
      const { status, message } = asApiError(e);
      // A specific API code shows its own sentence; the status rules and the generic text are the fallback.
      setError(apiErrorMessage(e, uploadErrorMessage(status, status === 400 ? message : undefined)));
    }
  }

  async function removePhoto() {
    setError(null);
    await remove()
      .unwrap()
      .catch((e) => setError(apiErrorMessage(e, t('avatar.removeFailed'))));
  }

  async function pickLook(seed: string) {
    setError(null);
    await update({ avatar_seed: seed })
      .unwrap()
      .catch((e) => setError(apiErrorMessage(e, t('avatar.lookFailed'))));
  }

  return (
    <View style={[ui.card, styles.center]}>
      <Pressable
        onPress={changePhoto}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('avatar.changePhoto')}
        style={styles.heroWrap}>
        <Avatar person={me} label={displayName(me)} size={HERO} ring={colors.indigo} />
        {busy ? (
          <View style={styles.spinner}>
            <ActivityIndicator color={colors.white} size="large" />
          </View>
        ) : null}
        <View style={styles.editBadge}>
          <Text style={styles.editGlyph}>{'✎'}</Text>
        </View>
      </Pressable>

      <View style={styles.actions}>
        <Button primary label={uploading ? t('avatar.uploading') : t('avatar.changePhoto')} onPress={changePhoto} disabled={busy} />
        {hasPhoto ? <Button label={t('avatar.removePhoto')} onPress={removePhoto} disabled={busy} /> : null}
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}

      <View style={styles.looksHead}>
        <Text style={ui.sectionTitle}>{t('avatar.pickTitle')}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('avatar.moreLooksLabel')}
          disabled={busy}
          onPress={() => setCandidates(candidateSeeds(me.avatar.seed))}>
          <Text style={styles.more}>{t('avatar.moreLooks')}</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {candidates.map((seed) => {
          const selected = !hasPhoto && me.avatar.seed === seed;
          return (
            <Pressable
              key={seed}
              disabled={busy}
              onPress={() => pickLook(seed)}
              accessibilityRole="button"
              accessibilityLabel={t('avatar.useLook')}
              accessibilityState={{ selected }}
              style={[styles.tile, selected && styles.tileSelected]}>
              <Avatar avatar={{ seed, image_version: null }} id={me.id} size={TILE} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  heroWrap: { width: HERO, height: HERO },
  spinner: {
    ...StyleSheet.absoluteFill as object,
    borderRadius: HERO / 2,
    backgroundColor: 'rgba(12,15,22,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.indigo,
    borderWidth: 3,
    borderColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editGlyph: { color: colors.white, fontSize: 16, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'center' },
  looksHead: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  more: { color: colors.indigo2, fontSize: 13, fontWeight: '700' },
  grid: { alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  tile: { padding: 4, borderRadius: 999, borderWidth: 2, borderColor: 'transparent' },
  tileSelected: { borderColor: colors.indigo2 },
});
