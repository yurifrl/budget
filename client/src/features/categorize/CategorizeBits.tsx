/**
 * Small presentational pieces of the Categorize page, shared by both views:
 * the confidence chip (the shared TagPill with a numeric band), the category
 * search (the register's Combobox over the assignable categories), the payee
 * initial dot, and the inline error banner.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useState, type Ref } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextInputInstance,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { tCommon } from '@shared/i18n/common';

import {
  useGetBundlesQuery,
  useGetCategoriesQuery,
  useGetGroupsQuery,
  type CategorizeSuggestion,
} from '@/budget/data/api';
import { Combobox } from '@/ui/combobox';
import { TagPill, type TagTone } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import { categoryOptions, thresholdPercent, type PickedCategory } from './page.logic';
import { confidenceBand, type ConfidenceBand } from './queue.logic';

const TONE: Record<ConfidenceBand, TagTone> = {
  high: 'green',
  mid: 'yellow',
  low: 'gray',
};

/** "Transport 93%", colored by the mock's confidence bands. */
export function ConfidenceChip({
  suggestion,
  onPress,
  style,
}: {
  suggestion: Pick<CategorizeSuggestion, 'category_name' | 'confidence'>;
  /** When set, pressing files the transaction with this suggestion. */
  onPress?: () => void;
  style?: StyleProp<TextStyle>;
}) {
  const percent = thresholdPercent(suggestion.confidence);
  const label = t('chip.label', { category: suggestion.category_name, percent });
  const chip = (
    <TagPill
      label={label}
      tone={TONE[confidenceBand(suggestion.confidence)]}
      numberOfLines={1}
      style={[styles.chip, style]}
    />
  );
  if (!onPress) return chip;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('chip.a11y', { category: suggestion.category_name, percent })}
      hitSlop={4}>
      {chip}
    </Pressable>
  );
}

/**
 * Just the confidence number ("93%"), same bands. The bundle header pairs it
 * with a category picker, so the category lives in the picker, not the chip.
 */
export function ConfidencePercent({ confidence, style }: { confidence: number; style?: StyleProp<TextStyle> }) {
  const percent = thresholdPercent(confidence);
  return (
    <View accessible accessibilityLabel={t('chip.percentA11y', { percent })}>
      <TagPill
        label={t('chip.percent', { percent })}
        tone={TONE[confidenceBand(confidence)]}
        numberOfLines={1}
        style={[styles.chip, style]}
      />
    </View>
  );
}

const DOT_PALETTE: readonly { bg: string; fg: string }[] = [
  { bg: colors.indigoSoft, fg: colors.indigo3 },
  { bg: colors.greenPillBg, fg: colors.greenPillFg },
  { bg: colors.yellowPillBg, fg: colors.yellowPillFg },
  { bg: colors.bluePillBg, fg: colors.blue },
  { bg: colors.redPillBg, fg: colors.redFg },
  { bg: colors.grayPillBg, fg: colors.grayPillFg },
];

/** A payee's initial in a colored circle (there is no payee avatar in budget data). */
export function PayeeDot({ name, size = 28 }: { name: string; size?: number }) {
  const letter = name.trim().charAt(0).toUpperCase() || '?';
  const code = letter.charCodeAt(0);
  const tone = DOT_PALETTE[code % DOT_PALETTE.length]!;
  return (
    <View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg }]}>
      <Text style={[styles.dotLetter, { color: tone.fg, fontSize: Math.round(size * 0.5) }]}>{letter}</Text>
    </View>
  );
}

/** The register's Combobox over the assignable categories (no create, no transfer). */
export function CategoryPicker({
  budgetId,
  onPick,
  disabled,
  style,
  label,
  placeholder,
  inputRef,
}: {
  budgetId: string | null;
  onPick: (category: PickedCategory) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Row-specific accessible name (e.g. "Choose a category for Uber"). */
  label?: string;
  placeholder?: string;
  inputRef?: Ref<TextInputInstance>;
}) {
  const scope = budgetId ? { budgetId } : skipToken;
  const categories = useGetCategoriesQuery(scope);
  const groups = useGetGroupsQuery(scope);
  const bundles = useGetBundlesQuery(scope);
  const [draft, setDraft] = useState('');

  const options = categoryOptions(categories.data ?? [], groups.data ?? [], bundles.data ?? []).map((o) => ({
    key: o.id,
    label: o.label,
    sub: o.sub || undefined,
  }));

  return (
    <Combobox
      value={draft}
      onChangeText={setDraft}
      options={disabled ? [] : options}
      onPick={(key) => {
        const picked = options.find((o) => o.key === key);
        setDraft('');
        if (picked) onPick({ id: picked.key, label: picked.label });
      }}
      placeholder={placeholder ?? t('row.chooseCategory')}
      inputRef={inputRef}
      accessibilityLabel={label ?? t('row.chooseCategory')}
      containerStyle={[styles.picker, style]}
    />
  );
}

/** A keyboard key drawn as a small cap: "1", "Enter", "S". */
export function KeyCap({
  label,
  style,
  onPrimary,
}: {
  label: string;
  style?: StyleProp<ViewStyle>;
  /** Drawn on an indigo button: lighter cap, white text. */
  onPrimary?: boolean;
}) {
  return (
    <View style={[styles.keyCap, onPrimary && styles.keyCapOnPrimary, style]} accessible={false}>
      <Text style={[styles.keyCapText, onPrimary && styles.keyCapTextOnPrimary]}>{label}</Text>
    </View>
  );
}

/** A button with its key hint on the right ("Skip  S"). */
export function KeyButton({
  label,
  keyLabel,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  /** The shortcut shown on the button; omitted where there is no keyboard. */
  keyLabel?: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.keyButton, primary && styles.keyButtonPrimary, disabled && styles.keyButtonOff]}>
      <Text style={[styles.keyButtonText, primary && styles.keyButtonTextPrimary]} numberOfLines={1}>
        {label}
      </Text>
      {keyLabel ? <KeyCap label={keyLabel} onPrimary={primary} /> : null}
    </Pressable>
  );
}

/** Inline failure line with a dismiss control; the page keeps one at a time. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <View style={styles.error} accessibilityLiveRegion="polite">
      <Text style={styles.errorText}>{message}</Text>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={tCommon('close')} hitSlop={6}>
        <Text style={styles.errorClose}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  keyCap: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 5,
  },
  keyCapText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  keyCapOnPrimary: { backgroundColor: colors.indigo2, borderColor: colors.indigo3 },
  keyCapTextOnPrimary: { color: colors.white },
  keyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    maxWidth: '100%',
  },
  keyButtonPrimary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  keyButtonOff: { opacity: 0.45 },
  keyButtonText: { color: colors.text, fontSize: 13.5, fontWeight: '700', flexShrink: 1 },
  keyButtonTextPrimary: { color: colors.white },
  chip: { fontSize: 12, fontWeight: '700', paddingVertical: 4, paddingHorizontal: 10 },
  dot: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dotLetter: { fontWeight: '800' },
  picker: { minWidth: 132 },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.redPillBg,
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  errorText: { color: colors.redFg, fontSize: 13, fontWeight: '600', flex: 1 },
  errorClose: { color: colors.redFg, fontSize: 18, fontWeight: '700', lineHeight: 20 },
});
