/**
 * "Jev API key" (`/jev-key`, opened from Settings): the person's own OpenRouter
 * key for Jev (save, test, remove; the key is never shown back) or the
 * installation's shared key when the feature is on for them.
 */

import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useBudgetShell } from '@/shell/context';
import { GhostButton } from '@/ui/bits';
import { colors } from '@/ui/theme';

import { JevKeyCard } from './JevKeyCard';
import { t } from './i18n';
import { useJevKey } from './useJevKey';

export function JevKeyScreen() {
  const router = useRouter();
  const shell = useBudgetShell();
  const keys = useJevKey();
  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      {/* "handled": with the keyboard up, the first tap on Save key (or Close)
      acts instead of only dismissing the keyboard (iOS). */}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.title}>{t('screen.title')}</Text>
          <GhostButton label={tCommon('close')} onPress={() => router.back()} />
        </View>
        <Text style={styles.help}>{t('screen.help')}</Text>
        <JevKeyCard keys={keys} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, width: '100%', maxWidth: 640, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
