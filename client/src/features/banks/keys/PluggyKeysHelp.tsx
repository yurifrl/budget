/** "How to get your keys": the MeuPluggy route in plain words, and its connection limit. */

import { Linking, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';
import { MEUPLUGGY_CONNECTION_LIMIT } from './pluggyKeys.logic';

const DASHBOARD_URL = 'https://dashboard.pluggy.ai';

/** Steps 2 onwards; step 1 carries the dashboard link. */
const STEPS: readonly string[] = [
  'Create an application in the dashboard.',
  'Copy its client id and client secret and paste them here. Pluggy shows the secret only once, so paste it straight away (lost it? create a new one there).',
  'Then connect your bank here: in the connect window, pick MeuPluggy and sign in to it.',
];

export function PluggyKeysHelp() {
  return (
    <View style={styles.card}>
      <Text style={styles.section}>HOW TO GET YOUR KEYS</Text>
      <Text style={styles.body}>
        The app reaches your bank through Pluggy, using keys that belong to you. Getting them takes a few minutes:
      </Text>
      <View style={styles.step}>
        <Text style={styles.num}>1.</Text>
        <Text style={styles.body}>
          {'Sign up for free at '}
          <Text style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(DASHBOARD_URL)}>
            dashboard.pluggy.ai
          </Text>
          {'. This is MeuPluggy, Pluggy’s free route for personal use.'}
        </Text>
      </View>
      {STEPS.map((step, i) => (
        <View key={step} style={styles.step}>
          <Text style={styles.num}>{`${i + 2}.`}</Text>
          <Text style={styles.body}>{step}</Text>
        </View>
      ))}
      <Text style={styles.limit}>{`MeuPluggy allows up to ${MEUPLUGGY_CONNECTION_LIMIT} bank connections.`}</Text>
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
