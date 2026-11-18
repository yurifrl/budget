/**
 * Plan row for a category bundle (docs/category-bundles-design.md): a read-only
 * roll-up (chevron, name, count badge, greyed sums, sum pill) in a dashed
 * indigo frame. Never opens the numpad or an inline assign editor; children are
 * ordinary category rows rendered under it with a tree line.
 */
import { useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Bundle, Category } from '../domain/types';
import type { BundleFigures } from '../domain/bundles';
import { formatMoney } from '../domain/format';
import { Pill } from '../ui/bits';
import { centsPillState, colors, radius } from '../ui/theme';

/** Column widths shared with the category rows in PlanScreen. */
export const PLAN_COLS = {
  num: { width: 120, alignItems: 'flex-end', textAlign: 'right' },
  avail: { width: 140, alignItems: 'flex-end', textAlign: 'right' },
  numPhone: { width: 92 },
  availPhone: { width: 112 },
} as const;

export interface BundleItem {
  kind: 'bundle';
  bundle: Bundle;
  children: Category[];
  sums: BundleFigures;
}

export const isBundleItem = (x: unknown): x is BundleItem =>
  typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'bundle';

export function BundleRow({
  item,
  expanded,
  onToggle,
  onMenu,
  renaming,
  onRename,
  onRenameDone,
  dropLabel,
  dropLine,
  isPhone,
  showActivity,
  showAssignedAsActivity,
  rowRef,
  onPointerDown,
}: {
  item: BundleItem;
  expanded: boolean;
  onToggle: () => void;
  /** ⋯ button / right-click / long-press: page coords of the press. */
  onMenu: (pageX: number, pageY: number) => void;
  renaming: boolean;
  onRename: (name: string) => void;
  onRenameDone: () => void;
  /** Center-drop highlight text ("Add to Medicines") while a drag hovers the middle zone. */
  dropLabel?: string | null;
  /** Edge-drop indicator while a drag hovers the top/bottom quarter. */
  dropLine?: 'top' | 'bottom' | null;
  isPhone: boolean;
  showActivity: boolean;
  /** Phone with a person filter: the middle column shows ACTIVITY instead of ASSIGNED. */
  showAssignedAsActivity: boolean;
  rowRef: (el: ComponentRef<typeof Pressable> | null) => void;
  onPointerDown?: () => void;
}) {
  const { bundle, children, sums } = item;
  const [draft, setDraft] = useState(bundle.name);
  const doneRef = useRef(false);
  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = draft.trim();
    if (name && name !== bundle.name) onRename(name);
    onRenameDone();
  };
  const numCol = [PLAN_COLS.num, isPhone && PLAN_COLS.numPhone];
  return (
    <Pressable
      ref={rowRef}
      onPress={renaming ? undefined : onToggle}
      onPointerDown={onPointerDown}
      onLongPress={isPhone ? (e) => onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY) : undefined}
      {...({
        onContextMenu: (e: any) => {
          if (isPhone) return;
          e.preventDefault?.();
          onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY);
        },
      } as object)}
      accessibilityRole="button"
      accessibilityLabel={`${bundle.name} bundle, ${children.length} categories, ${expanded ? 'expanded' : 'collapsed'}`}
      accessibilityState={{ expanded }}
      style={[styles.frame, dropLabel ? styles.frameDrop : null]}
    >
      {dropLine ? <View style={[styles.dropLine, dropLine === 'top' ? { top: -3 } : { bottom: -3 }]} /> : null}
      <View style={styles.inner}>
        <View style={styles.left}>
          <Text style={styles.chevron}>{expanded ? '⌄' : '▸'}</Text>
          {renaming ? (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commit}
              onBlur={commit}
              autoFocus
              selectTextOnFocus
              style={styles.nameInput}
              accessibilityLabel="Rename bundle"
            />
          ) : (
            <Text style={styles.name} numberOfLines={1}>
              {bundle.name}
            </Text>
          )}
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{isPhone ? children.length : `${children.length} items`}</Text>
          </View>
          {dropLabel ? (
            <View style={styles.dropChip}>
              <Text style={styles.dropChipText}>{dropLabel}</Text>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {/* Phone: long-press is the menu — the ⋯ button would steal the name's width. */}
          {isPhone ? null : (
            <Pressable
              style={styles.menuBtn}
              accessibilityLabel={`${bundle.name} bundle options`}
              onPress={(e) => {
                e.stopPropagation();
                onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY);
              }}
            >
              <Text style={styles.menuText}>⋯</Text>
            </Pressable>
          )}
        </View>
        <View style={numCol}>
          <Text style={[styles.sum, isPhone && styles.sumPhone]} numberOfLines={1}>
            {formatMoney(showAssignedAsActivity ? sums.activity : sums.assigned)}
          </Text>
        </View>
        {showActivity ? (
          <View style={numCol}>
            <Text style={[styles.sum, isPhone && styles.sumPhone]} numberOfLines={1}>
              {formatMoney(sums.activity)}
            </Text>
          </View>
        ) : null}
        <View style={[PLAN_COLS.avail, isPhone && PLAN_COLS.availPhone]}>
          <Pill state={centsPillState(sums.available)} cents={sums.available} small={isPhone} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: {
    marginHorizontal: 12,
    marginVertical: 3,
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.indigo,
    backgroundColor: colors.indigoSoft,
  },
  frameDrop: {
    borderStyle: 'solid',
    borderWidth: 2,
    borderColor: colors.indigo3,
  },
  inner: { flexDirection: 'row', alignItems: 'center' },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  chevron: {
    color: colors.indigo3,
    fontWeight: '700',
    fontSize: 14,
    width: 18,
    textAlign: 'center',
  },
  name: { color: colors.text, fontWeight: '600', fontSize: 14, flexShrink: 1 },
  nameInput: {
    color: colors.text,
    fontWeight: '600',
    fontSize: 14,
    minWidth: 140,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.indigo2,
    backgroundColor: colors.card,
  },
  badge: {
    backgroundColor: colors.grayPillBg,
    borderRadius: 9,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { color: colors.grayPillFg, fontSize: 11 },
  dropChip: {
    backgroundColor: colors.indigo,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  dropChipText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  menuBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  menuText: { color: colors.muted, fontSize: 14 },
  // Greyed: the roll-up is read-only; only the categories below are editable.
  sum: {
    color: colors.muted,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  sumPhone: { fontSize: 12 },
  dropLine: {
    position: 'absolute',
    left: 2,
    right: 2,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.indigo2,
    zIndex: 40,
  },
});
