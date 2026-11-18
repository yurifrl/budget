/**
 * xvu scope C: YNAB-parity toolbar — left-aligned actions + right density
 * toggles — with its Views menu, the Recent Moves popover and the filter chips.
 */
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { formatMonth } from '../../domain/format';
import { formatPlanEditAge } from '../../state/planEdits';
import {
  selectPlanFilter,
  selectShowHiddenCategories,
  selectShowProgressBars,
  setPlanFilter,
  toggleHiddenCategories,
  toggleProgressBars,
  type PlanFilter,
} from '../../state/ui';
import { ChevronDownIcon, PlusCircleIcon, RedoIcon, UndoIcon } from '../../ui/icons';
import { colors } from '../../ui/theme';
import { InlineAddRow } from './InlineAddRow';
import { recentCardPosition } from './planGeometry.logic';
import { styles } from './styles';
import type { PlanGrid } from './types';

const FILTERS: { key: PlanFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'underfunded', label: 'Underfunded' },
  { key: 'overfunded', label: 'Overfunded' },
  { key: 'money-available', label: 'Money Available' },
  { key: 'snoozed', label: 'Snoozed' },
];

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
          accessibilityLabel="Add category group"
          onPress={() => add.setAddingGroup('toolbar')}>
          <PlusCircleIcon color="#fff" />
          <Text style={styles.toolbarAddText}>Category Group</Text>
        </Pressable>
        {add.addingGroup === 'toolbar' ? (
          <InlineAddRow
            placeholder="Group name"
            accessibilityLabel="New group name"
            onCommit={add.commitAddGroup}
            onCancel={() => add.setAddingGroup(null)}
          />
        ) : null}
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Undo last plan edit"
          disabled={!undo.canUndo}
          onPress={undoLastEdit}>
          <UndoIcon color={undo.canUndo ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !undo.canUndo && styles.viewsBtnDisabled]}>
            Undo
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Redo last plan edit"
          disabled={!undo.canRedo}
          onPress={redoLastEdit}>
          <RedoIcon color={undo.canRedo ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !undo.canRedo && styles.viewsBtnDisabled]}>
            Redo
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Recent moves"
          onPress={(e) => {
            if (recentOpen) setRecentOpen(null);
            else {
              const px = e.nativeEvent.pageX;
              const py = e.nativeEvent.pageY;
              anchorAt(px, py, (x, y) => setRecentOpen({ x, y }));
            }
          }}>
          <Text style={styles.toolbarLinkText}>🕐 Recent Moves</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          style={styles.viewsBtn}
          accessibilityLabel="Views menu"
          onPress={() => overlays.setViewsOpen((v) => !v)}>
          <Text style={styles.viewsBtnText}>Views</Text>
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
          accessibilityLabel="Toggle progress bars"
          onPress={() => dispatch(toggleProgressBars())}>
          <Text style={styles.menuItemText}>
            {showProgressBars ? '✓ ' : '   '}Barras de progresso
          </Text>
        </Pressable>
        <Pressable
          style={styles.menuItem}
          accessibilityLabel="Toggle hidden categories row"
          onPress={() => dispatch(toggleHiddenCategories())}>
          <Text style={styles.menuItemText}>
            {showHiddenRow ? '✓ ' : '   '}Categorias ocultas
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
        <Text style={styles.menuTitle}>RECENT MOVES</Text>
        {undo.recentMoves.length === 0 ? (
          <Text style={[styles.menuItemText, styles.recentAge]}>No moves yet</Text>
        ) : (
          undo.recentMoves.map((e) => (
            <Pressable
              key={e.id}
              style={styles.menuItem}
              accessibilityLabel={`Revert ${e.label}`}
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
      {FILTERS.map((f) => (
        <Pressable
          key={f.key}
          onPress={() => dispatch(setPlanFilter(f.key))}
          style={[styles.chip, filter === f.key && styles.chipActive]}>
          <Text style={[styles.chipText, filter === f.key && { color: '#fff' }]}>{f.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
