/**
 * ConnectionRowMenu (iOS) — the bank-connection row's option menu as a native
 * SwiftUI `ContextMenu` through `@expo/ui` (the `TxnMenuTrigger.ios.tsx`
 * recipe): long-press anywhere on the row opens the system menu; the hosted
 * `Pressable` keeps handling taps. A lifted preview shows the row as a
 * rounded card. Action set/labels/disabled rules come from
 * `connectionRowMenuShared`; icons are SF Symbols, mapped from the semantic
 * action kinds.
 */

import type { ReactElement } from 'react';

import { Button, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import type { SFSymbol } from 'sf-symbols-typescript';

import { colors } from '../../ui/theme';
import { connectionRowActions, type ConnectionRowAction } from './connectionRowMenuShared';

/** SF Symbols for the semantic action kinds (typed via `sf-symbols-typescript`). */
const SF_ICONS: Record<ConnectionRowAction['kind'], SFSymbol> = {
  sync: 'arrow.triangle.2.circlepath',
  reimport: 'arrow.counterclockwise',
  reconnect: 'key',
  settings: 'gearshape',
  disconnect: 'trash',
};

export function ConnectionRowMenu({
  status,
  busy,
  onSync,
  onReimport,
  onReconnect,
  onSettings,
  onDisconnect,
  children,
}: {
  status: string;
  busy: boolean;
  onSync: () => void;
  onReimport: () => void;
  onReconnect: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
  /** The row content — hosted as the long-press trigger. */
  children: ReactElement;
}) {
  const handlers: Record<ConnectionRowAction['kind'], () => void> = {
    sync: onSync,
    reimport: onReimport,
    reconnect: onReconnect,
    settings: onSettings,
    disconnect: onDisconnect,
  };

  const actions = connectionRowActions({ status }).map((action) => ({
    ...action,
    onPress: handlers[action.kind],
  }));

  return (
    <Host matchContents={{ vertical: true }}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>{children}</RNHostView>
        </ContextMenu.Trigger>
        {/* Lifted preview (iOS 16+): the row itself raised as a rounded card. */}
        <ContextMenu.Preview>
          <RNHostView matchContents>
            <View style={previewBubble.container}>{children}</View>
          </RNHostView>
        </ContextMenu.Preview>
        <ContextMenu.Items>
          {actions.map((action) => (
            <Button
              key={action.kind}
              label={action.label}
              systemImage={SF_ICONS[action.kind]}
              role={action.danger ? 'destructive' : undefined}
              modifiers={[disabled(action.disabled || (busy && action.kind !== 'settings'))]}
              onPress={action.onPress}
            />
          ))}
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}

/** Card look for the long-press preview so the row lifts as a rounded bubble. */
const previewBubble = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
});
