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

import { pluggyLanguage } from './model/connections';

/** Bridges the widget's OAuth popup channel into the WebView message bus (code, not text). */
// eslint-disable-next-line budget-i18n/no-untranslated-string -- JavaScript injected into the webview, not UI text
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

/** The hosted widget page in the app's language (`language` query param, same 2-letter code as the web SDK). */
function withLanguage(url: string): string {
  if (/[?&]language=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}language=${pluggyLanguage()}`;
}

export function ConnectBankWidget({ style, widgetUrl, onEvent }: ConnectBankWidgetProps) {
  return (
    <View style={style}>
      {widgetUrl ? (
        <WebView
          style={{ flex: 1 }}
          source={{ uri: withLanguage(widgetUrl) }}
          injectedJavaScript={OAUTH_BRIDGE}
          onMessage={(event) => onEvent(event.nativeEvent.data)}
        />
      ) : null}
    </View>
  );
}
