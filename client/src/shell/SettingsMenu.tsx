/**
 * Settings menu host — the pane-stack menu that holds the budget's settings.
 *
 * Extracted from syscd's Apps switcher (`core/apps/AppsSwitcher.tsx`) with the
 * app list removed: in a single app the trigger pill (and the ⚙ beside it)
 * open this menu directly on the settings root pane. Everything else is the
 * switcher's pane stack, unchanged:
 *
 * The menu is a React Native `Modal` — a portal painted above the entire
 * tree, so drawer content, screens, or any sibling can never bleed through
 * or swallow its clicks. Escape and outside-taps close it.
 *
 * The host passes its panes (`panes`); the first one is the root. Pane content
 * pushes sibling panes through `useMenuNav()` (see features/settings).
 */
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewInstance,
} from 'react-native';

import logo from '../../assets/images/logo.png';
import { MenuNavContext, type MenuNav, type MenuPane } from './menuNav';
import { colors } from '@/ui/theme';

export { useMenuNav, type MenuNav, type MenuPane } from './menuNav';

/** The app's identity shown on the trigger (was the Budget entry of the Apps switcher). */
const APP = { title: 'Budget' };

/** The app logo as a rounded tile (assets/images/logo.png, from brand/). */
function AppBadge({ size = 30 }: { size?: number }) {
  return (
    <Image
      source={logo}
      accessibilityLabel={APP.title}
      style={{ width: size, height: size, borderRadius: size * 0.27 }}
    />
  );
}

