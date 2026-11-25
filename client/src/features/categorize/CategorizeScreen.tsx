/**
 * "Categorize" (`/categorize`): checkpoint 1 skeleton. The Bundles and One by
 * one views land in the next checkpoint; the route and the rail entry exist so
 * navigation and the queue count can be exercised.
 */

import { StyleSheet, Text, View } from 'react-native';

import { useBudgetShell } from '@/shell/context';
import { colors } from '@/ui/theme';

import { t } from './i18n';

export function CategorizeScreen() {
  const shell = useBudgetShell();
  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <Text style={styles.title}>{t('screen.title')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 22 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
});
