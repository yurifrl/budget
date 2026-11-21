/**
 * Calendar-footer Repeat control of the inline add / edit row
 * (syscd-app-pya): a frequency dropdown plus Make Repeating, or, for a row
 * that already belongs to a rule, the rule's cadence and Stop Repeating.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { REPEAT_FREQS, REPEAT_LABELS } from '@/domain/inlineAdd';
import type { RepeatFrequency, Transaction } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { pressNoBlur } from '@/ui/dropdown/dropdown';
import { t } from './i18n';

export function InlineRepeatFooter({
  transaction,
  repeatFreq,
  onFreqChange,
  open,
  onOpenChange,
  onStop,
  onMake,
}: {
  /** The row being edited, if any: a row on a rule shows Stop Repeating. */
  transaction: Transaction | undefined;
  /** null = Never. */
  repeatFreq: RepeatFrequency | null;
  onFreqChange: (freq: RepeatFrequency | null) => void;
  /** Frequency menu open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStop: () => void;
  /** Make Repeating: saves the row with the picked frequency. */
  onMake: () => void;
}) {
  return (
    transaction?.repeatRuleId ? (
      <View style={styles.repeatBar}>
        <Text style={styles.repeatLabel}>
          {t('repeat.repeats', {
            frequency: REPEAT_LABELS[transaction.repeat as RepeatFrequency] ?? transaction.repeat,
          })}
        </Text>
        <Pressable style={styles.repeatStop} onPress={() => onStop()}>
          <Text style={styles.repeatStopText}>{t('repeat.stop')}</Text>
        </Pressable>
      </View>
    ) : (
      <View style={styles.repeatBar}>
        <Text style={styles.repeatLabel}>{t('repeat.label')}</Text>
        <View style={styles.repeatPicker}>
          <Pressable
            style={styles.repeatTrigger}
            onPress={() => onOpenChange(!open)}
            {...pressNoBlur}
            accessibilityLabel={t('repeat.frequencyLabel')}>
            <Text style={styles.repeatTriggerText}>
              {repeatFreq ? REPEAT_LABELS[repeatFreq] : t('repeat.never')}
            </Text>
            <Text style={styles.repeatCaret}>▾</Text>
          </Pressable>
          {open ? (
            <View style={styles.repeatMenu}>
              <Pressable
                style={styles.repeatItem}
                onPress={() => {
                  onFreqChange(null);
                  onOpenChange(false);
                }}
                {...pressNoBlur}>
                <Text style={[styles.repeatItemText, repeatFreq === null && styles.repeatItemActive]}>
                  {t('repeat.never')}
                </Text>
              </Pressable>
              {REPEAT_FREQS.map((f) => (
                <Pressable
                  key={f}
                  style={styles.repeatItem}
                  onPress={() => {
                    onFreqChange(f);
                    onOpenChange(false);
                  }}
                  {...pressNoBlur}>
                  <Text style={[styles.repeatItemText, repeatFreq === f && styles.repeatItemActive]}>
                    {REPEAT_LABELS[f]}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        {repeatFreq ? (
          <Pressable style={styles.repeatMake} onPress={() => onMake()} {...pressNoBlur}>
            <Text style={styles.repeatMakeText}>{t('repeat.make')}</Text>
          </Pressable>
        ) : null}
      </View>
    )
  );
}

const styles = StyleSheet.create({
  // Calendar-footer repeat bar (syscd-app-pya).
  repeatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  repeatLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  repeatPicker: { position: 'relative' },
  repeatTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    backgroundColor: colors.card2,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  repeatTriggerText: { color: colors.text, fontSize: 12 },
  repeatCaret: { color: colors.muted, fontSize: 10 },
  repeatMenu: {
    position: 'absolute',
    // Footer is pinned at the portal's bottom edge, so the menu must open
    // upward — a downward drop is clipped by dropdownPortal's overflow:'hidden'.
    bottom: '100%',
    left: 0,
    zIndex: 30,
    width: 170,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    // Grid area above the footer is ~200px in the flipped-up popover; keep the
    // menu inside it and scroll if a smaller portal leaves even less room.
    maxHeight: 192,
    overflow: 'scroll',
    paddingVertical: 3,
    shadowColor: colors.black,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  repeatItem: { paddingVertical: 4, paddingHorizontal: 10 },
  repeatItemText: { color: colors.text, fontSize: 12 },
  repeatItemActive: { color: colors.indigo, fontWeight: '700' },
  repeatMake: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 12,
    marginLeft: 'auto',
  },
  repeatMakeText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  repeatStop: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginLeft: 'auto',
    backgroundColor: colors.card,
  },
  repeatStopText: { color: colors.redFg, fontSize: 12, fontWeight: '600' },
});