export function SettingsMenu({
  compact = false,
  panes,
  openRequest,
  onOpenRequestHandled,
}: {
  compact?: boolean;
  /** Host panes (budget settings); `panes[0]` is the root. */
  panes: MenuPane[];
  /** Ask the menu to open directly on a pane (e.g. a screen's "Add people" link). */
  openRequest?: { paneId: string } | null;
  /** Called once the request opened the menu, so the host can clear it. */
  onOpenRequestHandled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** Panes pushed above the root; [] = the root pane. */
  const [stack, setStack] = useState<string[]>([]);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  /** Target budget for the per-budget pane (openBudget nav). */
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const triggerRef = useRef<ViewInstance>(null);

  const root = panes[0] ?? null;
  const top = stack[stack.length - 1];
  const pane = (top ? panes.find((p) => p.id === top) : undefined) ?? root;
  const atRoot = stack.length === 0;

  useEffect(() => {
    if (!open || process.env.EXPO_OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Reopening always starts at the root pane.
  useEffect(() => {
    if (!open) setStack([]);
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    openTo();
  };

  /** Open the menu, optionally landing directly on a pane above the root. */
  const openTo = (paneId?: string) => {
    // Anchor the portal menu under the trigger's window position (the Modal
    // renders into a portal, so parent layout offsets don't apply).
    triggerRef.current?.measureInWindow((x, y, _w, h) => {
      // Keep the whole menu on screen: never anchor it low enough that the
      // body (up to paneMaxBody tall) plus the header would overflow winH.
      setOrigin({
        x: Math.max(8, Math.min(x, winW - MENU_W - 8)),
        y: Math.max(8, Math.min(y + h + 6, winH - PANE_MAX_BODY - HEAD_EST)),
      });
      setStack(paneId && paneId !== root?.id ? [paneId] : []);
      setOpen(true);
    });
  };

  // Host-requested open (mount-safe: the host clears the request once handled,
  // so a remount of the menu never re-opens it).
  const requestedPane = openRequest?.paneId ?? null;
  useEffect(() => {
    if (!requestedPane) return undefined;
    const raf = requestAnimationFrame(() => {
      openTo(requestedPane);
      onOpenRequestHandled?.();
    });
    return () => cancelAnimationFrame(raf);
    // openTo closes over layout only; the request id is the sole trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPane]);

  const nav: MenuNav = {
    open: (id) => setStack((s) => [...s, id]),
    openBudget: (id) => {
      setEditingBudgetId(id);
      setStack((s) => [...s, 'budget-edit']);
    },
    editingBudgetId,
    back: () => setStack((s) => s.slice(0, -1)),
    close: () => setOpen(false),
  };

  const version = Constants.expoConfig?.version;

  return (
    <View style={[styles.root, compact ? styles.rootCol : styles.rootRow]} ref={triggerRef}>
      <Pressable onPress={toggle} accessibilityLabel="Open settings menu">
        {compact ? (
          <View style={styles.triggerCompact}>
            <AppBadge />
          </View>
        ) : (
          <View style={styles.trigger}>
            <AppBadge />
            <View>
              <Text style={styles.kicker}>APP</Text>
              <Text style={styles.name}>{APP.title}</Text>
            </View>
            <Text style={styles.caret}>{open ? '⌃' : '⌄'}</Text>
          </View>
        )}
      </Pressable>
      {/* The rail's ⚙ entry: always visible, opens the menu on the settings
          root (expanded: centered between the pill and the rail's right
          border; collapsed: under the B). */}
      {compact ? (
        <Pressable onPress={() => openTo()} accessibilityLabel="Settings" style={styles.gearBtn}>
          <Text style={styles.gearGlyph}>{'⚙'}</Text>
        </Pressable>
      ) : (
        <View style={styles.gearSlot}>
          <Pressable onPress={() => openTo()} accessibilityLabel="Settings" style={styles.gearBtn}>
            <Text style={styles.gearGlyph}>{'⚙'}</Text>
          </Pressable>
        </View>
      )}

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)}>
          <Pressable style={[styles.menu, { left: origin.x, top: origin.y }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.menuHead}>
              {atRoot ? (
                <View style={styles.headBtn} />
              ) : (
                <Pressable onPress={nav.back} accessibilityLabel="Back" style={styles.headBtn}>
                  <Text style={styles.headBtnText}>{'‹'}</Text>
                </Pressable>
              )}
              <Text style={styles.menuHeader}>
                {pane?.title ?? ''}
                {atRoot && version ? <Text style={styles.menuHeaderVersion}>{`  v${version}`}</Text> : null}
              </Text>
              <Pressable onPress={() => setOpen(false)} accessibilityLabel="Close menu" style={styles.headBtn}>
                <Text style={styles.headBtnText}>{'✕'}</Text>
              </Pressable>
            </View>
            <MenuNavContext.Provider value={nav}>
              {pane ? (
                <ScrollView style={styles.paneBody} contentContainerStyle={styles.paneContent}>
                  {pane.content}
                </ScrollView>
              ) : null}
            </MenuNavContext.Provider>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const MENU_W = 312;
/** Cap on the pane ScrollView body height — tall panes (Plan Settings) scroll
 * instead of overflowing, and the origin clamp reserves room for this + head. */
const PANE_MAX_BODY = 430;
/** Menu head (title row) height + menu padding estimate for the origin clamp. */
const HEAD_EST = 46;

const styles = StyleSheet.create({
  root: { position: 'relative', zIndex: 100 },
  rootRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  rootCol: { flexDirection: 'column', alignItems: 'center', gap: 6 },
  gearSlot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#17132f',
    borderWidth: 1,
    borderColor: '#3a3470',
  },
  triggerCompact: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderRadius: 10,
  },
  kicker: { fontSize: 9, color: colors.indigo2, letterSpacing: 1.2, fontWeight: '700' },
  name: { fontSize: 14, color: colors.text, fontWeight: '700' },
  caret: { color: colors.muted, marginLeft: 8 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(4, 6, 12, 0.55)' },
  menu: {
    position: 'absolute',
    width: MENU_W,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    padding: 6,
  },
  menuHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  headBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headBtnText: { color: colors.muted, fontSize: 16, fontWeight: '700' },
  menuHeader: {
    flex: 1,
    textAlign: 'center',
    fontSize: 9,
    color: colors.faint,
    letterSpacing: 1.2,
    fontWeight: '700',
  },
  menuHeaderVersion: { color: colors.muted, fontSize: 8, letterSpacing: 0.8 },
  paneBody: { maxHeight: PANE_MAX_BODY },
  paneContent: { gap: 2, paddingBottom: 4 },
  gearBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearGlyph: { color: colors.muted, fontSize: 30, lineHeight: 34 },
});
