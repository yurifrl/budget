/** "How to get your keys": the MeuPluggy route in plain words, and its connection limit. */

import { Linking, StyleSheet, Text, View } from 'react-native';

import { rich } from '@/ui/i18n/rich';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import { MEUPLUGGY_CONNECTION_LIMIT } from './pluggyKeys.logic';

const DASHBOARD_URL = 'https://dashboard.pluggy.ai';

export function PluggyKeysHelp() {
  // Steps 2 onwards; step 1 carries the dashboard link. Built per render so the language is read live.
  const steps = [t('help.step2'), t('help.step3'), t('help.step4')];
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t('help.title')}</Text>
      <Text style={styles.body}>{t('help.intro')}</Text>
      <View style={styles.step}>
        <Text style={styles.num}>1.</Text>
        <Text style={styles.body}>
          {rich(t('help.step1'), {
            link: (children) => (
              <Text style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(DASHBOARD_URL)}>
                {children}
              </Text>
            ),
          })}
        </Text>
      </View>
      {steps.map((step, i) => (
        <View key={step} style={styles.step}>
          <Text style={styles.num}>{`${i + 2}.`}</Text>
          <Text style={styles.body}>{step}</Text>
        </View>
      ))}
      <Text style={styles.limit}>{t('help.limit', { limit: MEUPLUGGY_CONNECTION_LIMIT })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card10,
    padding: 16,
    gap: 8,
  },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  step: { flexDirection: 'row', gap: 8 },
  num: { color: colors.indigo3, fontSize: 14, lineHeight: 20, fontWeight: '700', width: 18 },
  link: { color: colors.indigo3, textDecorationLine: 'underline' },
  limit: { color: colors.yellowPillFg, fontSize: 13, fontWeight: '600', marginTop: 4 },
});
