/** `useMedia()` over `useWindowDimensions`, with Tamagui v5's breakpoints (see ./breakpoints.ts). */
import { Platform, useWindowDimensions } from 'react-native';

import { mediaForWidth, type Media } from './breakpoints';

export type { Media };

/** Current breakpoints for the window width; re-renders on resize. */
export function useMedia(): Media {
  const { width } = useWindowDimensions();
  return mediaForWidth(width, Platform.OS);
}
