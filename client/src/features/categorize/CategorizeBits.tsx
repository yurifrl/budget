/**
 * Small presentational pieces of the Categorize page, shared by both views:
 * the confidence chip (the shared TagPill with a numeric band), the category
 * search (the register's Combobox over the assignable categories), the payee
 * initial dot, and the inline error banner.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

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
}: {
  budgetId: string | null;
  onPick: (category: PickedCategory) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Row-specific accessible name (e.g. "Choose a category for Uber"). */
  label?: string;
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
      placeholder={t('row.chooseCategory')}
      accessibilityLabel={label ?? t('row.chooseCategory')}
      containerStyle={[styles.picker, style]}
    />
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
