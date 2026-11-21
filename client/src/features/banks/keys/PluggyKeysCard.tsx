/**
 * The key set card of "Your Pluggy keys": the entry form (empty / replacing)
 * or the saved state (client id, secret shown only as saved, Replace and
 * Remove with an inline confirmation). The secret is never shown back.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PasswordField } from '@/features/auth';
import { colors, radius } from '@/ui/theme';
import { formatSyncStamp } from '../model/connections';
import type { PluggyKeysState } from './usePluggyKeys';

export function PluggyKeysCard({ keys }: { keys: PluggyKeysState }) {
  if (keys.mode === 'loading') {
    return (
      <View style={[styles.card, styles.center]}>
        <ActivityIndicator color={colors.indigo2} />
      </View>
    );
  }
  if (keys.mode === 'failed') {
    return (
      <View style={styles.card}>
        <Text style={styles.errorText}>Could not load your keys.</Text>
        <Button label="Retry" onPress={() => void keys.retry()} />
      </View>
    );
  }
  return keys.mode === 'saved' ? <SavedKeys keys={keys} /> : <KeysForm keys={keys} />;
}

function SavedKeys({ keys }: { keys: PluggyKeysState }) {
  const { credentials } = keys;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>YOUR KEYS</Text>
      <Row label="Client id" value={credentials?.clientId ?? ''} />
      <Row label="Client secret" value="Saved (hidden)" />
      {credentials?.updatedAt ? <Text style={styles.muted}>{`Saved ${formatSyncStamp(credentials.updatedAt)}`}</Text> : null}
      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}
      {keys.error?.field === 'form' ? <Text style={styles.errorText}>{keys.error.message}</Text> : null}
      {keys.confirmingRemove ? (
        <View style={styles.confirm}>
          <Text style={styles.body}>
            Remove your keys? Banks connected with them stop syncing (paused, not deleted) until you save the same keys again.
          </Text>
          <View style={styles.row}>
            <Button label="Cancel" onPress={() => keys.setConfirmingRemove(false)} grow />
            <Button label={keys.removing ? 'Removing…' : 'Remove keys'} danger busy={keys.removing} onPress={() => void keys.remove()} grow />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button label="Replace keys" onPress={keys.startReplace} grow />
          <Button label="Remove" danger onPress={() => keys.setConfirmingRemove(true)} grow />
        </View>
      )}
    </View>
  );
}

function KeysForm({ keys }: { keys: PluggyKeysState }) {
  const { error } = keys;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{keys.mode === 'replacing' ? 'REPLACE YOUR KEYS' : 'ADD YOUR KEYS'}</Text>
      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}
      <PasswordField
        label="Client id"
        value={keys.clientId}
        onChangeText={keys.setClientId}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. 3f2a…"
        invalid={error?.field === 'clientId'}
      />
      {error?.field === 'clientId' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <PasswordField
        label="Client secret"
        value={keys.clientSecret}
        onChangeText={keys.setClientSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        spellCheck={false}
        placeholder={keys.mode === 'replacing' ? 'Paste the new secret' : 'Paste the secret'}
        returnKeyType="go"
        onSubmitEditing={() => void keys.save()}
        invalid={error?.field === 'clientSecret'}
      />
      {error?.field === 'clientSecret' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <Text style={styles.muted}>Pluggy checks the pair before it is saved. The secret is stored encrypted and never shown again.</Text>
      {error?.field === 'form' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <View style={styles.row}>
        {keys.mode === 'replacing' ? <Button label="Cancel" onPress={keys.cancelReplace} grow /> : null}
        <Button label={keys.saving ? 'Checking with Pluggy…' : 'Save keys'} primary busy={keys.saving} onPress={() => void keys.save()} grow />
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue} selectable numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  primary,
  danger,
  busy,
  grow,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger, grow && styles.grow, busy && styles.btnBusy]}>
      <Text style={[styles.btnText, danger && !primary && styles.btnDangerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card10,
    padding: 16,
    gap: 10,
  },
  center: { alignItems: 'center', paddingVertical: 32 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  okText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  errorText: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  kvLabel: { color: colors.muted, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  confirm: { gap: 10, backgroundColor: colors.redPillBg, borderRadius: radius.sm, padding: 12 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  grow: { flex: 1 },
  btn: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  btnPrimary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  btnDanger: { borderColor: colors.red },
  btnBusy: { opacity: 0.6 },
  btnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  btnDangerText: { color: colors.redFg },
});
