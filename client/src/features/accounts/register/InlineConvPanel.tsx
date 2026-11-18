/**
 * Scheduled USD→BRL conversion panel of the inline add / edit row: the typed
 * USD amount, the editable ledger (BRL) amount and the indicative rate.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatUsd } from '@/domain/format';
import type { UsdDraft } from '@/domain/inlineAdd';
import type { Cents } from '@/domain/types';
import { MoneyInput } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

export function InlineConvPanel({
  usd,
  cents,
  onCommit,
  rateData,
  rateFetching,
  rateError,
  onRetry,
}: {
  usd: UsdDraft;
  /** The ledger amount on the draft's side. */
  cents: Cents;
  onCommit: (cents: Cents) => void;
  rateData: { rate: number } | undefined;
  rateFetching: boolean;
  rateError: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.convPanel}>
      {rateFetching && !rateData ? (
        <View style={styles.convRow}>
          <ActivityIndicator size="small" color={colors.indigo} />
          <Text style={styles.convLabel}>Fetching USD→BRL rate…</Text>
        </View>
      ) : (
        <View style={styles.convRow}>
          <Text style={styles.convLabel}>
            {usd.field === 'outflow' ? 'Outflow' : 'Inflow'} {formatUsd(usd.cents)} ≈
          </Text>
          <MoneyInput
            cents={cents}
            onCommit={onCommit}
            style={styles.convInput}
          />
          {rateData ? (
            <Text style={styles.convRate} accessibilityLabel="USD to BRL rate">
              1 USD = {rateData.rate.toFixed(4)} BRL
            </Text>
          ) : null}
          {rateError ? (
            <Pressable onPress={() => onRetry()} style={styles.convRetry}>
              <Text style={styles.convErrorText}>rate unavailable — retry</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Scheduled USD→BRL conversion panel.
  convPanel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  convRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  convLabel: { color: colors.muted, fontSize: 12 },
  convInput: { fontSize: 13, minWidth: 90 },
  convRate: { color: colors.faint, fontSize: 11, marginLeft: 'auto' },
  convRetry: { marginLeft: 'auto' },
  convErrorText: { color: colors.redFg, fontSize: 11 },
});
