import { ActivityIndicator, Text, View } from 'react-native';

import { GhostButton } from '@/ui/bits';
import { colors } from '@/ui/theme';
import { ConnectBankWidget } from '../ConnectBankWidget';
import { styles } from './screenStyles';
import type { ConnectFlow } from './useConnectFlow';

/** The connect widget for a new bank or a re-auth, with its pending states (rendered inside the screen frame). */
export function ConnectFlowView({
  connect,
  error,
  setError,
}: {
  connect: ConnectFlow;
  error: string | null;
  setError: (message: string | null) => void;
}) {
  return (
    <>
      <View style={styles.head}>
        <Text style={styles.title}>{connect.flow === 'new' ? 'Link bank account' : 'Reconnect bank'}</Text>
        <GhostButton label="Close" onPress={connect.finish} />
      </View>

      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {connect.widgetUrl && connect.connectToken ? (
        <View style={styles.webviewWrap}>
          <ConnectBankWidget
            style={styles.webview}
            widgetUrl={connect.widgetUrl}
            connectToken={connect.connectToken}
            onEvent={(data) => void connect.onWidgetMessage(data)}
            onError={setError}
          />
          {connect.busy && !connect.tokenLoading ? (
            <View style={styles.widgetOverlay}>
              <ActivityIndicator color={colors.indigo2} />
              <Text style={styles.pendingText}>Finishing the connection…</Text>
            </View>
          ) : null}
        </View>
      ) : connect.tokenLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
          <Text style={styles.pendingText}>Opening the connection window…</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
        </View>
      )}
    </>
  );
}
