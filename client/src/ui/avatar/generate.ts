/**
 * Deterministic generated avatars — pure TS, no React, no renderer.
 *
 * `generateAvatar(seed)` returns an {@link AvatarSpec}: plain data (colors,
 * transforms, feature choices) for a friendly abstract "beam"-style face — a
 * tinted background, an offset/rotated face blob, eyes with variable spacing,
 * a smile/open mouth and optional blush/brows. The spec is renderer
 * independent; scene.ts turns it into drawing primitives and AvatarArt.tsx
 * paints those with react-native-svg.
 *
 * Randomness: the seed string goes through xmur3 (string hash) into mulberry32
 * (PRNG). Features are drawn in a FIXED order so a given seed always yields
 * the same face; never reorder the draws without accepting that every
 * existing avatar changes.
 */

/** Hash a string into a 32-bit seed (xmur3). */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG: returns a function yielding floats in [0, 1). */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type EyeKind = 'dot' | 'oval' | 'happy' | 'sleepy' | 'wink';
export type MouthKind = 'smile' | 'grin' | 'open' | 'o' | 'smirk';
export type BrowKind = 'none' | 'arch' | 'flat';
export type DecorKind = 'none' | 'circle' | 'ring' | 'band';

export interface AvatarSpec {
  /** Background tint. */
  bg: string;
  /** Face blob color. */
  face: string;
  /** Accent: decoration color and the person's identity color. */
  accent: string;
  /** Feature (eyes/mouth) color — chosen for contrast against `face`. */
  ink: string;
  decor: DecorKind;
  /** Decoration anchor, viewBox units (0..100). */
  decorX: number;
  decorY: number;
  faceShape: {
    /** Side of the (rounded-square) face blob. */
    size: number;
    /** Corner radius; size / 2 is a full circle. */
    radius: number;
    /** Offset from the viewBox center. */
    dx: number;
    dy: number;
    /** Degrees; the features rotate with the face. */
    rotate: number;
  };
  eyes: {
    kind: EyeKind;
    /** Half the distance between the eyes. */
    spacing: number;
    /** Offset from the face center (negative = above). */
    y: number;
    size: number;
  };
  mouth: {
    kind: MouthKind;
    /** Half the mouth width. */
    width: number;
    y: number;
    /** Control-point depth of the curve (smile/smirk) or half-height (grin/open). */
    depth: number;
  };
  brow: BrowKind;
  blush: boolean;
}

/** [background, face, accent] — curated so every triple reads on dark AND light UIs. */
const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#3b2a8f', '#ffc27a', '#ff6f9c'],
  ['#0f5b6e', '#ffd56b', '#ff5d7d'],
  ['#2a4d5c', '#f2d27a', '#f59e6c'],
  ['#4a3aa8', '#9ef0c8', '#ff9ccf'],
  ['#6a2f9a', '#ffd9b0', '#ff8da1'],
  ['#1d6b3f', '#fff0a0', '#ff7eb6'],
  ['#a2431a', '#ffd9b3', '#5ab0ff'],
  ['#2147a8', '#aaf3ff', '#ff9aa8'],
  ['#9c1f5c', '#ffd0ea', '#ffe14d'],
  ['#146b66', '#ffb0a6', '#ffd75e'],
  ['#5b2bb5', '#cfc2ff', '#ffb36b'],
  ['#4a7a1c', '#e2ff9e', '#ff7a8f'],
  ['#c2501a', '#fff29a', '#4cc3ff'],
  ['#3a37b3', '#ffa9b8', '#9ff0cf'],
  ['#0f6a9c', '#ffc07a', '#f5a3ff'],
  ['#8a2aa0', '#b7c4ff', '#ffe08a'],
  ['#b0334a', '#ffe0c2', '#7fe0d0'],
  ['#2b5a3a', '#ffd6a8', '#c9a6ff'],
];

const EYES: readonly EyeKind[] = ['dot', 'dot', 'oval', 'oval', 'happy', 'sleepy', 'wink'];
const MOUTHS: readonly MouthKind[] = ['smile', 'smile', 'grin', 'grin', 'open', 'o', 'smirk'];
const BROWS: readonly BrowKind[] = ['none', 'none', 'arch', 'flat'];
const DECORS: readonly DecorKind[] = ['none', 'circle', 'circle', 'ring', 'band'];

const INK_DARK = '#1c1530';
const INK_LIGHT = '#ffffff';

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Deterministic avatar spec for a seed. Same seed → identical spec. */
export function generateAvatar(seed: string): AvatarSpec {
  const rand = mulberry32(xmur3(seed));
  const range = (min: number, max: number) => round1(min + rand() * (max - min));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

  const [bg, face, accent] = pick(PALETTES);
  const size = range(66, 76);
  const spec: AvatarSpec = {
    bg,
    face,
    accent,
    ink: luminance(face) > 0.4 ? INK_DARK : INK_LIGHT,
    decor: pick(DECORS),
    decorX: range(14, 86),
    decorY: range(14, 86),
    faceShape: {
      size,
      radius: round1(size * range(0.3, 0.5)),
      dx: range(-7, 7),
      dy: range(-6, 6),
      rotate: range(-16, 16),
    },
    eyes: {
      kind: pick(EYES),
      spacing: range(11, 16),
      y: range(-9, -3),
      size: range(4.6, 6),
    },
    mouth: {
      kind: pick(MOUTHS),
      width: range(8, 13),
      y: range(11, 18),
      depth: range(7, 12),
    },
    brow: pick(BROWS),
    blush: rand() < 0.5,
  };
  return spec;
}

/** The person's accent color — for chips, rings and other identity tints. */
export function avatarColor(seed: string): string {
  return generateAvatar(seed).accent;
}
