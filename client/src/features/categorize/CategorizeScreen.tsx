/**
 * "Categorize" (`/categorize`, mock ev-2d6f08 / ev-9784fa): the header with
 * the confidence threshold, the Bundles view, and
 * the manual queue behind "One by one" / "Categorize by hand".
 */

import { useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useGetBudgetsQuery } from '@/budget/data/api';
import { TransferToast } from '@/features/transfers';
import { useBudgetShell } from '@/shell/context';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { ActionToast, SettingsCardFailed } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { pendingSkips, toastActionable } from './accept.logic';
import { BundlesView } from './BundlesView';
import { ErrorBanner } from './CategorizeBits';
import { HeaderCard } from './HeaderCard';
import { RunCard } from './RunCard';
import { t } from './i18n';
import { OneByOneView } from './OneByOneView';
import { PendingSkipsStrip } from './PendingSkipsStrip';
import { pageKey } from './page.logic';
import { useBlurAfterPointerPress, useFieldFocused } from './useCategorizeKeys';
import { useCategorizeRun } from './useCategorizeRun';
import { useCategorizePage, type CategorizeViewMode } from './useCategorizePage';
import { TransferSection } from './TransferSection';

/**
 * Keyed by the active budget: switching budget in place (Settings, Open budget)
 * remounts the page, so its queue focus, filed lines, undo stack, strip and
 * toasts all belong to ONE budget. Rows still in the strip are handed to the
 * leave prompt (Send and leave / Keep them and leave / Stay) by the unmount.
 */
export function CategorizeScreen() {
  const budgetId = useAppSelector(selectActiveBudgetId);
  return <CategorizePage key={pageKey(budgetId)} />;
}

