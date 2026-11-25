/**
 * The facts the bank sent about the merchant, in place of the map the mock
 * drew (bank data carries no location): legal name, CNPJ, the bank's
 * category, operation type and the PIX counterparty. Rows the bank did not
 * send are not drawn; with none at all the panel is not drawn either.
 */

import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import type { MerchantFact } from './queue.logic';

export function MerchantPanel({ facts }: { facts: readonly MerchantFact[] }) {
  if (facts.length === 0) return null;
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{t('one.merchant')}</Text>
      {facts.map((fact) => (
        <View key={fact.key} style={styles.fact}>
          <Text style={styles.label}>{fact.label}</Text>
          <Text style={styles.value} selectable>
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexGrow: 1,
    flexBasis: 240,
    minWidth: 220,
    gap: 8,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 12,
  },
  title: { color: colors.faint, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 },
  fact: { gap: 1 },
  label: { color: colors.muted, fontSize: 11 },
  value: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
