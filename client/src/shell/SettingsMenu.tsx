/**
 * Settings menu host: the pane-stack menu behind the account row pinned to
 * the bottom of the rail (budget, settings and account sections).
 *
 * The menu is a React Native `Modal` (a portal painted above the entire
 * tree, so drawer content, screens, or any sibling can never bleed through
 * or swallow its clicks). It opens upward: anchored by its bottom edge just
 * above the trigger and kept inside the window (menuPlacement.logic.ts).
 * Escape and outside-taps close it.
 *
 * The host passes the trigger's content (`trigger`) and its panes (`panes`);
 * the first pane is the root. Pane content pushes sibling panes through
 * `useMenuNav()` (see features/settings).
 */
import Constants from 'expo-constants';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewInstance,
} from 'react-native';

import { MenuNavContext, type MenuNav, type MenuPane } from './menuNav';
import { menuPlacement } from './menuPlacement.logic';
import { colors } from '@/ui/theme';

export { useMenuNav, type MenuNav, type MenuPane } from './menuNav';

/** On-screen keyboard height (native), so a pane with a text field rides above it. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return undefined;
    const ios = process.env.EXPO_OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

export function SettingsMenu({
  trigger,
  panes,
  openRequest,
  onOpenRequestHandled,
  topInset = 0,
}: {
  /** The trigger's content (the rail's account row); `open` drives its pressed look. */
  trigger: (open: boolean) => ReactNode;
  /** Status bar height the open menu must stay below (drawer mode). */
  topInset?: number;
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
  /** Trigger's window position, measured when the menu opens. */
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  /** Target budget for the per-budget pane (openBudget nav). */
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null);
  const win = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
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
    // The Modal renders into a portal, so parent layout offsets don't apply:
    // anchor on the trigger's window position.
    triggerRef.current?.measureInWindow((x, y) => {
      setAnchor({ x, y });
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

  // Recomputed every render, so a window resize, a rotation or the keyboard
  // re-fit the open menu.
  const place = menuPlacement({
    trigger: anchor,
    win,
    menuWidth: MENU_W,
    chromeHeight: MENU_CHROME,
    bodyCap: PANE_MAX_BODY,
    topInset,
    keyboardHeight,
  });

  return (
    <View style={styles.root} ref={triggerRef}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel="Open settings menu"
        accessibilityState={{ expanded: open }}>
        {trigger(open)}
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)}>
          <Pressable
            style={[styles.menu, { left: place.left, bottom: place.bottom, width: place.width }]}
            onPress={(e) => e.stopPropagation()}>
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
                <ScrollView style={{ maxHeight: place.maxBody }} contentContainerStyle={styles.paneContent}>
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
/** Cap on the pane ScrollView body height on a roomy window; shorter windows
 * get less (menuPlacement) and the pane scrolls. */
const PANE_MAX_BODY = 760;
/** Menu chrome outside the scrolling body: padding 6+6, border 1+1, head 26 + 4. */
const MENU_CHROME = 44;

const styles = StyleSheet.create({
  root: { width: '100%' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(4, 6, 12, 0.55)' },
  menu: {
    position: 'absolute',
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
  paneContent: { gap: 2, paddingBottom: 4 },
});
