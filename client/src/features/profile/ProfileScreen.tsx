/**
 * Profile page — your picture, name and email. Thin composition: data from
 * the profile api, the editors own their interactions.
 */
import { useRouter, type Href } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius } from '@/ui/theme';

import { useAuthSession } from '@/features/auth';
import { useGetMeQuery } from '@/profile/api';
import { AvatarEditor } from './AvatarEditor';
import { displayName } from '@/profile/model';
import { NameField } from './NameField';
import { ui } from './ui';

export function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: me, isLoading, isError, refetch } = useGetMeQuery();
  const { signOut } = useAuthSession();

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <Text style={styles.backGlyph}>{'‹'}</Text>
        </Pressable>
        <Text style={styles.title}>Profile</Text>
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          {isLoading ? (
            <ActivityIndicator style={styles.loading} />
          ) : isError || !me ? (
            <View style={[ui.card, styles.errorCard]}>
              <Text style={ui.error}>Couldn’t load your profile.</Text>
              <Pressable accessibilityRole="button" onPress={refetch} style={ui.button}>
                <Text style={ui.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.identity}>
                <Text style={styles.name}>{displayName(me)}</Text>
                {me.role === 'admin' ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>ADMIN</Text>
                  </View>
                ) : null}
              </View>
              <AvatarEditor me={me} />
              <NameField me={me} />
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/connected-apps' as Href)}
                style={ui.button}
              >
                <Text style={ui.buttonText}>Connected apps</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void signOut()} style={ui.button}>
                <Text style={ui.buttonText}>Sign out</Text>
              </Pressable>
            </>
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
  errorCard: { alignItems: 'center' },
  identity: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  name: { color: colors.text, fontSize: 24, fontWeight: '800' },
  badge: { backgroundColor: colors.indigoSoftCool, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: colors.indigo2, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
});
