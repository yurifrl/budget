/**
 * The right side of the One by one view: the transaction in focus (payee,
 * amount, date, account, memo, the bank's raw text and the merchant panel),
 * up to three suggestion cards, the category search and the actions. Key hints
 * show on web only; the keys themselves live in useCategorizeKeys.
 */

import type { Ref } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import type { CategorizeQueueRow } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';

import { CategoryPicker, KeyButton, KeyCap, PayeeDot } from './CategorizeBits';
import { t } from './i18n';
import { MerchantPanel } from './MerchantPanel';
import { thresholdPercent, type PickedCategory } from './page.logic';
import { confidenceBand, merchantFacts, manualStateLabel, topSuggestions, type ConfidenceBand } from './queue.logic';

const SHOW_KEYS = Platform.OS === 'web';

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.greenPillFg,
  mid: colors.yellowPillFg,
  low: colors.muted,
};

export function FocusPane({
  row,
  budgetId,
  canUndo,
  searchRef,
  onFile,
  onPick,
  onSkip,
  onUndo,
}: {
  row: CategorizeQueueRow;
  budgetId: string | null;
  canUndo: boolean;
  searchRef: Ref<TextInputInstance>;
  onFile: (index: number) => void;
  onPick: (category: PickedCategory) => void;
  onSkip: () => void;
  onUndo: () => void;
}) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const suggestions = topSuggestions(row.suggestions);
  const top = suggestions[0];
  const payee = row.payee?.trim() || t('row.unnamed');
  const raw = row.raw_bank_description?.trim();
  const facts = merchantFacts(row.merchant, row.payee);
  const memo = row.memo?.trim();
  const cents = milliToCents(row.amount);

  return (
    <View style={styles.pane}>
      <View style={styles.card}>
        <View style={styles.head}>
          <PayeeDot name={payee} size={40} />
          <View style={styles.headText}>
            <Text style={styles.payee} numberOfLines={2}>
              {payee}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {row.account_name} · {formatDate(row.date)}
            </Text>
          </View>
          <Text style={[styles.amount, cents < 0 ? styles.out : styles.in]}>{formatMoney(cents)}</Text>
        </View>
        <View style={styles.body}>
          <View style={styles.facts}>
            <View style={styles.grid}>
              <Field label={t('one.date')} value={formatDate(row.date)} />
              <Field label={t('one.account')} value={row.account_name} />
              <Field label={t('one.memo')} value={memo || t('one.noMemo')} />
            </View>
            {raw ? (
              <View style={styles.rawWrap}>
                <Text style={styles.label}>{t('one.raw')}</Text>
                <View style={styles.rawBox}>
                  <Text style={styles.raw} selectable>
                    {raw}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
          <MerchantPanel facts={facts} />
        </View>
      </View>

      <Text style={styles.sectionLabel}>{suggestions.length > 0 ? t('one.suggestions') : t('one.manualOnly')}</Text>
      {suggestions.length > 0 ? (
        <View style={styles.cards}>
          {suggestions.map((suggestion, index) => {
            const percent = thresholdPercent(suggestion.confidence);
            return (
              <Pressable
                key={`${suggestion.category_id}-${index}`}
                onPress={() => onFile(index)}
                accessibilityRole="button"
                accessibilityLabel={t('one.suggestionA11y', {
                  rank: index + 1,
                  category: suggestion.category_name,
                  percent,
                })}
                style={[styles.suggestion, index === 0 && styles.suggestionTop]}>
                <View style={styles.suggestionHead}>
                  {SHOW_KEYS ? <KeyCap label={String(index + 1)} /> : null}
                  <Text style={styles.suggestionName} numberOfLines={1}>
                    {suggestion.category_name}
                  </Text>
                  <Text style={[styles.percent, { color: BAND_COLOR[confidenceBand(suggestion.confidence)] }]}>
                    {percent}%
                  </Text>
                </View>
                {suggestion.reason ? (
                  <Text style={styles.reason} numberOfLines={3}>
                    {suggestion.reason}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={styles.why}>{t('one.stateHint', { state: manualStateLabel(row.state) })}</Text>
      )}

      <View style={styles.searchRow}>
        <CategoryPicker
          budgetId={budgetId}
          label={t('row.chooseA11y', { payee })}
          onPick={onPick}
          placeholder={suggestions.length > 0 ? t('one.search') : t('one.searchFirst')}
          inputRef={searchRef}
          style={styles.search}
        />
        {SHOW_KEYS ? <KeyCap label="/" style={styles.searchKey} /> : null}
      </View>

      <View style={styles.actions}>
        {top ? (
          <KeyButton
            primary
            label={t('one.confirm', { category: top.category_name })}
            keyLabel={SHOW_KEYS ? t('one.keys.enterKey') : undefined}
            onPress={() => onFile(0)}
          />
        ) : null}
        <KeyButton label={t('one.skip')} keyLabel={SHOW_KEYS ? 'S' : undefined} onPress={onSkip} />
        <View style={styles.spacer} />
        <KeyButton
          label={t('one.undoLast')}
          keyLabel={SHOW_KEYS ? 'Z' : undefined}
          onPress={onUndo}
          disabled={!canUndo}
        />
      </View>
      <Text style={styles.skipHint}>{t('one.skipHint')}</Text>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.fieldValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// eslint-disable-next-line budget-i18n/no-untranslated-string -- font family names, not UI text
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });

const styles = StyleSheet.create({
  pane: { flex: 1, minWidth: 0, gap: 12 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, flexWrap: 'wrap' },
  headText: { flex: 1, minWidth: 180, gap: 2 },
  payee: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  sub: { color: colors.muted, fontSize: 12.5 },
  amount: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  out: { color: colors.redFg },
  in: { color: colors.greenPillFg },
  body: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  facts: { flexGrow: 2, flexBasis: 320, minWidth: 240, gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 12 },
  field: { minWidth: 140, flexGrow: 1, flexBasis: 140, gap: 3 },
  label: { color: colors.faint, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 },
  fieldValue: { color: colors.text, fontSize: 13.5 },
  rawWrap: { gap: 5 },
  rawBox: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.field6,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  raw: { color: colors.text, fontFamily: mono, fontSize: 12 },
  sectionLabel: { color: colors.faint, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, marginTop: 4 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  suggestion: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 180,
    minHeight: 76,
    gap: 6,
    padding: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
  },
  suggestionTop: { backgroundColor: colors.indigoSoft, borderColor: colors.indigo2, borderWidth: 1.5 },
  suggestionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  suggestionName: { color: colors.text, fontSize: 14.5, fontWeight: '700', flex: 1 },
  percent: { fontSize: 12.5, fontWeight: '700' },
  reason: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  why: { color: colors.muted, fontSize: 13 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 30 },
  search: { flex: 1, minWidth: 0 },
  searchKey: { position: 'absolute', right: 10, zIndex: 31 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  spacer: { flexGrow: 1 },
  skipHint: { color: colors.faint, fontSize: 11.5 },
});
