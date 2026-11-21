/**
 * xvu scope C: YNAB-parity toolbar — left-aligned actions + right density
 * toggles — with its Views menu, the Recent Moves popover and the filter chips.
 */
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { formatMonth } from '@/domain/format';
import { labels } from '@shared/i18n';
import { formatPlanEditAge } from '@/state/planEdits';
import {
  selectPlanFilter,
  selectShowHiddenCategories,
  selectShowProgressBars,
  setPlanFilter,
  toggleHiddenCategories,
  toggleProgressBars,
  type PlanFilter,
} from '@/state/ui';
import { ChevronDownIcon, PlusCircleIcon, RedoIcon, UndoIcon } from '@/ui/icons';
import { colors } from '@/ui/theme';
import { t } from './i18n';
import { InlineAddRow } from './InlineAddRow';
import { recentCardPosition } from './planGeometry.logic';
import { styles } from './styles';
import type { PlanGrid } from './types';

const FILTERS: PlanFilter[] = ['all', 'underfunded', 'overfunded', 'money-available', 'snoozed'];
/** Chip labels, resolved when read so they follow the active language. */
const FILTER_LABELS: Record<PlanFilter, string> = labels(t, {
  all: 'filter.all',
  underfunded: 'filter.underfunded',
  overfunded: 'filter.overfunded',
  'money-available': 'filter.moneyAvailable',
  snoozed: 'filter.snoozed',
});

type ToolbarGrid = Pick<PlanGrid, 'month' | 'add' | 'undo' | 'overlays' | 'anchorAt'>;

export function PlanToolbar({ grid }: { grid: ToolbarGrid }) {
  const { add, undo, overlays, anchorAt } = grid;
  const { recentOpen, setRecentOpen } = overlays;
  const undoLastEdit = () => {
    setRecentOpen(null);
    undo.undo();
  };
  const redoLastEdit = () => {
    setRecentOpen(null);
    undo.redo();
  };
  return (
    <>
      <View style={styles.toolbar}>
        <Pressable
          style={styles.toolbarAdd}
          accessibilityRole="button"
          accessibilityLabel={t('group.addLabel')}
          onPress={() => add.setAddingGroup('toolbar')}>
          <PlusCircleIcon color={colors.white} />
          <Text style={styles.toolbarAddText}>{t('toolbar.addGroup')}</Text>
        </Pressable>
        {add.addingGroup === 'toolbar' ? (
          <InlineAddRow
            placeholder={t('group.newPlaceholder')}
            accessibilityLabel={t('group.newLabel')}
            onCommit={add.commitAddGroup}
            onCancel={() => add.setAddingGroup(null)}
          />
        ) : null}
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel={t('toolbar.undoLabel')}
          disabled={!undo.canUndo}
          onPress={undoLastEdit}>
          <UndoIcon color={undo.canUndo ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !undo.canUndo && styles.viewsBtnDisabled]}>
            {t('toolbar.undo')}
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel={t('toolbar.redoLabel')}
          disabled={!undo.canRedo}
          onPress={redoLastEdit}>
          <RedoIcon color={undo.canRedo ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !undo.canRedo && styles.viewsBtnDisabled]}>
            {t('toolbar.redo')}
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel={t('toolbar.recentLabel')}
          onPress={(e) => {
            if (recentOpen) setRecentOpen(null);
            else {
              const px = e.nativeEvent.pageX;
              const py = e.nativeEvent.pageY;
              anchorAt(px, py, (x, y) => setRecentOpen({ x, y }));
            }
          }}>
          <Text style={styles.toolbarLinkText}>{t('toolbar.recent')}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          style={styles.viewsBtn}
          accessibilityLabel={t('toolbar.viewsLabel')}
          onPress={() => overlays.setViewsOpen((v) => !v)}>
          <Text style={styles.viewsBtnText}>{t('toolbar.views')}</Text>
          <ChevronDownIcon color={colors.text} />
        </Pressable>
      </View>

      {overlays.viewsOpen ? <ViewsMenu onClose={() => overlays.setViewsOpen(false)} /> : null}
      {recentOpen ? <RecentMovesCard grid={grid} anchor={recentOpen} /> : null}
      <PlanFilterChips />
    </>
  );
}

function ViewsMenu({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const showProgressBars = useAppSelector((s) => selectShowProgressBars(s));
  const showHiddenRow = useAppSelector((s) => selectShowHiddenCategories(s));
  return (
    <Pressable style={styles.menuBackdrop} onPress={onClose}>
      <Pressable style={styles.viewsCard} onPress={() => undefined}>
        <Pressable
          style={styles.menuItem}
          accessibilityLabel={t('views.progressLabel')}
          onPress={() => dispatch(toggleProgressBars())}>
          <Text style={styles.menuItemText}>
            {showProgressBars ? '✓ ' : '   '}{t('views.progress')}
          </Text>
        </Pressable>
        <Pressable
          style={styles.menuItem}
          accessibilityLabel={t('views.hiddenLabel')}
          onPress={() => dispatch(toggleHiddenCategories())}>
          <Text style={styles.menuItemText}>
            {showHiddenRow ? '✓ ' : '   '}{t('views.hidden')}
          </Text>
        </Pressable>
      </Pressable>
    </Pressable>
  );
}

function RecentMovesCard({ grid, anchor }: { grid: ToolbarGrid; anchor: { x: number; y: number } }) {
  const { month, undo, overlays } = grid;
  const dims = useWindowDimensions();
  return (
    <Pressable style={styles.menuBackdrop} onPress={() => overlays.setRecentOpen(null)}>
      <Pressable
        onPress={() => undefined}
        style={[styles.viewsCard, styles.recentCard, recentCardPosition(anchor, dims.width)]}>
        <Text style={styles.menuTitle}>{t('recent.title')}</Text>
        {undo.recentMoves.length === 0 ? (
          <Text style={[styles.menuItemText, styles.recentAge]}>{t('recent.empty')}</Text>
        ) : (
          undo.recentMoves.map((e) => (
            <Pressable
              key={e.id}
              style={styles.menuItem}
              accessibilityLabel={t('recent.revert', { label: e.label })}
              onPress={() => undo.revert(e.id)}>
              <View style={styles.recentRow}>
                <Text style={styles.menuItemText} numberOfLines={1}>
                  {e.label}
                  {e.month !== month ? ` · ${formatMonth(e.month)}` : ''}
                </Text>
                <Text style={styles.recentAge}>{formatPlanEditAge(e.at)}</Text>
              </View>
            </Pressable>
          ))
        )}
      </Pressable>
    </Pressable>
  );
}

function PlanFilterChips() {
  const dispatch = useAppDispatch();
  const filter = useAppSelector((s) => selectPlanFilter(s));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: 8 }}>
      {FILTERS.map((key) => (
        <Pressable
          key={key}
          onPress={() => dispatch(setPlanFilter(key))}
          style={[styles.chip, filter === key && styles.chipActive]}>
          <Text style={[styles.chipText, filter === key && { color: colors.white }]}>{FILTER_LABELS[key]}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
