/**
 * Selection action bar — the floating indigo pill at the bottom of the
 * transaction register (YNAB reference): close ×, "N Transactions" count,
 * Categorize / Flag, and More — the full multi-row action menu (Mark as
 * Cleared/Uncleared, Match, Unmatch, Duplicate, Memo, Move to Account,
 * Export N Transactions, Delete) with YNAB's keycap hints. Categorize, Flag
 * and More open Modal-anchored popovers using the same scrim-dropdown recipe
 * as AccountsToolbar. Actions apply to every selected transaction via the
 * parent's callbacks; the parent owns selection state and mutations.
 */

import { useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { pickableCategories } from '@/domain/pickable';
import type { Category, CategoryGroup, FlagColor } from '@/domain/types';
import { displayFlagLabel } from '@/domain/flagLabels';
import { FLAG_COLORS, colors } from '@/ui/theme';
import { useFlagLabels } from '@/state/useDisplayPrefs';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';
import { displaySystemName } from '@/domain/systemNames';

/** YNAB reference pill — deeper than the theme indigo accents. */
const BAR_BG = '#4a3fa5';
const MENU_W = 252;
const MENU_H = 340;

type MenuPanel = 'categorize' | 'flag' | 'more' | 'more-move';

export interface SelectionBarProps {
  count: number;
  categories: Category[];
  groups: CategoryGroup[];
  onCategorize: (categoryId: string | null) => void;
  onFlag: (flag: FlagColor | null) => void;
  /** Mark-as item in the More menu; direction follows the selection state. */
  onCleared: (cleared: 'cleared' | 'uncleared' | 'reconciled') => void;
  /** True when nothing selected is uncleared — swaps the Mark-as label. */
  allCleared: boolean;
  canMatch: boolean;
  hasMatched: boolean;
  onMatch: () => void;
  onUnmatch: () => void;
  onDuplicate: () => void;
  onMemo: () => void;
  onExport: () => void;
  onDelete: () => void;
  /** Move targets; a target is disabled when every selected txn already sits there. */
  moveTargets: { id: string; name: string; disabled: boolean }[];
  onMoveTo: (accountId: string) => void;
  onClose: () => void;
}

export function SelectionBar({
  count,
  categories,
  groups,
  onCategorize,
  onFlag,
  onCleared,
  allCleared,
  canMatch,
  hasMatched,
  onMatch,
  onUnmatch,
  onDuplicate,
  onMemo,
  onExport,
  onDelete,
  moveTargets,
  onMoveTo,
  onClose,
}: SelectionBarProps) {
  const [menu, setMenu] = useState<MenuPanel | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const catRef = useRef<ViewInstance>(null);
  const flagRef = useRef<ViewInstance>(null);
  const moreRef = useRef<ViewInstance>(null);
  // Edit Flags labels from the Settings panel; falls back to color names.
  const flagLabels = useFlagLabels();

  const openMenu = (which: MenuPanel, ref: ViewInstance | null) => {
    ref?.measureInWindow((x, y) => {
      // Anchor above the bar button; clamp left so the popover stays onscreen.
      const winW = Dimensions.get('window').width;
      setAnchor({ x: Math.min(Math.max(x - 12, 8), Math.max(winW - MENU_W - 8, 8)), y });
      setMenu(which);
    });
  };

  const closeMenu = () => setMenu(null);
  // Credit Card Payments and the app's internal categories are never offered.
  const pickable = useMemo(() => pickableCategories(categories, groups), [categories, groups]);

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {menu && anchor ? (
        <Modal transparent animationType="fade" onRequestClose={closeMenu}>
          <Pressable
            style={styles.scrim}
            accessibilityLabel={t('selection.closeMenu')}
            onPress={closeMenu}>
            <View
              style={[
                styles.menu,
                { left: anchor.x, bottom: Dimensions.get('window').height - anchor.y + 6 },
              ]}>
              {menu === 'categorize' ? (
                <ScrollView
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ paddingBottom: 4 }}>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onCategorize(null);
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.readyToAssign')}</Text>
                  </Pressable>
                  {groups.map((g) => {
                    const groupCats = pickable.filter((c) => c.groupId === g.id && !c.hidden);
                    if (groupCats.length === 0) return null;
                    return (
                      <View key={g.id}>
                        <Text style={styles.menuGroup}>{displaySystemName(g.name)}</Text>
                        {groupCats.map((c) => (
                          <Pressable
                            key={c.id}
                            style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                            onPress={() => {
                              onCategorize(c.id);
                              closeMenu();
                            }}>
                            <Text style={styles.menuItemText}>{c.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    );
                  })}
                </ScrollView>
              ) : menu === 'flag' ? (
                <>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onFlag(null);
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.noFlag')}</Text>
                  </Pressable>
                  {FLAG_COLORS.map((f) => (
                    <Pressable
                      key={f.key}
                      style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                      onPress={() => {
                        onFlag(f.key);
                        closeMenu();
                      }}>
                      <View style={[styles.menuDot, { backgroundColor: f.hex }]} />
                      <Text style={styles.menuItemText}>{displayFlagLabel(flagLabels, f.key)}</Text>
                    </Pressable>
                  ))}
                </>
              ) : menu === 'more-move' ? (
                <>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => setMenu('more')}>
                    <Ionicons name="chevron-back" size={14} color={colors.muted} />
                    <Text style={styles.menuItemText}>{t('selection.moveToAccount')}</Text>
                  </Pressable>
                  <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 4 }}>
                    {moveTargets.length === 0 ? (
                      <Text style={styles.menuEmpty}>{t('selection.noOtherAccounts')}</Text>
                    ) : null}
                    {moveTargets.map((a) => (
                      <Pressable
                        key={a.id}
                        style={({ pressed }) => [
                          styles.menuItem,
                          a.disabled && styles.menuItemDisabled,
                          pressed && !a.disabled && styles.menuItemPressed,
                        ]}
                        disabled={a.disabled}
                        onPress={() => {
                          onMoveTo(a.id);
                          closeMenu();
                        }}>
                        <Text style={styles.menuItemText}>{a.name}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              ) : (
                <>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onCleared(allCleared ? 'uncleared' : 'cleared');
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>
                      {allCleared ? t('selection.markUncleared') : t('selection.markCleared')}
                    </Text>
                    <Keycaps keys={['C']} />
                  </Pressable>
                  <View style={styles.menuDivider} />
                  <Pressable
                    style={({ pressed }) => [
                      styles.menuItem,
                      !canMatch && styles.menuItemDisabled,
                      pressed && canMatch && styles.menuItemPressed,
                    ]}
                    disabled={!canMatch}
                    onPress={() => {
                      onMatch();
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.match')}</Text>
                    <Keycaps keys={['M']} />
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.menuItem,
                      !hasMatched && styles.menuItemDisabled,
                      pressed && hasMatched && styles.menuItemPressed,
                    ]}
                    disabled={!hasMatched}
                    onPress={() => {
                      onUnmatch();
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.unmatch')}</Text>
                    <Keycaps keys={['shift', 'U']} />
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onDuplicate();
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.duplicate')}</Text>
                    <Keycaps keys={['shift', 'D']} />
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onMemo();
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>{t('selection.memo')}</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => setMenu('more-move')}>
                    <Text style={styles.menuItemText}>{t('selection.moveToAccount')}</Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.muted} />
                  </Pressable>
                  <View style={styles.menuDivider} />
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onExport();
                      closeMenu();
                    }}>
                    <Text style={styles.menuItemText}>
                      {t('selection.export', { count })}
                    </Text>
                  </Pressable>
                  <View style={styles.menuDivider} />
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={() => {
                      onDelete();
                      closeMenu();
                    }}>
                    <Text style={[styles.menuItemText, styles.menuItemDanger]}>{tCommon('delete')}</Text>
                    <Keycaps keys={['delete']} />
                  </Pressable>
                </>
              )}
            </View>
          </Pressable>
        </Modal>
      ) : null}

      <View style={styles.bar}>
        <Pressable
          style={({ pressed }) => [styles.barIcon, pressed && styles.barBtnPressed]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('selection.clear')}>
          <Ionicons name="close" size={16} color={colors.white} />
        </Pressable>
        <Text style={styles.count} accessibilityLiveRegion="polite">
          {t('selection.count', { count })}
        </Text>
        <View style={styles.divider} />
        <View ref={(v) => { catRef.current = v; }} collapsable={false}>
          <Pressable
            style={({ pressed }) => [styles.barBtn, pressed && styles.barBtnPressed]}
            onPress={() => openMenu('categorize', catRef.current)}
            accessibilityRole="button"
            accessibilityLabel={t('selection.categorizeLabel')}>
            <Ionicons name="checkbox" size={15} color={colors.white} />
            <Text style={styles.barBtnText}>{t('selection.categorize')}</Text>
          </Pressable>
        </View>
        <View ref={(v) => { flagRef.current = v; }} collapsable={false}>
          <Pressable
            style={({ pressed }) => [styles.barBtn, pressed && styles.barBtnPressed]}
            onPress={() => openMenu('flag', flagRef.current)}
            accessibilityRole="button"
            accessibilityLabel={t('selection.flagLabel')}>
            <Ionicons name="flag" size={15} color={colors.white} />
            <Text style={styles.barBtnText}>{t('selection.flag')}</Text>
          </Pressable>
        </View>
        <View style={styles.divider} />
        <View ref={(v) => { moreRef.current = v; }} collapsable={false}>
          <Pressable
            style={({ pressed }) => [styles.barBtn, pressed && styles.barBtnPressed]}
            onPress={() => openMenu('more', moreRef.current)}
            accessibilityRole="button"
            accessibilityLabel={t('menu.moreActions')}>
            <Ionicons name="ellipsis-horizontal" size={15} color={colors.white} />
            <Text style={styles.barBtnText}>{t('selection.more')}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** YNAB-style keycap hint — light chip row, right-aligned inside a menu item. */
function Keycaps({ keys }: { keys: readonly string[] }) {
  return (
    <View style={styles.keycaps}>
      {keys.map((k) => (
        <View key={k} style={styles.keycap}>
          <Text style={styles.keycapText}>{k}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 14,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: BAR_BG,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: colors.black,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  barIcon: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  barBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    height: 30,
    borderRadius: 6,
  },
  barBtnPressed: { backgroundColor: 'rgba(255,255,255,0.18)' },
  barBtnText: { color: colors.white, fontSize: 14 },
  count: { color: colors.white, fontSize: 14, fontWeight: '600', marginLeft: 4, marginRight: 6 },
  divider: { width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 6 },
  scrim: { flex: 1 },
  menu: {
    position: 'absolute',
    width: MENU_W,
    maxHeight: MENU_H,
    backgroundColor: colors.card2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border2,
    paddingVertical: 6,
    shadowColor: colors.black,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 30,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  menuItemPressed: { backgroundColor: colors.hover },
  menuItemDisabled: { opacity: 0.4 },
  menuItemDanger: { color: colors.redFg },
  menuItemText: { color: colors.text, fontSize: 13, flexShrink: 1 },
  menuGroup: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
  },
  menuDivider: { height: 1, backgroundColor: colors.border2, marginVertical: 4 },
  menuDot: { width: 12, height: 12, borderRadius: 6 },
  menuEmpty: { color: colors.muted, fontSize: 12, paddingHorizontal: 12, paddingVertical: 8 },
  keycaps: { flexDirection: 'row', gap: 4, marginLeft: 'auto', flexShrink: 0 },
  keycap: {
    backgroundColor: colors.white,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    minWidth: 16,
    alignItems: 'center',
  },
  keycapText: { color: colors.text, fontSize: 10, fontWeight: '600' },
});
