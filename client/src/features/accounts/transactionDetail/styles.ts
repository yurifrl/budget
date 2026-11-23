/** Styles shared by the transaction page's pieces. */
import { Platform, StyleSheet } from 'react-native';

import { colors, radius } from '@/ui/theme';

// eslint-disable-next-line budget-i18n/no-untranslated-string -- font family names, not UI text
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { color: colors.faint, fontSize: 13, textAlign: 'center' },
  scroll: { paddingHorizontal: 16, paddingBottom: 48, gap: 14, maxWidth: 820, width: '100%', alignSelf: 'center' },
  scrollPhone: { paddingHorizontal: 12 },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingTop: 12 },
  headMain: { flex: 1, minWidth: 0, gap: 2 },
  eyebrow: { color: colors.faint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 13 },
  amount: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  amountOut: { color: colors.redFg },
  amountIn: { color: colors.greenPillFg },
  badge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.redPillBg,
    color: colors.redFg,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  label: { color: colors.faint, fontSize: 13, width: 170, flexShrink: 0 },
  labelPhone: { width: 120 },
  value: { color: colors.text, fontSize: 13, flex: 1, minWidth: 0 },
  mono: { fontFamily: mono, fontSize: 12 },
  stateEdited: { color: colors.yellowPillFg },

  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.indigoSoft,
  },
  actionText: { color: colors.indigo3, fontSize: 12, fontWeight: '600' },
  iconBtn: { padding: 2 },

  rawLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 3 },
  rawKey: { fontFamily: mono, fontSize: 12, color: colors.indigo3, flexShrink: 0, maxWidth: '45%' },
  rawValue: { fontFamily: mono, fontSize: 12, color: colors.text, flex: 1, minWidth: 0 },
  rawSummary: { fontFamily: mono, fontSize: 12, color: colors.faint, flex: 1 },
  rawNull: { color: colors.faint, fontStyle: 'italic' },
  rawNumber: { color: colors.yellowPillFg },
  rawBool: { color: colors.greenPillFg },
});
