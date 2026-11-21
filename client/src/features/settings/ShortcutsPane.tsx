import { t } from './i18n';
import { ShortcutRow } from './menuRows';

/** Keyboard Shortcuts (web only; only real shortcuts listed). */
export function ShortcutsPane() {
  return (
    <>
      {/* eslint-disable-next-line budget-i18n/no-untranslated-string -- key name, not text */}
      <ShortcutRow keys="Esc" desc={t('shortcuts.close')} />
      {/* eslint-disable-next-line budget-i18n/no-untranslated-string -- key name, not text */}
      <ShortcutRow keys="Enter" desc={t('shortcuts.enter')} />
      <ShortcutRow keys="+ − × ÷" desc={t('shortcuts.math')} />
    </>
  );
}
