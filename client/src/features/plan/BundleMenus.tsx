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

import type { Bundle, Category } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';

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
    <View style={styles.bar} accessibilityRole="toolbar" accessibilityLabel={t('bundle.selectionLabel')}>
      <Text style={styles.barCount}>{t('bundle.selectedCount', { count })}</Text>
      <Pressable
        style={styles.barBtn}
        accessibilityRole="button"
        accessibilityLabel={t('bundle.bundleSelectedLabel')}
        onPress={(e) => onBundle(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      >
        <Text style={styles.barBtnText}>{t('bundle.bundleSelected')}</Text>
      </Pressable>
      <Pressable style={styles.barLink} accessibilityLabel={t('bundle.clearLabel')} onPress={onClear}>
        <Text style={styles.barLinkText}>{t('bundle.clear')}</Text>
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
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
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
        <Text style={styles.title}>{t('bundle.popoverTitle')}</Text>
        <TextInput
          ref={inputRef}
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
          placeholder={t('bundle.namePlaceholder')}
          placeholderTextColor={colors.faint}
          autoFocus
          style={styles.input}
          accessibilityLabel={t('bundle.nameLabel')}
        />
        {candidates.length > 0 ? (
          <View>
            <Text style={styles.subhead}>{t('bundle.withHeading')}</Text>
            <ScrollView style={{ maxHeight: 150 }}>
              {candidates.map((c) => {
                const on = extra.includes(c.id);
                return (
                  <Pressable
                    key={c.id}
                    style={styles.item}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={t('bundle.withLabel', { name: c.name })}
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
          <Pressable style={styles.item} onPress={onClose} accessibilityLabel={t('bundle.cancelLabel')}>
            <Text style={styles.itemText}>{tCommon('cancel')}</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={submit} disabled={!ready} accessibilityLabel={t('bundle.createLabel')}>
            <Text style={[styles.ok, !ready && { opacity: 0.4 }]}>{t('bundle.create')}</Text>
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
    <View accessibilityRole="menu" accessibilityLabel={t('bundle.menuLabel')}>
      <Pressable
        style={styles.item}
        accessibilityRole="menuitem"
        accessibilityLabel={t('bundle.addToLabel')}
        onPress={() => setOpen((o) => !o)}
      >
        <Text style={styles.itemText}>{t('bundle.addTo')} {open ? '⌄' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.sub}>
          {joinable.map((b) => (
            <Pressable
              key={b.id}
              style={styles.item}
              accessibilityRole="menuitem"
              accessibilityLabel={t('bundle.addToNamedLabel', { name: b.name })}
              onPress={() => onJoin(b.id)}
            >
              <Text style={styles.itemText} numberOfLines={1}>
                {b.name}
              </Text>
            </Pressable>
          ))}
          <Pressable style={styles.item} accessibilityRole="menuitem" accessibilityLabel={t('bundle.newLabel')} onPress={onNew}>
            <Text style={styles.itemText}>{t('bundle.new')}</Text>
          </Pressable>
        </View>
      ) : null}
      {currentBundleId ? (
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel={t('bundle.removeFrom')}
          onPress={onLeave}
        >
          <Text style={styles.itemText}>{t('bundle.removeFrom')}</Text>
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
          accessibilityLabel={t('bundle.renameLabel')}
          onPress={onRename}
        >
          <Text style={styles.itemText}>{t('menu.rename')}</Text>
        </Pressable>
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel={t('bundle.addCategoryHere')}
          onPress={onAddCategory}
        >
          <Text style={styles.itemText}>{t('bundle.addCategoryHere')}</Text>
        </Pressable>
        <Pressable
          style={styles.item}
          accessibilityRole="menuitem"
          accessibilityLabel={t('bundle.ungroupLabel')}
          onPress={onUngroup}
        >
          <Text style={styles.danger}>{t('bundle.ungroup')}</Text>
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
  barBtnText: { color: colors.white, fontSize: 13, fontWeight: '700' },
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
