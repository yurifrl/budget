import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, type TextInputInstance, View } from 'react-native';

import { personLabel, SHARED_LABEL, type Person } from '@/domain/people';
import { PersonFace } from '@/ui/PersonFace';
import { useClampedMenuTop } from './BundleMenus';
import { styles } from './styles';

/**
 * Absolutely-positioned context menu for a grid row (YNAB parity, syscd-app-42c):
 * desktop gets the two-stage popover — item list, then an inline rename form
 * (name input + Hide / Delete / Cancel / OK). `batch` marks a multi-row
 * selection: Hide/Delete act on the whole selection, rename is disabled.
 */
export function RowMenu({
  menu,
  name,
  desktop,
  batch,
  initialRename = false,
  bundleItems = null,
  people,
  currentOwnerId,
  onAssign,
  onClose,
  onRename,
  onHide,
  onDelete,
  onCommitRename,
}: {
  menu: { id: string; kind: 'category' | 'group'; x: number; y: number };
  name: string;
  desktop: boolean;
  batch: boolean;
  /** xvu: right-click opens the popover straight into the rename form. */
  initialRename?: boolean;
  /** Bundle entries (Add to bundle ▸ / New bundle… / Remove from bundle) for category menus. */
  bundleItems?: ReactNode;
  /** Budget members; the "Assign to" list shows when there is at least one person (the viewer counts). */
  people: readonly Person[];
  /** The category's current owner (undefined for a group, null = Shared). */
  currentOwnerId?: string | null;
  onAssign: (userId: string | null) => void;
  onClose: () => void;
  onRename: (() => void) | null;
  onHide: (() => void) | null;
  onDelete: () => void;
  onCommitRename?: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState(initialRename);
  const pos = useClampedMenuTop(menu.y);
  const [draft, setDraft] = useState(name);
  const renameRef = useRef<TextInputInstance>(null);

  // Escape (and Enter-to-commit) close the menu — web only, capture so the
  // grid's own shortcuts don't eat it first.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (desktop && renaming) {
      const t = window.setTimeout(() => renameRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [desktop, renaming]);

  const startRename = () => {
    if (desktop && !batch) setRenaming(true);
    else onRename?.();
  };

  const commitRename = () => {
    const next = draft.trim();
    if (next && onCommitRename) {
      onCommitRename(next);
      onClose();
    } else if (!next) {
      setRenaming(false);
    }
  };

  const isGroup = menu.kind === 'group';
  const assignBlock =
    people.length > 0 ? (
        <View accessibilityRole="menu" accessibilityLabel="Assign to">
          <Text style={styles.menuSubhead}>{isGroup ? 'Assign group to…' : 'Assign to…'}</Text>
          {[null, ...people].map((p) => {
            const label = p ? personLabel(p) : SHARED_LABEL;
            const on = currentOwnerId !== undefined && (p?.user_id ?? null) === currentOwnerId;
            return (
              <Pressable
                key={p?.user_id ?? 'shared'}
                style={[styles.menuItem, styles.menuPersonRow]}
                accessibilityRole="menuitem"
                accessibilityLabel={`Assign to ${label}`}
                onPress={() => onAssign(p?.user_id ?? null)}>
                <PersonFace person={p} size={18} />
                <Text style={[styles.menuItemText, { flex: 1 }]} numberOfLines={1}>
                  {label}
                </Text>
                {on ? <Text style={styles.menuOk}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
    ) : null;
  return (
    <Pressable style={styles.menuBackdrop} onPress={onClose}>
      {/* Swallow clicks so item presses don't bubble to the backdrop and close. */}
      <Pressable
        onPress={(e) => e.stopPropagation()}
        onLayout={pos.onLayout}
        style={[styles.rowMenuCard, { left: Math.max(12, menu.x - 190), top: pos.top }]}>
        {renaming ? (
          <View style={styles.renameField}>
            <TextInput
              ref={renameRef}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commitRename}
              onEndEditing={commitRename}
              style={styles.menuRenameInput}
              accessibilityLabel="Rename category"
            />
            <View style={styles.renameRow}>
              {isGroup ? null : (
                <Pressable style={styles.menuItem} onPress={onHide ?? undefined} disabled={!onHide}>
                  <Text style={styles.menuItemText}>Hide</Text>
                </Pressable>
              )}
              <Pressable style={styles.menuItem} onPress={onDelete}>
                <Text style={styles.menuItemTextDanger}>Delete</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => setRenaming(false)}>
                <Text style={styles.menuItemText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={commitRename}>
                <Text style={styles.menuOk}>OK</Text>
              </Pressable>
            </View>
            {bundleItems}
            {assignBlock}
          </View>
        ) : (
          <View>
            <Text style={styles.menuRowName}>{name}</Text>
            <Pressable style={styles.menuItem} onPress={onRename && !batch ? startRename : undefined} disabled={!onRename || batch}>
              <Text style={[styles.menuItemText, (!onRename || batch) && styles.viewsBtnDisabled]}>
                Rename
              </Text>
            </Pressable>
            {onHide ? (
              <Pressable style={styles.menuItem} onPress={onHide}>
                <Text style={styles.menuItemText}>Hide</Text>
              </Pressable>
            ) : null}
            {bundleItems}
            {assignBlock}
            <Pressable style={styles.menuItem} onPress={onDelete}>
              <Text style={styles.menuItemTextDanger}>Delete</Text>
            </Pressable>
          </View>
        )}
      </Pressable>
    </Pressable>
  );
}
