/**
 * "AI key" (`/ai-keys`): the key category suggestions run on. One screen for
 * web and iOS: paste the key, see or change the detected provider, pick a
 * model, then save / test / remove. It shows the current state from the
 * server (own credential without the key, or the installation's shared AI,
 * or neither). The key only ever goes to our API, which stores it encrypted;
 * this screen keeps it in memory while typed and never on the device.
 */

import { useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useBudgetShell } from '@/shell/context';
import { GhostButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { AiKeyForm } from './AiKeyForm';
import { AiKeySavedCard, SharedAiCard } from './AiKeySavedCard';
import { t } from './i18n';
import { useAiKeys } from './useAiKeys';

export function AiKeysScreen() {
  const router = useRouter();
  const shell = useBudgetShell();
  const keys = useAiKeys();

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      {/* "handled": with the keyboard up, the first tap on a chip or Save acts
      instead of only dismissing the keyboard (iOS). */}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.title}>{t('screen.title')}</Text>
          <GhostButton
            label={tCommon('close')}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/plan'))}
          />
        </View>
        <Text style={styles.intro}>{t('screen.intro')}</Text>

        {keys.mode === 'loading' ? (
          <View style={[styles.card, styles.center]}>
            <ActivityIndicator color={colors.indigo2} />
          </View>
        ) : null}

        {keys.mode === 'failed' ? (
          <View style={styles.card}>
            <Text style={styles.errorText}>{t('screen.loadFailed')}</Text>
            <View style={styles.retry}>
              <GhostButton label={tCommon('retry')} onPress={() => void keys.retry()} />
            </View>
          </View>
        ) : null}

        {keys.mode === 'saved' && !keys.editing ? <AiKeySavedCard keys={keys} /> : null}
        {keys.mode === 'shared' && keys.status ? <SharedAiCard status={keys.status} /> : null}
        {keys.showForm ? <AiKeyForm keys={keys} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, width: '100%', maxWidth: 640, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card10,
    padding: 16,
    gap: 10,
  },
  center: { alignItems: 'center', paddingVertical: 32 },
  errorText: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  retry: { alignSelf: 'flex-start' },
});
