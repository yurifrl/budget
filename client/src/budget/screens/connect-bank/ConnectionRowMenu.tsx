/**
 * Web/Android no-op counterpart of the iOS row-menu wrapper
 * (`ConnectionRowMenu.ios.tsx`): those platforms reach the same actions via
 * the visible Sync button and the Edit button (bank settings page), so the
 * wrapper renders its children unchanged. It exists only so the row's
 * call-site JSX shape is identical on all platforms.
 */

import type { ReactNode } from 'react';

export function ConnectionRowMenu({
  status: _status,
  busy: _busy,
  onSync: _onSync,
  onReimport: _onReimport,
  onReconnect: _onReconnect,
  onSettings: _onSettings,
  onDisconnect: _onDisconnect,
  children,
}: {
  status: string;
  busy: boolean;
  onSync: () => void;
  onReimport: () => void;
  onReconnect: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  return <>{children}</>;
}
