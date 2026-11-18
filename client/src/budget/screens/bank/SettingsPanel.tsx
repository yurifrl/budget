/**
 * Bank settings: sync-history window, re-import, reconnect (when the bank needs
 * fresh credentials) and the danger zone. Rendered as a right-hand panel on
 * desktop and inside a sheet on phone/tablet — the content is identical.
 */

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { ConnectionJson } from '../../data/connections';
import { requiresReauth, syncWindowLabel } from '../../model/banks/connections';
import { colors, radius } from '../../ui/theme';
import { GhostButton, IndigoButton } from '../../ui/bits';
import { SyncWindowControl } from '../connect-bank/SyncWindowControl';

export function SettingsPanel({
  connection,
  appWindow,
  windowSaving,
  busy,
  reimporting,
  linkedCount,
  onPickWindow,
  onReimport,
  onReconnect,
  onRemove,
}: {
  connection: ConnectionJson;
  /** App-wide default window in days (undefined while loading). */
  appWindow: number | undefined;
  windowSaving: boolean;
  busy: boolean;
  reimporting: boolean;
  linkedCount: number;
  onPickWindow: (days: number | null) => void;
  onReimport: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const connected = connection.status === 'connected';
  return (
    <View style={styles.wrap}>
      <Section title="Sync history">
        <Text style={styles.hint}>How far back this bank&apos;s pulls reach. Default follows the app-wide setting.</Text>
        <SyncWindowControl
          days={windowSaving ? undefined : connection.sync_window_days}
          defaultLabel={appWindow == null ? '…' : syncWindowLabel(appWindow)}
          onPick={onPickWindow}
        />
        <View style={styles.row}>
          <GhostButton
            label="Re-import history"
            onPress={connected && !busy ? onReimport : undefined}
            style={[styles.btn, (!connected || busy) && styles.dim]}
          />
          {reimporting ? <ActivityIndicator color={colors.indigo2} /> : null}
        </View>
      </Section>

      {requiresReauth(connection.status) ? (
        <Section title="Credentials">
          <Text style={styles.hint}>The bank needs fresh credentials before it can sync again.</Text>
          <IndigoButton label="Reconnect" style={styles.btn} onPress={onReconnect} />
        </Section>
      ) : null}

      <Section title="Danger zone" danger>
        <Text style={styles.hint}>Removes the bank connection. Imported history stays in your budget.</Text>
        <GhostButton label="Remove bank" style={[styles.btn, styles.dangerBtn]} onPress={onRemove} />
        {linkedCount > 0 ? <Text style={styles.hint}>Unlink its accounts in the account editor first.</Text> : null}
      </Section>
    </View>
  );
}

function Section({ title, danger, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, danger && { color: colors.redFg }]}>{title}</Text>
      <View style={[styles.card, danger && { borderColor: colors.redFg }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  section: { gap: 6 },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  card: {
    gap: 10,
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card,
  },
  hint: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btn: { minHeight: 44, justifyContent: 'center' },
  dim: { opacity: 0.4 },
  dangerBtn: { alignSelf: 'flex-start', borderColor: colors.redFg },
});
