/**
 * Connected apps — the OAuth grants (MCP clients, CLI) with access to your
 * account, each with a Revoke button.
 */
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/ui/theme';

import { useListGrantsQuery, useRevokeGrantMutation } from '@/profile/api';
import type { ConnectedApp } from '@/profile/model';
import { ui } from './ui';

const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 10);

function AppRow({ app }: { app: ConnectedApp }) {
  const [revoke, { isLoading }] = useRevokeGrantMutation();
  return (
    <View style={ui.card} testID={`grant-${app.id}`}>
      <Text style={styles.name}>{app.client_name}</Text>
      <Text style={ui.muted}>
        {app.scopes.includes('write') ? 'Read and write' : 'Read only'} · connected {fmt(app.created_at)}
        {app.last_used_at ? ` · last used ${fmt(app.last_used_at)}` : ''} · expires {fmt(app.expires_at)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Revoke ${app.client_name}`}
        disabled={isLoading}
        onPress={() => revoke(app.id)}
        style={[ui.button, isLoading && ui.buttonDisabled]}
      >
        <Text style={ui.buttonText}>{isLoading ? 'Revoking…' : 'Revoke'}</Text>
      </Pressable>
    </View>
  );
}

export function ConnectedAppsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, refetch } = useListGrantsQuery();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <Text style={styles.backGlyph}>{'‹'}</Text>
        </Pressable>
        <Text style={styles.title}>Connected apps</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          {isLoading ? (
            <ActivityIndicator style={styles.loading} />
          ) : isError || !data ? (
            <View style={[ui.card, styles.center]}>
              <Text style={ui.error}>Couldn’t load connected apps.</Text>
              <Pressable accessibilityRole="button" onPress={refetch} style={ui.button}>
                <Text style={ui.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : data.length === 0 ? (
            <Text style={[ui.muted, styles.center]}>No apps are connected to your account.</Text>
          ) : (
            data.map((app) => <AppRow key={app.id} app={app} />)
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 52 },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: colors.muted, fontSize: 30, lineHeight: 34 },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 16, fontWeight: '700' },
  scroll: { padding: 16, paddingBottom: 48 },
  column: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: 16 },
  loading: { marginTop: 80 },
  center: { alignItems: 'center' },
  name: { color: colors.text, fontSize: 18, fontWeight: '700' },
});
