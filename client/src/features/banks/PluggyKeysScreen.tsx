/**
 * "Your Pluggy keys" (`/pluggy-keys`): the user's own Pluggy client id and
 * secret (enter, replace, remove; the secret is never shown back) and how to
 * get them through MeuPluggy. Opened from Linked banks, from a paused bank,
 * and instead of the connect widget when the user may not use the shared
 * keys (`?reason=connect`).
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useBudgetShell } from '@/shell/context';
import { GhostButton, IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { CONNECT_BANK_ROUTE } from './connect-bank/connectBank.logic';
import { PluggyKeysCard } from './keys/PluggyKeysCard';
import { PluggyKeysHelp } from './keys/PluggyKeysHelp';
import { usePluggyKeys } from './keys/usePluggyKeys';
import { t } from './i18n';

export function PluggyKeysScreen() {
  const router = useRouter();
  const shell = useBudgetShell();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const keys = usePluggyKeys();
  const fromConnect = reason === 'connect';
  const back = () => router.replace(CONNECT_BANK_ROUTE as Href);

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      {/* "handled": with the keyboard up, the first tap on Save keys (or Close,
      or a help link) acts instead of only dismissing the keyboard (iOS). */}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.title}>{t('keys.title')}</Text>
          <GhostButton label={tCommon('close')} onPress={back} />
        </View>

        {fromConnect && keys.mode !== 'saved' ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('keys.connectBanner')}</Text>
          </View>
        ) : null}

        <PluggyKeysCard keys={keys} />

        {fromConnect && keys.mode === 'saved' ? (
          <IndigoButton label={t('keys.connectButton')} onPress={back} style={styles.connect} />
        ) : null}

        <PluggyKeysHelp />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, width: '100%', maxWidth: 640, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  banner: { backgroundColor: colors.yellowPillBg, borderRadius: radius.sm, padding: 12 },
  bannerText: { color: colors.yellowPillFg, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  connect: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center' },
});
