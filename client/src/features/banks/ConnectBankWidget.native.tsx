/**
 * Native variant of the connect-widget driver (iOS/Android): the hosted
 * widget page inside a `react-native-webview`. The widget posts JSON events
 * over `ReactNativeWebView.postMessage`; each message is handed to `onEvent`
 * verbatim (string body — `domain/connections.ts` parses both shapes).
 *
 * `widgetUrl` already carries the connect token. OAuth connectors open their
 * bank login in a separate window (the widget's `connector-oauth-login`
 * channel); a WebView has no popups, so an injected `window.open` override
 * relays that channel onto the WebView's own message bus.
 */
import { WebView } from 'react-native-webview';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/** Bridges the widget's OAuth popup channel into the WebView message bus. */
const OAUTH_BRIDGE = `(function(){
  if (window.__syscdOauthBridge) return;
  window.__syscdOauthBridge = true;
  window.open = function (u) {
    window.ReactNativeWebView &&
      window.ReactNativeWebView.postMessage(JSON.stringify({ source: 'connector-oauth-login', message: String(u) }));
    return null;
  };
})();`;

export type ConnectBankWidgetProps = {
  style?: StyleProp<ViewStyle>;
  widgetUrl: string | null;
  connectToken: string;
  onEvent: (data: unknown) => void;
  onError: (message: string) => void;
};

export function ConnectBankWidget({ style, widgetUrl, onEvent }: ConnectBankWidgetProps) {
  return (
    <View style={style}>
      {widgetUrl ? (
        <WebView
          style={{ flex: 1 }}
          source={{ uri: widgetUrl }}
          injectedJavaScript={OAUTH_BRIDGE}
          onMessage={(event) => onEvent(event.nativeEvent.data)}
        />
      ) : null}
    </View>
  );
}
