/**
 * The Bundles view (mock ev-2d6f08): the accept-all banner, one card per
 * bundle (opened one at a time), the "show more bundles" fold and the
 * "No suggestion" group for manual picks.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CategorizeQueueRow, CategorizeSuggestion } from '@/budget/data/api';
import { GhostButton, IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { BundleCard } from './BundleCard';
import { t } from './i18n';
import { thresholdPercent, type PickedCategory } from './page.logic';
import { QueueRowView } from './QueueRowView';
import type { BundleView, ShownBundle } from './queue.logic';

export function BundlesView({
  budgetId,
  view,
  manualRows,
  manualCount,
  threshold,
  idle,
  hiddenIds,
  goneBundleKeys,
  bundleChangeTick,
  onAcceptBundle,
  onAcceptAll,
  onFileRow,
  onPickCategory,
}: {
  budgetId: string | null;
  view: BundleView;
  manualRows: readonly CategorizeQueueRow[];
  manualCount: number;
  threshold: number;
  idle: boolean;
  hiddenIds: ReadonlySet<string>;
  goneBundleKeys: ReadonlySet<string>;
  bundleChangeTick: number;
  onAcceptBundle: (bundle: ShownBundle, rows: readonly CategorizeQueueRow[]) => void;
  onAcceptAll: () => void;
  onFileRow: (row: CategorizeQueueRow, suggestion: CategorizeSuggestion) => void;
  onPickCategory: (row: CategorizeQueueRow, category: PickedCategory) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // A refused bundle (409) collapses so the card shows its fresh count.
  useEffect(() => {
    if (bundleChangeTick > 0) setExpanded(null);
  }, [bundleChangeTick]);

  // A bundle that left the queue (accepted, or the payee/suggestion changed)
  // must not stay open over a stale key.
  useEffect(() => {
    if (expanded && !view.all.some((bundle) => bundle.bundle_key === expanded)) setExpanded(null);
  }, [expanded, view.all]);

  const cards = (showAll ? view.all : view.shown).filter((bundle) => !goneBundleKeys.has(bundle.bundle_key));
  const hidden = view.hidden.filter((bundle) => !goneBundleKeys.has(bundle.bundle_key));
  const hiddenTransactions = hidden.reduce((sum, bundle) => sum + bundle.count, 0);

  return (
    <View style={styles.wrap}>
      {view.acceptAllCount > 0 && cards.length > 0 ? (
        <View style={styles.banner}>
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle}>
              {t('bundles.acceptAllTitle', {
                count: view.acceptAllCount,
                bundles: view.all.length,
                percent: thresholdPercent(threshold),
              })}
            </Text>
            <Text style={styles.bannerBody}>{t('bundles.acceptAllBody')}</Text>
          </View>
          <IndigoButton
            label={t('bundles.acceptAll', { count: view.acceptAllCount })}
            onPress={onAcceptAll}
            disabled={!idle}
            style={styles.acceptAll}
          />
        </View>
      ) : null}

      {cards.length > 0 ? (
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>{t('bundles.sectionTitle')}</Text>
          <Text style={styles.sectionHint} numberOfLines={1}>
            {t('bundles.sectionHint')}
          </Text>
        </View>
      ) : null}

      <View style={styles.cards}>
        {cards.map((bundle) => (
          <BundleCard
            key={bundle.bundle_key}
            budgetId={budgetId}
            bundle={bundle}
            expanded={expanded === bundle.bundle_key}
            onToggle={() => setExpanded(expanded === bundle.bundle_key ? null : bundle.bundle_key)}
            disabled={!idle}
            hiddenIds={hiddenIds}
            onAccept={onAcceptBundle}
            onFileRow={onFileRow}
            onPickCategory={onPickCategory}
          />
        ))}
      </View>

      {view.hidden.length > 0 ? (
        <View style={styles.fold}>
          <GhostButton
            label={
              showAll
                ? t('bundles.showLess')
                : t('bundles.showMore', { count: hidden.length, transactions: hiddenTransactions })
            }
            onPress={() => setShowAll((open) => !open)}
          />
        </View>
      ) : null}

      {manualCount > 0 ? (
        <View style={styles.manual}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{t('noSuggestion.title')}</Text>
            <Text style={styles.sectionHint} numberOfLines={2}>
              {t('noSuggestion.hint', { count: manualCount, percent: thresholdPercent(threshold) })}
            </Text>
          </View>
          <View style={styles.manualCard}>
            {manualRows.map((row) => (
              <QueueRowView
                key={row.transaction_id}
                row={row}
                budgetId={budgetId}
                disabled={!idle}
                showState
                onFileSuggestion={(suggestion) => onFileRow(row, suggestion)}
                onPickCategory={(category) => onPickCategory(row, category)}
              />
            ))}
            {manualRows.length < manualCount ? (
              <Text style={styles.truncated}>
                {t('noSuggestion.truncated', { shown: manualRows.length, count: manualCount })}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  banner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.greenPillBg,
    borderWidth: 1,
    borderColor: colors.rtaBorder,
    borderRadius: radius.sm,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  bannerText: { flexGrow: 1, flexBasis: 320, gap: 2 },
  bannerTitle: { color: colors.greenPillFg, fontSize: 13, fontWeight: '700' },
  bannerBody: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  acceptAll: { backgroundColor: colors.green, paddingVertical: 10, paddingHorizontal: 16 },
  sectionHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 },
  sectionTitle: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  sectionHint: { color: colors.faint, fontSize: 11, flexShrink: 1 },
  cards: { gap: 8 },
  fold: { alignItems: 'stretch' },
  manual: { gap: 8, marginTop: 8 },
  manualCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  truncated: { color: colors.faint, fontSize: 11, padding: 12 },
});
