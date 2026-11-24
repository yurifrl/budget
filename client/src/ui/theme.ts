/**
 * The app's ONE theme: color, radius and spacing tokens — the dark palette
 * from `mocks/demo.html` (the design reference). Budget's token set is
 * canonical (phase 5e merged the old shared `ui/theme.ts` into it); the few
 * values only the profile/auth screens and the combobox used are kept under
 * their own names so nothing changes on screen.
 */

import type { Cents, FlagColor, FundingState } from '@/domain/types';

export const colors = {
  bg: '#0c0f16',
  bg2: '#10131a',
  card: '#161a24',
  card2: '#1b2030',
  hover: '#222838',
  border: '#242b3a',
  border2: '#333c50',
  text: '#eef1f7',
  muted: '#98a2b5',
  faint: '#5f6878',

  green: '#37b35e',
  greenPillBg: '#16331f',
  greenPillFg: '#5fd381',
  yellow: '#e6b53e',
  yellowPillBg: '#382f12',
  yellowPillFg: '#e6b53e',
  red: '#e0533d',
  redFg: '#ff7a64',
  redPillBg: '#3a1f1b',
  grayPillBg: '#252c3b',
  grayPillFg: '#8a93a6',
  /** Transfers between own accounts (budget-mit6): ⇄ suggestion icon, transfer pills, active filter chip. */
  blue: '#6cb6ff',
  bluePillBg: '#14263d',
  blueBorder: '#3d6ea8',
  blueSoft: '#141c2a',

  indigo: '#6c5ce7',
  indigo2: '#7d6ff0',
  /** YNAB-accounts-toolbar periwinkle (icon fills / toolbar labels, syscd-accounts). */
  indigo3: '#a5acf9',
  indigoSoft: '#211d3b',

  /** RTA banner gradient endpoints / border. */
  rtaBg: '#123018',
  rtaBorder: '#2c6b41',
  rtaSub: '#bfe8cd',

  appRailBg: '#070910',
  railBg: '#0a0c13',

  /** Text and glyphs on saturated fills (buttons, badges, avatars). */
  white: '#fff',
  /** Shadows and scrims. */
  black: '#000',

  /** The pre-merge shared theme's indigoSoft (Profile's selected chip). */
  indigoSoftCool: '#212745',
} as const;

/** Spacing scale (profile / connected apps). */
export const spacing = {
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  r: 14,
  sm: 9,
  pill: 999,
  /** Pre-merge shared-theme radii: profile cards/fields (10) and the combobox (6). */
  card10: 10,
  field6: 6,
} as const;

/** YNAB flag palette — one source; SelectionBar menu and the Settings panel's
 * Edit Flags sub-view share it. */
export const FLAG_COLORS: { key: FlagColor; hex: string }[] = [
  { key: 'red', hex: '#e14b4b' },
  { key: 'orange', hex: '#f2913d' },
  { key: 'yellow', hex: '#f5c93f' },
  { key: 'green', hex: '#4caf6d' },
  { key: 'blue', hex: '#5b8def' },
  { key: 'purple', hex: '#8d67e5' },
];

/** Pill background/foreground for a funding state (mock .pill.g/.y/.r/.gray). */
export function pillColors(state: FundingState): { bg: string; fg: string } {
  switch (state) {
    case 'green':
      return { bg: colors.greenPillBg, fg: colors.greenPillFg };
    case 'yellow':
    case 'credit':
      return { bg: colors.yellowPillBg, fg: colors.yellowPillFg };
    case 'red':
      return { bg: colors.redPillBg, fg: colors.redFg };
    case 'gray':
      return { bg: colors.grayPillBg, fg: colors.grayPillFg };
  }
}

/** Funding state for a raw cents amount (negative red, positive green, zero
 * gray) — reuses the AVAILABLE pill language for amounts without a category
 * object at hand. */
export function centsPillState(cents: Cents): FundingState {
  return cents < 0 ? 'red' : cents > 0 ? 'green' : 'gray';
}

/** Progress-bar color for a funding state (red precedence handled by the engine). */
export function barColor(state: FundingState): string {
  switch (state) {
    case 'green':
      return colors.green;
    case 'yellow':
    case 'credit':
      return colors.yellow;
    case 'red':
      return colors.red;
    case 'gray':
      return colors.grayPillFg;
  }
}
