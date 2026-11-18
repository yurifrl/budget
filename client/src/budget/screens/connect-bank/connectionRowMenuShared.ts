/**
 * One semantic definition of the bank-connection row menu (the iOS long-press
 * context menu, `ConnectionRowMenu.ios.tsx`, maps the action kinds to SF
 * Symbols). Also owns the Remove confirmation copy shared with the settings page.
 */

import { requiresReauth } from '../../domain/connections';

/** The row's menu action kinds, shared across platforms. */
export type ConnectionRowActionKind = 'sync' | 'reimport' | 'reconnect' | 'settings' | 'disconnect';

export interface ConnectionRowAction {
  kind: ConnectionRowActionKind;
  label: string;
  /** iOS destructive role / web red text. */
  danger?: boolean;
  disabled?: boolean;
  /** Wired by the platform file / screen from the screen's handlers. */
  onPress?: () => void;
}

/**
 * The row's actions in display order. `Sync now` and `Re-import history`
 * need a connected status; `Reconnect` appears only when the status demands
 * fresh credentials; `Settings` opens the bank's configuration page; `Remove`
 * is last and destructive — it stays tappable while accounts are linked so the
 * tap can explain the block (the server enforces the same rule with a 409).
 */
export function connectionRowActions({ status }: { status: string }): ConnectionRowAction[] {
  const actions: ConnectionRowAction[] = [
    { kind: 'sync', label: 'Sync now', disabled: status !== 'connected' },
    { kind: 'reimport', label: 'Re-import history', disabled: status !== 'connected' },
  ];

  if (requiresReauth(status)) {
    actions.splice(1, 0, { kind: 'reconnect', label: 'Reconnect credentials' });
  }

  actions.push({ kind: 'settings', label: 'Settings' });
  actions.push({ kind: 'disconnect', label: 'Remove', danger: true });

  return actions;
}

/** What tapping Remove should do on native: explain the block or confirm. */
export function removeConfirmation(
  institution: string,
  linkedCount: number,
): { kind: 'blocked' | 'confirm'; title: string; message: string } {
  if (linkedCount > 0) {
    return {
      kind: 'blocked',
      title: `Can't remove ${institution}`,
      message: `Unlink the ${linkedCount} linked account${linkedCount === 1 ? '' : 's'} in the account editor first.`,
    };
  }
  return {
    kind: 'confirm',
    title: `Remove ${institution}?`,
    message: 'The bank connection is deleted. Imported history stays in your budget.',
  };
}
