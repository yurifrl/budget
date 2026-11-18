/**
 * Single-select link picker, shared by both directions (choose the bank
 * account for a budget account; choose the budget account for a bank
 * account). Tapping a row only SELECTS it; the explicit primary button names
 * the target and performs the link.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LinkOptionGroup } from '../../model/banks/linkPicker';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { colors, radius } from '../../ui/theme';
import { LinkOptionCard } from './LinkOptionCard';

export function LinkPicker({
  heading,
  helper,
  referenceLabel,
  referenceCents,
  groups,
  loading,
  loadFailed,
  onRetry,
  emptyText,
  initialSelectedId,
  busy,
  error,
  listMaxHeight,
  onConfirm,
  onCancel,
}: {
  heading: string;
  helper: string;
  /** "Your balance in syscd" / "Bank balance": the figure the hints compare against. */
  referenceLabel: string;
  referenceCents: number | null;
  groups: LinkOptionGroup[];
  loading: boolean;
  /** The bank-account list query itself failed (provider slow/down) — distinct from "no accounts". */
  loadFailed?: boolean;
  onRetry?: () => void;
  emptyText: string;
  initialSelectedId?: string | null;
  busy: boolean;
  error?: string | null;
  /** Scroll the option list past this height so the header and buttons stay in view (sheets). */
  listMaxHeight?: number;
  onConfirm: (optionId: string) => void;
  /** Omit to hide the Cancel button (first-time link has nothing to cancel). */
  onCancel?: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const all = groups.flatMap((g) => g.options);
  const selected = all.find((o) => o.id === selectedId) ?? null;
  const nothingToPick = !loading && !loadFailed && all.length === 0 && groups.every((g) => g.unavailable == null);

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>{heading}</Text>
      <Text style={styles.helper}>{helper}</Text>
      {referenceCents != null ? (
        <View style={styles.reference}>
          <Text style={styles.referenceLabel}>{referenceLabel}</Text>
          <Text style={styles.referenceValue}>{formatMoney(referenceCents)}</Text>
        </View>
      ) : null}

      {loading ? <ActivityIndicator size="small" color={colors.indigo2} /> : null}
      {loadFailed && all.length === 0 ? (
        <View style={styles.reference}>
          <Text style={styles.unavailable}>Could not load your bank accounts — the bank did not answer.</Text>
          {onRetry ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Retry loading bank accounts" onPress={onRetry}>
              <Text style={styles.referenceValue}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {nothingToPick ? <Text style={styles.empty}>{emptyText}</Text> : null}

      <ScrollView style={listMaxHeight ? { maxHeight: listMaxHeight } : styles.noScroll} scrollEnabled={listMaxHeight != null} nestedScrollEnabled>
      <View accessibilityRole="radiogroup" style={styles.list}>
        {groups.map((g) => (
          <View key={g.key} style={styles.group}>
            {groups.length > 1 || g.unavailable ? (
              <Text style={styles.groupLabel} numberOfLines={1}>{g.label}</Text>
            ) : null}
            {g.unavailable ? <Text style={styles.unavailable}>{g.unavailable}</Text> : null}
            {g.options.map((o) => {
              const disabled = o.linkedTo != null || busy;
              const isSelected = o.id === selectedId && o.linkedTo == null;
              return (
                <Pressable
                  key={o.id}
                  accessibilityRole="radio"
                  accessibilityLabel={o.title}
                  accessibilityState={{ selected: isSelected, disabled }}
                  disabled={disabled}
                  onPress={() => setSelectedId(o.id)}
                  style={[styles.row, isSelected && styles.rowSelected, o.linkedTo != null && styles.rowDisabled]}>
                  <View style={[styles.radio, isSelected && styles.radioOn]}>
                    {isSelected ? <View style={styles.radioDot} /> : null}
                  </View>
                  <LinkOptionCard option={o} dim={o.linkedTo != null} />
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {onCancel ? (
          <Pressable style={styles.ghost} disabled={busy} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.ghostText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.primary, (!selected || busy) && styles.primaryOff]}
          disabled={!selected || busy}
          onPress={() => selected && onConfirm(selected.id)}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selected || busy }}>
          <Text style={styles.primaryText} numberOfLines={1}>
            {busy ? 'Linking…' : selected ? `Link to ${selected.title}` : 'Select one to link'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  heading: { color: colors.text, fontSize: 14, fontWeight: '700' },
  helper: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  reference: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
  },
  referenceLabel: { color: colors.muted, fontSize: 12 },
  referenceValue: { color: colors.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  empty: { color: colors.faint, fontSize: 12 },
  list: { gap: 10 },
  noScroll: { flexGrow: 0 },
  group: { gap: 6 },
  groupLabel: { color: colors.faint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  unavailable: { color: colors.yellowPillFg, fontSize: 12, lineHeight: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
  },
  rowSelected: { borderColor: colors.indigo2, backgroundColor: colors.indigoSoft },
  rowDisabled: { opacity: 0.6, backgroundColor: colors.bg },
  radio: {
    width: 18,
    height: 18,
    marginTop: 2,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.indigo2 },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.indigo2 },
  error: { color: colors.redFg, fontSize: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 2 },
  ghost: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  ghostText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  primary: { flexShrink: 1, backgroundColor: colors.indigo, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  primaryOff: { backgroundColor: colors.border2, opacity: 0.7 },
  primaryText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
