/**
 * The sync-window picker: how far back a bank's pulls reach. Preset pills plus
 * an "Other…" numeric entry for custom day counts (1–3650). With
 * `defaultLabel` set, an extra first pill means "inherit the app-wide default"
 * (value null) — used by the per-bank settings page.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { syncWindowLabel } from '../../domain/connections';
import { colors, radius } from '../../ui/theme';

/** The preset pills offered; 0 = All history (no lower bound). */
const WINDOW_PRESETS = [0, 365, 180, 90, 30] as const;

export function SyncWindowControl({
  days,
  onPick,
  defaultLabel,
}: {
  /** Current value; null = inherit the default; undefined = still loading. */
  days: number | null | undefined;
  onPick: (days: number | null) => void;
  /** When set, renders the "Default (<label>)" pill that picks null. */
  defaultLabel?: string;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const isPreset = typeof days === 'number' && (WINDOW_PRESETS as readonly number[]).includes(days);
  const isCustom = typeof days === 'number' && !isPreset;

  const applyCustom = () => {
    const n = Number(custom);
    if (Number.isInteger(n) && n >= 1 && n <= 3650) {
      onPick(n);
      setCustomOpen(false);
      setCustom('');
    }
  };

  const pill = (key: string, label: string, active: boolean, onPress: () => void, a11y: string) => (
    <Pressable
      key={key}
      style={[styles.winPill, active && styles.winPillOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={a11y}
      onPress={onPress}>
      <Text style={[styles.winPillText, active && styles.winPillTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.winRow}>
      {defaultLabel != null
        ? pill(
            'default',
            `Default (${defaultLabel})`,
            days === null,
            () => {
              setCustomOpen(false);
              onPick(null);
            },
            'Sync history default',
          )
        : null}
      {WINDOW_PRESETS.map((d) =>
        pill(
          `p${d}`,
          syncWindowLabel(d),
          days === d,
          () => {
            setCustomOpen(false);
            onPick(d);
          },
          `Sync history ${syncWindowLabel(d)}`,
        ),
      )}
      {customOpen
        ? [
            <TextInput
              key="custom-input"
              style={styles.winInput}
              value={custom}
              onChangeText={setCustom}
              placeholder="days"
              keyboardType="number-pad"
              autoFocus
              onSubmitEditing={applyCustom}
            />,
            pill('set', 'Set', false, applyCustom, 'Apply custom sync window'),
            pill('cancel', '×', false, () => setCustomOpen(false), 'Cancel custom sync window'),
          ]
        : pill(
            'other',
            isCustom ? `${days}d` : 'Other…',
            isCustom,
            () => {
              setCustom(isCustom ? String(days) : '');
              setCustomOpen(true);
            },
            'Custom sync window',
          )}
    </View>
  );
}

const styles = StyleSheet.create({
  winRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  winPill: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
  },
  winPillOn: { backgroundColor: colors.indigoSoft, borderColor: colors.indigo2 },
  winPillText: { color: colors.muted, fontSize: 13 },
  winPillTextOn: { color: colors.indigo2, fontWeight: '700' },
  winInput: {
    width: 80,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 10,
  },
});
