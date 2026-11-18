/**
 * The front door: what a signed-out person (or anyone while the API cannot
 * be reached) sees. One component for web and iOS. Wide windows split into a
 * brand pane and a content pane; narrower ones stack, with the actions at the
 * bottom of the screen within thumb reach. What it says comes from
 * landing.logic.ts; how sign-in happens (redirect or in-app browser) is the
 * caller's business.
 */
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMedia } from '@/ui/media';
import { colors, radius, spacing } from '@/ui/theme';
import logo from '../../../assets/images/logo.png';
import { landingLayout, PRODUCT_NAME, type LandingView } from './landing.logic';
import type { LoginButton } from './signIn.logic';

type Provider = LoginButton['provider'];

interface Props {
  view: LandingView;
  onSignIn: (provider: Provider) => Promise<void> | void;
  onRetry: () => void;
}

export function LandingPage({ view, onSignIn, onRetry }: Props) {
  const insets = useSafeAreaInsets();
  const split = landingLayout(useMedia()) === 'split';
  // Native: the in-app browser is open until the flow resolves; no double starts.
  const [busy, setBusy] = useState<Provider | null>(null);

  const start = async (provider: Provider) => {
    if (busy) return;
    setBusy(provider);
    try {
      await onSignIn(provider);
    } finally {
      setBusy(null);
    }
  };

  const content = (
    <View style={[styles.content, split ? styles.contentSplit : styles.contentStacked]}>
      <Text accessibilityRole="header" style={[styles.headline, split && styles.headlineSplit]}>
        {view.headline}
      </Text>
      <Text style={styles.body}>{view.body}</Text>

      {view.kind === 'sign-in' ? (
        <>
          {view.notice ? (
            <View accessibilityRole="alert" style={styles.notice}>
              <Text style={styles.noticeText}>{view.notice}</Text>
            </View>
          ) : null}
          <View style={[styles.actions, split && styles.actionsSplit]}>
            {view.buttons.map((b, i) => (
              <ActionButton
                key={b.provider}
                label={b.label}
                primary={i === 0}
                busy={busy === b.provider}
                disabled={busy !== null}
                onPress={() => void start(b.provider)}
              />
            ))}
          </View>
          <Text style={styles.footnote}>{view.footnote}</Text>
        </>
      ) : (
        <>
          {view.hint ? <Text style={styles.footnote}>{view.hint}</Text> : null}
          <View style={[styles.actions, split && styles.actionsSplit]}>
            <ActionButton label="Retry now" primary onPress={onRetry} />
            <ActivityIndicator size="small" color={colors.muted} />
          </View>
        </>
      )}
    </View>
  );

  if (split) {
    return (
      <View style={[styles.screen, styles.row]}>
        <View style={[styles.brandPane, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}>
          <Brand />
          <Text style={styles.wordmark}>{PRODUCT_NAME}</Text>
        </View>
        <View style={styles.contentPane}>
          <ScrollView contentContainerStyle={styles.contentPaneInner}>{content}</ScrollView>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.stack,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
      ]}>
      <View style={styles.stackColumn}>
        <Brand named />
        {content}
      </View>
    </ScrollView>
  );
}

function Brand({ named = false }: { named?: boolean }) {
  return (
    <View style={styles.brand}>
      <Image source={logo} accessibilityLabel={named ? undefined : PRODUCT_NAME} style={styles.logo} />
      {named ? <Text style={styles.brandName}>{PRODUCT_NAME}</Text> : null}
    </View>
  );
}

function ActionButton({
  label,
  primary,
  busy = false,
  disabled = false,
  onPress,
}: {
  label: string;
  primary: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const active = state.pressed || ('hovered' in state && state.hovered === true);
        return [
          styles.button,
          primary ? styles.buttonPrimary : styles.buttonSecondary,
          active && (primary ? styles.buttonPrimaryActive : styles.buttonSecondaryActive),
          disabled && !busy && styles.buttonDisabled,
        ];
      }}>
      {busy ? <ActivityIndicator size="small" color={colors.white} /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row' },

  // Wide: a darker brand field on the left, the words and the action on the right.
  brandPane: {
    flex: 5,
    minWidth: 0,
    backgroundColor: colors.appRailBg,
    paddingHorizontal: 56,
    justifyContent: 'space-between',
  },
  wordmark: { color: colors.text, fontSize: 112, lineHeight: 112, fontWeight: '800', letterSpacing: -4 },
  contentPane: { flex: 6, minWidth: 0 },
  contentPaneInner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 72, paddingVertical: spacing.xl },

  // Narrow: one column, brand on top, content pushed to the bottom.
  stack: { flexGrow: 1, paddingHorizontal: spacing.lg },
  stackColumn: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center', justifyContent: 'space-between', gap: 40 },

  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 44, height: 44, borderRadius: 12 },
  brandName: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },

  content: { gap: spacing.md },
  contentSplit: { maxWidth: 460 },
  contentStacked: {},
  headline: { color: colors.text, fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -0.8 },
  headlineSplit: { fontSize: 44, lineHeight: 48, letterSpacing: -1.2 },
  body: { color: colors.text, fontSize: 17, lineHeight: 26 },

  notice: { backgroundColor: colors.redPillBg, borderRadius: radius.card10, paddingVertical: 12, paddingHorizontal: 14 },
  noticeText: { color: colors.redFg, fontSize: 15, lineHeight: 21 },

  actions: { gap: 12, marginTop: spacing.sm },
  actionsSplit: { flexDirection: 'row', alignItems: 'center' },
  button: {
    minHeight: 50,
    minWidth: 168,
    paddingHorizontal: 28,
    borderRadius: radius.card10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: colors.indigo },
  buttonPrimaryActive: { backgroundColor: colors.indigo2 },
  buttonSecondary: { backgroundColor: colors.card2 },
  buttonSecondaryActive: { backgroundColor: colors.hover },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '700' },

  footnote: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