function CategorizePage() {
  const shell = useBudgetShell();
  const rootRef = useRef<ViewInstance>(null);
  const page = useCategorizePage(rootRef);
  useBlurAfterPointerPress();
  const fieldFocused = useFieldFocused();
  const counts = page.queue.counts;
  const run = useCategorizeRun({ budgetId: page.budgetId, onFinished: page.refresh });
  // A run uses the budget owner's Jev key, so a member is told to ask them.
  const isOwner = useGetBudgetsQuery().data?.find((row) => row.id === page.budgetId)?.is_owner ?? false;

  return (
    <View ref={rootRef} style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={styles.title}>{t('screen.title')}</Text>
            {page.queue.subtitle ? <Text style={styles.subtitle}>{page.queue.subtitle}</Text> : null}
          </View>
          <ViewSegments view={page.view} onChange={page.setView} />
        </View>

        <HeaderCard
          threshold={page.threshold}
          onThreshold={(value) => void page.commitThreshold(value)}
          thresholdDisabled={page.savingThreshold}
          left={counts?.left_to_categorize}
        />

        <RunCard run={run} isOwner={isOwner} />

        {page.error ? <ErrorBanner message={page.error} onDismiss={page.dismissError} /> : null}

        {page.queue.isLoading ? <Text style={styles.note}>{t('queue.loading')}</Text> : null}
        {page.queue.isError && !page.queue.data ? (
          <SettingsCardFailed
            message={t('queue.failed')}
            retryLabel={tCommon('retry')}
            onRetry={page.refresh}
          />
        ) : null}

        <PendingSkipsStrip
          skips={pendingSkips(page.accept.state)}
          onCancel={page.cancelSkip}
          onDone={() => void page.accept.sendSkips()}
          busy={!page.accept.idle}
        />

        {page.reloading ? <Text style={styles.note}>{t('queue.updating')}</Text> : null}
        <View pointerEvents={page.reloading ? 'none' : 'auto'} style={page.reloading ? styles.reloading : undefined}>

        {page.view === 'bundles' ? (
          <TransferSection budgetId={page.budgetId} transfers={page.transfers} isPhone={!shell.isDesktop} />
        ) : null}

        {page.viewModel && page.view === 'bundles' ? (
          <BundlesView
            budgetId={page.budgetId}
            view={page.viewModel}
            manualRows={page.manualRows}
            manualCount={page.viewModel.manualCount}
            threshold={page.threshold}
            idle={page.accept.idle && !page.reloading}
            hiddenIds={page.hiddenIds}
            goneBundleKeys={page.accept.goneBundleKeys}
            bundleChangeTick={page.accept.bundleChangeTick}
            onAcceptBundle={(bundle, rows) => void page.accept.acceptBundle(bundle, rows)}
            onPickBundleCategory={(bundle, category) => void page.accept.pickBundleCategory(bundle, category)}
            onAcceptAll={() => void page.accept.acceptAll(page.viewModel?.all ?? [])}
            onFileRow={(row, suggestion) => void page.accept.fileRow(row, suggestion)}
            onPickCategory={(row, category) => void page.accept.pickCategory(row, category)}
            onShowAll={page.loadAllRows}
            loadingAll={page.growing}
          />
        ) : null}

        {page.view === 'one' && page.queue.data ? (
          <OneByOneView
            budgetId={page.budgetId}
            flow={page.oneByOne}
            queueLeft={counts?.left_to_categorize ?? 0}
            matcherPairs={page.transfers.matcher.length}
            loadedRows={page.queue.data.rows.length}
          />
        ) : null}

        </View>

        {page.view === 'bundles' &&
        page.viewModel &&
        page.viewModel.acceptAllCount === 0 &&
        counts?.left_to_categorize === 0 &&
        page.transfers.items.length === 0 &&
        page.transfers.matcher.length === 0 ? (
          <Text style={styles.note}>{t('queue.empty')}</Text>
        ) : null}
      </ScrollView>

      {page.accept.state.toast ? (
        <ActionToast
          message={page.accept.state.toast.label}
          leading={toastIsPendingSkip(page.accept.state) ? null : '✓'}
          actionLabel={toastActionable(page.accept.state) ? t('undo') : undefined}
          actionKey={page.view === 'one' && Platform.OS === 'web' && !fieldFocused ? 'Z' : undefined}
          onAction={page.undoLast}
        />
      ) : null}
      {/*
       * The matcher's own toast (linked · Undo) lives at screen level, outside
       * the scroll: it must stay put while the page scrolls. The shell's
       * floating + Transaction pill is hidden on this route, so the only thing
       * it must clear is the accept toast: when both are up, this one goes above
       * it instead of over it.
       */}
      {page.transfers.matcherState.toast ? (
        <View
          pointerEvents="box-none"
          style={[styles.toastHost, page.accept.state.toast ? styles.toastHostStacked : null]}>
          <TransferToast toast={page.transfers.matcherState.toast} />
        </View>
      ) : null}
    </View>
  );
}

/** A pending skip has not happened yet, so its toast carries no check mark. */
function toastIsPendingSkip(state: Parameters<typeof toastActionable>[0]): boolean {
  const seq = state.toast?.seq;
  return state.stack.some((entry) => entry.kind === 'skip' && entry.seq === seq);
}

function ViewSegments({ view, onChange }: { view: CategorizeViewMode; onChange: (view: CategorizeViewMode) => void }) {
  const options: { id: CategorizeViewMode; label: string }[] = [
    { id: 'bundles', label: t('view.bundles') },
    { id: 'one', label: t('view.oneByOne') },
  ];
  return (
    <View style={styles.segments}>
      {options.map((option) => {
        const active = option.id === view;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}>
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 22, paddingBottom: 88, gap: 14, width: '100%', maxWidth: 1400, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
  headText: { gap: 3, flexBasis: 260, flexGrow: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { color: colors.muted, fontSize: 12.5 },
  segments: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 3,
  },
  segment: { paddingVertical: 7, paddingHorizontal: 18, borderRadius: radius.field6 },
  segmentActive: { backgroundColor: colors.indigo },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: colors.white },
  reloading: { opacity: 0.45 },
  note: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
  /** The matcher's toast host: full-bleed, so the toast keeps its own placement. */
  toastHost: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  /** Both toasts at once: the matcher's goes above the accept one (≈38 + 18 gap) instead of over it. */
  toastHostStacked: { bottom: 64 },
});
