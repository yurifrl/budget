import { ShortcutRow } from './menuRows';

/** Keyboard Shortcuts (web only; only real shortcuts listed). */
export function ShortcutsPane() {
  return (
    <>
      <ShortcutRow keys="Esc" desc="Close menus, sheets and this panel" />
      <ShortcutRow keys="Enter" desc="Commit the money field being edited" />
      <ShortcutRow keys="+ − × ÷" desc="Quick-math operators in money fields" />
    </>
  );
}
