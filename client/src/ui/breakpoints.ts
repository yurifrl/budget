/**
 * Width breakpoints for the responsive shell, replacing Tamagui's `useMedia`
 * (hook in ./media.ts; this file is pure so bun can test it).
 *
 * Reproduces the two keys the app read from `@tamagui/config/v5` (3.1.x,
 * `src/media.ts`): `max-md` = `maxWidth: 768 - nonOverlap` and
 * `lg` = `minWidth: 1024`, where Tamagui's `mediaQueryForceNonOverlap` is
 * 0.02 on web and 1 on native. So: phone ≤ 767.98 (web) / ≤ 767 (native),
 * desktop ≥ 1024, tablet in between.
 */
export const BREAKPOINTS = { md: 768, lg: 1024 } as const;

export interface Media {
  'max-md': boolean;
  lg: boolean;
}

/** Breakpoints for a window width on a platform (`Platform.OS`). */
export function mediaForWidth(width: number, os: string): Media {
  const nonOverlap = os === 'web' ? 0.02 : 1;
  return {
    'max-md': width <= BREAKPOINTS.md - nonOverlap,
    lg: width >= BREAKPOINTS.lg,
  };
}
