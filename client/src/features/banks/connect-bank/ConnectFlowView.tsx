import { ActivityIndicator, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { GhostButton } from '@/ui/bits';
import { colors } from '@/ui/theme';
import { ConnectBankWidget } from '../ConnectBankWidget';
import { t } from './i18n';
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
        <Text style={styles.title}>{connect.flow === 'new' ? t('flow.titleNew') : t('flow.titleReconnect')}</Text>
        <GhostButton label={tCommon('close')} onPress={connect.finish} />
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
              <Text style={styles.pendingText}>{t('flow.finishing')}</Text>
            </View>
          ) : null}
        </View>
      ) : connect.tokenLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
          <Text style={styles.pendingText}>{t('flow.opening')}</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
        </View>
      )}
    </>
  );
}
