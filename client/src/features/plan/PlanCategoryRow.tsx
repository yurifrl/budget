/**
 * Plan grid: one category row — select checkbox, name (or inline rename),
 * ASSIGNED / ACTIVITY / AVAILABLE, drag + drop indicators, funding bar.
 */
import { Pressable, Text, TextInput, View, type MouseEvent } from 'react-native';

import { useAppDispatch } from '@/state/hooks';

import { targetFundingState } from '@/domain/engine';
import { overspendHint } from '@/domain/overspendHints';
import { activityFor, categoryOwnerId, isSharedInPersonView, personFor, personLabel } from '@/domain/people';
import { dropLabel } from '@/domain/planDrop';
import { fundingFraction } from '@/domain/planRow';
import type { Category } from '@/domain/types';
import { categoryFigures } from '@/domain/zeroSum';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { selectCategory } from '@/state/ui';
import { FundingBar } from '@/ui/bits';
import { PersonFace } from '@/ui/PersonFace';
import { colors } from '@/ui/theme';
import { AssignedCell, AvailableCell } from './PlanRowCells';
import { t } from './i18n';
import { styles } from './styles';
import type { PlanGrid } from './types';

export function PlanCategoryRow({ grid, category: c }: { grid: PlanGrid; category: Category }) {
  const { budget, bm, shell, byPerson, selection, menus, numpad, anchorAt, rowRefs } = grid;
  const { drag, dropAt, suppressClickRef, onRowPointerDown } = grid.drag;
  const { formatMoney } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const funding = targetFundingState(c, bm);
  const { available, assigned } = categoryFigures(bm, c.id);
  const hint = overspendHint(bm, c.id, { formatMoney });
  const isSelected = grid.selectedId === c.id;
  const fraction = fundingFraction(funding, available);
  const owner = personFor(byPerson.people, categoryOwnerId(c));
  const isChecked = selection.checkedRows.has(c.id);
  const isDragging = drag?.id === c.id;

  /** Left-click selects the category (inspector panel/slide-over opens);
   * phone taps open the assign numpad sheet instead. */
  const onRowPress = () => {
    if (suppressClickRef.current) return;
    if (shell.isPhone) {
      // qitk (T3): tapping the open row closes the panel (pending draft is
      // discarded); another row switches the editor — pristine start, and the
      // alignment effect scrolls the tapped row above the panel.
      if (c.id === numpad.numpadId) numpad.closeNumpad();
      else numpad.openNumpad(c.id);
      return;
    }
    dispatch(selectCategory(isSelected ? null : c.id));
  };

  /** Right-click (desktop web) opens the rename popover directly — xvu steer:
   * the ONLY trigger for the Hide/Delete/Cancel/OK form. */
  const onRowContextMenu = (e: MouseEvent) => {
    if (!shell.isDesktop) return;
    e.preventDefault();
    if (suppressClickRef.current) return;
    const px = e.nativeEvent.pageX;
    const py = e.nativeEvent.pageY;
    anchorAt(px, py, (x, y) =>
      menus.setMenu({ id: c.id, kind: 'category', x, y, initialRename: true }));
  };

  return (
    <Pressable
      ref={(el) => {
        if (el) rowRefs.current.set(c.id, el);
        else rowRefs.current.delete(c.id);
      }}
      onPointerDown={(e) => onRowPointerDown(c, e)}
      onContextMenu={onRowContextMenu}
      onLongPress={
        shell.isDesktop
          ? undefined
          : (e) => {
              const px = e.nativeEvent.pageX;
              const py = e.nativeEvent.pageY;
              anchorAt(px, py, (x, y) =>
                menus.setMenu({ id: c.id, kind: 'category', x, y }));
            }
      }
      onPress={onRowPress}
      disabled={isDragging}
      onHoverIn={shell.isDesktop ? () => selection.setHoveredRow(c.id) : undefined}
      onHoverOut={shell.isDesktop ? () => selection.setHoveredRow((h) => (h === c.id ? null : h)) : undefined}
      style={[
        styles.trow,
        isSelected && styles.trowSelected,
        isChecked && styles.trowChecked,
        isDragging && styles.trowDragging,
        c.bundleId && budget.bundles.some((b) => b.id === c.bundleId) && styles.trowChild,
        drag && dropAt?.rowId === c.id && dropAt.intent === 'bundle' && styles.trowBundleTarget,
        isDragging && drag ? { transform: [{ translateY: drag.dy }] } : null,
      ]}>
      {isChecked ? <View style={styles.selBar} /> : null}
      {drag && dropAt?.rowId === c.id && dropAt.intent !== 'bundle' ? (
        <View style={[styles.dropLine, dropAt.intent === 'before' ? styles.dropTop : styles.dropBottom]} />
      ) : null}
      {isDragging && dropAt?.intent === 'bundle' ? (
        <View style={styles.bundleDropChip} pointerEvents="none">
          <Text style={styles.bundleDropChipText}>{dropLabel(dropAt, budget.categories, budget.bundles)}</Text>
        </View>
      ) : null}
      <View style={styles.trowInner}>
        <Pressable
          style={styles.checkCell}
          onPointerDown={(e) => e.stopPropagation()}
          onPress={(e) => {
            e.stopPropagation();
            selection.toggleRowChecked(c.id);
          }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isChecked }}
          accessibilityLabel={t('row.selectLabel', { name: c.name })}>
          <View
            style={[
              styles.checkbox,
              isChecked && styles.checkboxOn,
              shell.isDesktop && !isChecked && selection.hoveredRow !== c.id && styles.checkboxHidden,
            ]}>
            {isChecked ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
        </Pressable>
        {menus.rename?.kind === 'category' && menus.rename.id === c.id ? (
          <TextInput
            value={menus.draftName}
            onChangeText={menus.setDraftName}
            onSubmitEditing={menus.commitRename}
            onBlur={menus.commitRename}
            autoFocus
            style={styles.renameInput}
            accessibilityLabel={t('row.renameLabel')}
          />
        ) : (
          <View style={{ flex: 1 }} pointerEvents="none">
            {/* xvu steer: left-click anywhere on the row (name included)
                selects it and opens the inspector — the rename popover is
                right-click only. */}
            <View style={styles.catNameRow}>
              <Text
                style={[styles.catName, isSharedInPersonView(c, byPerson.person) && styles.catNameShared]}
                numberOfLines={1}>
                {c.name}
              </Text>
              {owner ? (
                <View accessible accessibilityLabel={t('row.ownerLabel', { name: personLabel(owner) })}>
                  <PersonFace person={owner} size={16} />
                </View>
              ) : null}
            </View>
            {hint ? (
              <Text
                style={[styles.catHint, { color: colors.yellowPillFg }]}
                numberOfLines={1}
                accessibilityLabel={hint.detail}>
                {hint.label}
              </Text>
            ) : null}
          </View>
        )}
        <AssignedCell grid={grid} category={c} assigned={assigned} />
        {grid.showActivity ? (
          <Text style={[styles.numText, styles.colNum, { color: colors.muted }]}>
            {formatMoney(activityFor(bm, c.id, byPerson.activity))}
          </Text>
        ) : null}
        <AvailableCell
          grid={grid}
          category={c}
          funding={funding}
          fraction={fraction}
          assigned={assigned}
          available={available}
        />
      </View>
      {grid.showProgressBars ? <FundingBar state={funding.state} fraction={fraction} /> : null}
    </Pressable>
  );
}
