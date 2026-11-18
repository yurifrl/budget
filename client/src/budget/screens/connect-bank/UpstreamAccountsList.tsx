/**
 * Read-only list of a connection's upstream (bank-side) accounts with the
 * budget account each is linked to. Linking is edited per account in the
 * account editor — never here. Shared by the Linked banks rows and the
 * per-bank settings page.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { ConnectionUpstreamJson } from '../../data/connections';
import type { AccountRow } from '../../data/rows';
import { creditSummary } from '../../domain/connections';
import { formatMoney } from '../../domain/format';
import { colors } from '../../ui/theme';

export function UpstreamAccountsList({
  up,
  accounts,
  bordered = true,
}: {
  up: ConnectionUpstreamJson;
  /** Budget accounts, to resolve link names. */
  accounts: AccountRow[];
  /** Hairline top border (the in-row presentation). */
  bordered?: boolean;
}) {
  const box = [styles.acctBox, !bordered && styles.acctBoxFlat];
  if (up.accounts == null) {
    return (
      <View style={box}>
        <Text style={styles.acctWarn}>Accounts unavailable — Sync now to refresh.</Text>
      </View>
    );
  }
  if (up.accounts.length === 0) {
    return (
      <View style={box}>
        <Text style={styles.acctHint}>No accounts returned by this bank.</Text>
      </View>
    );
  }
  return (
    <View style={box}>
      {up.accounts.map((acct) => {
        const linked = acct.linkedAccountId ? accounts.find((a) => a.id === acct.linkedAccountId) : undefined;
        return (
          <View key={acct.externalId} style={styles.acctRow}>
            <Text style={styles.acctType}>{acct.type === 'CREDIT' ? 'credit' : 'bank'}</Text>
            <Text style={styles.acctName} numberOfLines={1}>
              {acct.name}
            </Text>
            {(() => {
              const credit = acct.type === 'CREDIT' ? creditSummary(acct.credit, formatMoney) : null;
              const text = credit ?? (acct.balanceCents != null ? formatMoney(acct.balanceCents) : null);
              return text != null ? <Text style={styles.acctBalance}>{text}</Text> : null;
            })()}
            <Text style={[styles.acctLink, linked ? undefined : styles.acctLinkNone]} numberOfLines={1}>
              {linked ? `→ ${linked.name}` : 'not linked'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  acctBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  acctBoxFlat: { borderTopWidth: 0, paddingHorizontal: 0 },
  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acctType: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    width: 44,
  },
  acctName: { color: colors.text, fontSize: 13, fontWeight: '500', flexShrink: 1 },
  acctBalance: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  acctLink: { color: colors.indigo3, fontSize: 12, fontWeight: '600', maxWidth: 150 },
  acctLinkNone: { color: colors.muted, fontWeight: '400' },
  acctHint: { color: colors.muted, fontSize: 12 },
  acctWarn: { color: colors.yellowPillFg, fontSize: 12 },
});
