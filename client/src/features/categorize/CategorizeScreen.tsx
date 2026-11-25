/**
 * "Categorize" (`/categorize`, mock ev-2d6f08 / ev-9784fa): the header with
 * the confidence threshold and the classification run, the Bundles view, and
 * the manual queue behind "One by one" / "Categorize by hand".
 */

import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useBudgetShell } from '@/shell/context';
import { ActionToast, SettingsCardFailed } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { BundlesView } from './BundlesView';
import { ErrorBanner } from './CategorizeBits';
import { EmptyState } from './EmptyState';
import { HeaderCard } from './HeaderCard';
import { t } from './i18n';
import { OneByOneView } from './OneByOneView';
import { useCategorizePage, type CategorizeViewMode } from './useCategorizePage';

export function CategorizeScreen() {
  const shell = useBudgetShell();
  const router = useRouter();
  const page = useCategorizePage();
  const counts = page.queue.counts;
  const empty = page.statusLoaded && !page.aiAvailable && page.view === 'bundles';

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
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
            reason={page.runView?.detail ?? ''}
            count={counts?.left_to_categorize}
            onAddKey={() => router.push('/ai-keys')}
            onByHand={() => page.setView('one')}
          />
        ) : null}

        {!empty && page.viewModel && page.view === 'bundles' ? (
          <BundlesView
            budgetId={page.budgetId}
            view={page.viewModel}
            manualRows={page.manualRows}
            manualCount={page.viewModel.manualCount}
            threshold={page.threshold}
            idle={page.accept.idle}
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

        {page.view === 'bundles' && page.aiAvailable && page.viewModel && page.viewModel.acceptAllCount === 0 && counts?.left_to_categorize === 0 ? (
          <Text style={styles.note}>{t('queue.empty')}</Text>
        ) : null}
      </ScrollView>

      {page.accept.state.toast ? (
        <ActionToast
          message={page.accept.state.toast.label}
          actionLabel={page.accept.state.toast.transactionIds.length > 0 ? t('undo') : undefined}
          onAction={() => void page.accept.undoLast()}
        />
      ) : null}
    </View>
  );
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
  note: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
});
