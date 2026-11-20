/**
 * The front door: what a signed-out person (or anyone while the API cannot
 * be reached) sees. One component for web and iOS, inside the frame it
 * shares with the home page (ui/BrandedPage): wide windows split into a brand
 * pane and a content pane; narrower ones stack, with the actions at the
 * bottom of the screen within thumb reach. What it says comes from
 * landing.logic.ts; how sign-in happens (redirect or in-app browser) is the
 * caller's business.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BrandedPage } from '@/ui/BrandedPage';
import { useMedia } from '@/ui/media';
import { colors, radius, spacing } from '@/ui/theme';
import { landingLayout, PRODUCT_NAME, type LandingView } from './landing.logic';
import { CHANGE_BODY, CHANGE_HEADLINE, OR_EMAIL_LABEL } from './password.logic';
import { NewPasswordForm, PasswordSignInForm } from './PasswordForms';
import type { PasswordSignIn } from './usePasswordSignIn';
import type { LoginButton } from './signIn.logic';

type Provider = LoginButton['provider'];

interface Props {
  view: LandingView;
  onSignIn: (provider: Provider) => Promise<void> | void;
  onRetry: () => void;
  /** The e-mail + password flow; null when the API does not offer it. */
  password?: PasswordSignIn | null;
}

export function LandingPage({ view, onSignIn, onRetry, password = null }: Props) {
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

  const changing = view.kind === 'sign-in' && password?.step.kind === 'change' ? password.step : null;

  const content = (
    <View style={[styles.content, split ? styles.contentSplit : styles.contentStacked]}>
      <Text accessibilityRole="header" style={[styles.headline, split && styles.headlineSplit]}>
        {changing ? CHANGE_HEADLINE : view.headline}
      </Text>
      <Text style={styles.body}>{changing ? CHANGE_BODY : view.body}</Text>

      {changing && password ? (
        <NewPasswordForm flow={password} email={changing.email} />
      ) : view.kind === 'sign-in' ? (
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
          {view.passwordForm && password ? (
            <>
              {view.buttons.length > 0 ? <Text style={styles.divider}>{OR_EMAIL_LABEL}</Text> : null}
              <PasswordSignInForm flow={password} primary={view.buttons.length === 0} />
            </>
          ) : null}
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

  return (
    <BrandedPage productName={PRODUCT_NAME} split={split}>
      {content}
    </BrandedPage>
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

  divider: { color: colors.muted, fontSize: 14, marginTop: spacing.sm },
  footnote: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
