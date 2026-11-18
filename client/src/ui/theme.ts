/**
 * Shared theme tokens for all modules — the single source.
 * Palette is the dark set from `mocks/demo.html` (the design reference);
 * budget's copy was the superset, spacing came from health/ourtube.
 */

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

  indigo: '#6c5ce7',
  indigo2: '#7d6ff0',
  indigoSoft: '#212745',
  railBg: '#0a0c13',
} as const;

export const spacing = {
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  r: 10,
  sm: 6,
  pill: 999,
} as const;
