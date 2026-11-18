/**
 * Plan-grid bundle UI pieces (docs/category-bundles-design.md): the multi-select
 * "Bundle…" bar, the name popover, the category-menu bundle items and the bundle
 * row menu. Stateless about data — PlanScreen wires them to useBundleActions.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type TextInputInstance,
} from 'react-native';

import type { Bundle, Category } from '../domain/types';
import { colors, radius } from '../ui/theme';

/** Bottom space (tab bar, FAB, safe area) a floating menu must stay clear of. */
const MENU_BOTTOM_GAP = 130;

/**
 * Top offset for a menu anchored at `y` (screen-root coords) that flips up /
 * clamps so a tall card never runs under the phone's tab bar.
 */
export function useClampedMenuTop(y: number): { top: number; onLayout: (e: LayoutChangeEvent) => void } {
  const win = useWindowDimensions();
  const [h, setH] = useState(0);
  const top = Math.max(8, Math.min(y + 6, win.height - MENU_BOTTOM_GAP - h));
  return { top, onLayout: (e) => setH(e.nativeEvent.layout.height) };
}

/** Shown above the grid while ≥ 2 rows are checked. */
export function SelectionBar({
  count,
  onBundle,
  onClear,
}: {
  count: number;
  onBundle: (pageX: number, pageY: number) => void;
  onClear: () => void;
}) {
  return (
    <View style={styles.bar} accessibilityRole="toolbar" accessibilityLabel="Selection actions">
      <Text style={styles.barCount}>{count} selected</Text>
      <Pressable
        style={styles.barBtn}
        accessibilityRole="button"
        accessibilityLabel="Bundle selected categories"
        onPress={(e) => onBundle(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      >
        <Text style={styles.barBtnText}>Bundle…</Text>
      </Pressable>
      <Pressable style={styles.barLink} accessibilityLabel="Clear selection" onPress={onClear}>
        <Text style={styles.barLinkText}>Clear</Text>
      </Pressable>
    </View>
  );
}

/**
 * Name popover for a new bundle. With fewer than 2 categories it also lists the
 * other unbundled categories of the group to pick the partner(s) from.
 */
export function BundleNamePopover({
  x,
  y,
  ids,
  categories,
  onSubmit,
  onClose,
}: {
  x: number;
  y: number;
  ids: readonly string[];
  categories: readonly Category[];
  onSubmit: (ids: string[], name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const inputRef = useRef<TextInputInstance>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  const all = [...ids, ...extra];
  const seed = categories.find((c) => c.id === ids[0]);
  const candidates =
    ids.length >= 2 || !seed
      ? []
      : categories.filter((c) => c.groupId === seed.groupId && !c.bundleId && !ids.includes(c.id) && !c.hidden);
  const pos = useClampedMenuTop(y);
  const ready = name.trim().length > 0 && all.length >= 2;
  const submit = () => {
    if (ready) onSubmit(all, name.trim());
  };
  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable
        onLayout={pos.onLayout}
        onPress={(e) => e.stopPropagation()}
        style={[styles.card, { left: Math.max(12, x - 150), top: pos.top, width: 280 }]}
      >
        <Text style={styles.title}>New bundle</Text>
        <TextInput
          ref={inputRef}
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
          placeholder="Bundle name"
          placeholderTextColor={colors.faint}
          autoFocus
          style={styles.input}
          accessibilityLabel="Bundle name"
        />
        {candidates.length > 0 ? (
          <View>
            <Text style={styles.subhead}>With…</Text>
            <ScrollView style={{ maxHeight: 150 }}>
              {candidates.map((c) => {
                const on = extra.includes(c.id);
                return (
                  <Pressable
                    key={c.id}
                    style={styles.item}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`Bundle with ${c.name}`}
                    onPress={() => setExtra((p) => (on ? p.filter((i) => i !== c.id) : [...p, c.id]))}
                  >
                    <Text style={styles.itemText}>
                      {on ? '✓ ' : '   '}
                      {c.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        <View style={styles.row}>
          <Pressable style={styles.item} onPress={onClose} accessibilityLabel="Cancel bundle">
            <Text style={styles.itemText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={submit} disabled={!ready} accessibilityLabel="Create bundle">
            <Text style={[styles.ok, !ready && { opacity: 0.4 }]}>Create</Text>
          </Pressable>
        </View>
      </Pressable>
    </Pressable>
  );
}

/** Bundle entries for the category row menu (inserted into RowMenu). */
export function CategoryBundleItems({
  bundlesInGroup,
  currentBundleId,
  onJoin,
  onNew,
  onLeave,
}: {
  bundlesInGroup: readonly Bundle[];
  currentBundleId?: string;
  onJoin: (bundleId: string) => void;
  onNew: () => void;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const joinable = bundlesInGroup.filter((b) => b.id !== currentBundleId);
  return (
    <View accessibilityRole="menu" accessibilityLabel="Bundle">
      <Pressable
        style={styles.item}
        accessibilityRole="menuitem"
        accessibilityLabel="Add to bundle"
        onPress={() => setOpen((o) => !o)}
      >
        <Text style={styles.itemText}>Add to bundle {open ? '⌄' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.sub}>
          {joinable.map((b) => (
            <Pressable
              key={b.id}
              style={styles.item}
              accessibilityRole="menuitem"
              accessibilityLabel={`Add to ${b.name}`}
              onPress={() => onJoin(b.id)}
            >
              <Text style={styles.itemText} numberOfLines={1}>
                {b.name}
              </Text>
            </Pressable>
          ))}
          <Pressable style={styles.item} accessibilityRole="menuitem" accessibilityLabel="New bundle" onPress={onNew}>
            <Text style={styles.itemText}>New bundle…</Text>
          </Pressable>
        </View>
      ) : null}
      {currentBundleId ? (
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel="Remove from bundle"
          onPress={onLeave}
        >
          <Text style={styles.itemText}>Remove from bundle</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Bundle row menu: Rename · Add category here · Ungroup. */
export function BundleRowMenu({
  bundle,
  x,
  y,
  onRename,
  onAddCategory,
  onUngroup,
  onClose,
}: {
  bundle: Bundle;
  x: number;
  y: number;
  onRename: () => void;
  onAddCategory: () => void;
  onUngroup: () => void;
  onClose: () => void;
}) {
  const pos = useClampedMenuTop(y);
  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable
        onLayout={pos.onLayout}
        onPress={(e) => e.stopPropagation()}
        style={[styles.card, { left: Math.max(12, x - 190), top: pos.top, width: 200 }]}
      >
        <Text style={styles.title}>{bundle.name}</Text>
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel="Rename bundle"
          onPress={onRename}
        >
          <Text style={styles.itemText}>Rename</Text>
        </Pressable>
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel="Add category here"
          onPress={onAddCategory}
        >
          <Text style={styles.itemText}>Add category here</Text>
        </Pressable>
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel="Ungroup bundle"
          onPress={onUngroup}
        >
          <Text style={styles.danger}>Ungroup</Text>
        </Pressable>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: colors.indigoSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barCount: { color: colors.text, fontSize: 13, fontWeight: '700' },
  barBtn: {
    backgroundColor: colors.indigo2,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  barBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  barLink: { paddingHorizontal: 6, paddingVertical: 5 },
  barLinkText: { color: colors.indigo3, fontSize: 13, fontWeight: '600' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
  },
  card: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
  },
  title: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 4,
  },
  subhead: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 2,
  },
  input: {
    marginHorizontal: 12,
    marginVertical: 4,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.indigo2,
    backgroundColor: colors.bg2,
  },
  item: { paddingVertical: 9, paddingHorizontal: 14 },
  itemText: { color: colors.text, fontSize: 13 },
  sub: {
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: colors.border2,
    marginLeft: 14,
  },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
  ok: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
  danger: { color: colors.redFg, fontSize: 13 },
});
