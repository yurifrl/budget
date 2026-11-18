/**
 * Web variant of the connect-widget driver, resolved by Metro on web builds
 * only. `react-native-webview` renders a "not supported" placeholder on web,
 * so there the widget is driven by Pluggy's official SDK — a zoid-backed
 * iframe modal that reports outcomes through its callbacks.
 *
 * The SDK mounts itself to `document.body` (outside this component's tree)
 * and styles its own overlay, so a visible slot is still rendered in-tree
 * for layout.
 */
import { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { PluggyConnect } from 'pluggy-connect-sdk';
import type { Item } from 'pluggy-js';

export type ConnectBankWidgetProps = {
  style?: StyleProp<ViewStyle>;
  widgetUrl: string | null;
  connectToken: string;
  onEvent: (data: unknown) => void;
  onError: (message: string) => void;
};

export function ConnectBankWidget({ style, widgetUrl, connectToken, onEvent, onError }: ConnectBankWidgetProps) {
  // Latest-callback refs: the SDK instance is created once per token; stale
  // closure handlers (e.g. captured before `busy` flipped) would otherwise
  // drop the success event.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const outcomeRef = useRef(false);
  outcomeRef.current = false;

  useEffect(() => {
    const sdk = new PluggyConnect({
      // connect.pluggy.ai by default; our connect-token endpoint can point at
      // another environment (sandbox).
      ...(widgetUrl ? { url: widgetUrl } : {}),
      connectToken,
      // Surface Pluggy's sandbox connectors (Pluggy Bank test users) in the
      // institution list — the only way to exercise real login flows without
      // live credentials.
      includeSandbox: true,
      onEvent: (payload: { event?: string; item?: Item }) => {
        // The SDK never emits `SUCCESS` through onEvent — events are progress
        // signals (SUBMITTED_*, LOGIN_SUCCESS, ITEM_RESPONSE, …), and the
        // terminal outcomes arrive through the dedicated callbacks below.
        // The one exception is ITEM_RESPONSE carrying a connected item
        // (UPDATED = synced, UPDATING = created, sync continues in background)
        // — some connectors never invoke the onSuccess callback, so this IS
        // their success signal. LOGIN_ERROR/OUTDATED/WAITING_USER_INPUT items
        // are not connected yet — they flow through onError/onClose instead.
        if (payload.event === 'OPEN') outcomeRef.current = false;
        const item = payload.item;
        const status = item?.status;
        if (payload.event !== 'ITEM_RESPONSE' || item == null || status == null) return;
        if (status !== 'UPDATED' && status !== 'UPDATING') return;
        outcomeRef.current = true;
        onEventRef.current({ event: 'SUCCESS', itemId: item.id });
      },
      onSuccess: (data: { item: Item }) => {
        outcomeRef.current = true;
        onEventRef.current({ event: 'SUCCESS', itemId: data.item.id });
      },
      onError: (error: { message: string; data?: { item: Item } }) => {
        outcomeRef.current = true;
        onErrorRef.current(error.message);
      },
      onClose: () => {
        if (!outcomeRef.current) onEventRef.current({ event: 'CLOSE' });
      },
    });
    void sdk.init();
    return () => {
      void sdk.destroy();
    };
  }, [connectToken, widgetUrl]);

  return <View style={style ?? { flex: 1 }} />;
}
