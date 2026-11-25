/**
 * "Categorize" (`/categorize`, mock ev-2d6f08 / ev-9784fa): the header with
 * the confidence threshold and the classification run, the Bundles view, and
 * the manual queue behind "One by one" / "Categorize by hand".
 */

import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useBudgetShell } from '@/shell/context';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { ActionToast, SettingsCardFailed } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { pendingSkips, toastActionable } from './accept.logic';
import { BundlesView } from './BundlesView';
import { ErrorBanner } from './CategorizeBits';
import { EmptyState, NoKeyBanner } from './EmptyState';
import { HeaderCard } from './HeaderCard';
import { t } from './i18n';
import { OneByOneView } from './OneByOneView';
import { PendingSkipsStrip } from './PendingSkipsStrip';
import { pageKey } from './page.logic';
import { useBlurAfterPointerPress, useFieldFocused } from './useCategorizeKeys';
import { useCategorizePage, type CategorizeViewMode } from './useCategorizePage';

/**
 * Keyed by the active budget: switching budget in place (Settings, Open budget)
 * remounts the page, so its queue focus, filed lines, undo stack, pending skips
 * (cancelled, never sent, by the unmount) and toasts all belong to ONE budget.
 */
export function CategorizeScreen() {
  const budgetId = useAppSelector(selectActiveBudgetId);
  return <CategorizePage key={pageKey(budgetId)} />;
}

function CategorizePage() {
  const shell = useBudgetShell();
  const router = useRouter();
  const rootRef = useRef<ViewInstance>(null);
  const page = useCategorizePage(rootRef);
  useBlurAfterPointerPress();
  const fieldFocused = useFieldFocused();
  const counts = page.queue.counts;
  const hasBundles = (page.viewModel?.acceptAllCount ?? 0) > 0;
  const noKey = page.statusLoaded && !page.aiAvailable;
  // The empty state is for "no key AND nothing to show": existing suggestions stay reachable.
  const empty = noKey && page.view === 'bundles' && page.queue.data !== undefined && !hasBundles;
  const showNoKeyBanner = noKey && page.view === 'bundles' && hasBundles;

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
          run={page.runView}
          aiAvailable={page.aiAvailable}
          runStarting={page.runStarting}
          onRun={() => void page.startRun()}
          onModalChange={page.setModalOpen}
          left={counts?.left_to_categorize}
        />

        {page.error ? <ErrorBanner message={page.error} onDismiss={page.dismissError} /> : null}

        {page.queue.isLoading ? <Text style={styles.note}>{t('queue.loading')}</Text> : null}
        {page.queue.isError && !page.queue.data ? (
          <SettingsCardFailed
            message={t('queue.failed')}
            retryLabel={tCommon('retry')}
            onRetry={page.retryQueue}
          />
        ) : null}

        {empty ? (
          <EmptyState
            reason={page.aiReason}
            count={counts?.left_to_categorize}
            onAddKey={() => router.push('/ai-keys')}
            onByHand={() => page.setView('one')}
          />
        ) : null}

        {showNoKeyBanner ? (
          <NoKeyBanner reason={page.aiReason} onAddKey={() => router.push('/ai-keys')} />
        ) : null}

        {page.view === 'bundles' ? (
          <PendingSkipsStrip skips={pendingSkips(page.accept.state)} onCancel={page.cancelSkip} />
        ) : null}

        {page.reloading ? <Text style={styles.note}>{t('queue.updating')}</Text> : null}
        <View pointerEvents={page.reloading ? 'none' : 'auto'} style={page.reloading ? styles.reloading : undefined}>

        {!empty && page.viewModel && page.view === 'bundles' ? (
          <BundlesView
            budgetId={page.budgetId}
            view={page.viewModel}
            manualRows={page.manualRows}
            manualCount={page.viewModel.manualCount}
            threshold={page.threshold}
            idle={page.accept.idle && !page.reloading}
            goneBundleKeys={page.accept.goneBundleKeys}
            bundleChangeTick={page.accept.bundleChangeTick}
            onAcceptBundle={(bundle, rows) => void page.accept.acceptBundle(bundle, rows)}
            onAcceptAll={() => void page.accept.acceptAll(page.viewModel?.all ?? [])}
            onFileRow={(row, suggestion) => void page.accept.fileRow(row, suggestion)}
            onPickCategory={(row, category) => void page.accept.pickCategory(row, category)}
          />
        ) : null}

        {!empty && page.view === 'one' && page.queue.data ? (
          <OneByOneView
            budgetId={page.budgetId}
            flow={page.oneByOne}
            total={counts?.left_to_categorize ?? 0}
            loadedRows={page.queue.data.rows.length}
          />
        ) : null}

        </View>

        {page.view === 'bundles' && page.aiAvailable && page.viewModel && page.viewModel.acceptAllCount === 0 && counts?.left_to_categorize === 0 ? (
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
  headText: { gap: 3 },
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
});
