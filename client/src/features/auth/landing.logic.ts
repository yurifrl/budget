/**
 * What the LoginGate puts on screen, as data: the app, a quiet spinner, or
 * the landing page in one of its two states (sign in / API unreachable).
 * Pure, so the rules ("never flash the landing page while an automatic
 * sign-in is still possible") are tested without a renderer; LoginGate.tsx
 * and LandingPage.tsx only draw the result.
 */
import { loginButtons, type LoginButton, type Providers, type SignInAction } from './signIn.logic';

export const PRODUCT_NAME = 'Budget';
/** The one line about the product. Only what the app does today: plan, accounts, spending, shared budgets. */
export const LANDING_HEADLINE = 'One budget for the whole household.';
export const LANDING_BODY =
  'Plan each month, keep your accounts up to date and see where the money goes, together with the people you share a budget with.';
/** There is no sign-up flow anywhere; say so instead of leaving people looking for one. */
export const LANDING_FOOTNOTE = 'There is no sign-up. Use the login you already have.';

export const UNREACHABLE_HEADLINE = 'Can’t reach the API';
export const UNREACHABLE_DEV_HINT = 'Start it with `task api`. If the URL looks wrong, restart Expo with `bun start --clear`.';

export type LandingView =
  | { kind: 'sign-in'; headline: string; body: string; footnote: string; buttons: LoginButton[]; passwordForm: boolean; notice: string | null }
  | { kind: 'unreachable'; headline: string; body: string; hint: string | null };

export type GateView = { kind: 'app' } | { kind: 'loading' } | { kind: 'landing'; view: LandingView };

export interface GateState {
  status: 'loading' | 'in' | 'out' | 'unreachable';
  action: SignInAction;
  providers: Providers;
  /** Sign-in error to show on the landing page (failed round-trip, cancelled native flow). */
  notice: string | null;
  apiUrl: string;
  dev: boolean;
}

export function gateView(s: GateState): GateView {
  if (s.status === 'in') return { kind: 'app' };
  if (s.status === 'unreachable') {
    return {
      kind: 'landing',
      view: {
        kind: 'unreachable',
        headline: UNREACHABLE_HEADLINE,
        body: `No answer from ${s.apiUrl}. Retrying automatically.`,
        hint: s.dev ? UNREACHABLE_DEV_HINT : null,
      },
    };
  }
  // Session probe, providers request or a navigation to the provider still in
  // flight: any of them may end signed in, so the landing page waits.
  if (s.status === 'loading' || s.action.kind !== 'show-login') return { kind: 'loading' };
  return {
    kind: 'landing',
    view: {
      kind: 'sign-in',
      headline: LANDING_HEADLINE,
      body: LANDING_BODY,
      footnote: LANDING_FOOTNOTE,
      buttons: loginButtons(s.providers),
      passwordForm: s.providers.password,
      notice: s.notice,
    },
  };
}

/** Wide windows get the two-pane layout; everything else the single column. */
export function landingLayout(media: { lg: boolean }): 'split' | 'stacked' {
  return media.lg ? 'split' : 'stacked';
}
