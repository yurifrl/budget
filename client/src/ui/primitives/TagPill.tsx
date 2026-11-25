/**
 * Small colored text pill, shared by the transfer match pill and the
 * Categorize suggestion/confidence chips. Values are the theme's pill tokens,
 * so every chip follows the same palette; callers size it through `style`.
 */
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '@/ui/theme';

export type TagTone = 'green' | 'yellow' | 'gray' | 'blue' | 'indigo' | 'red';

const TONES: Record<TagTone, { bg: string; fg: string }> = {
  green: { bg: colors.greenPillBg, fg: colors.greenPillFg },
  yellow: { bg: colors.yellowPillBg, fg: colors.yellowPillFg },
  gray: { bg: colors.grayPillBg, fg: colors.grayPillFg },
  blue: { bg: colors.bluePillBg, fg: colors.blue },
  indigo: { bg: colors.indigoSoft, fg: colors.indigo3 },
  red: { bg: colors.redPillBg, fg: colors.redFg },
};

export function TagPill({
  label,
  tone,
  style,
  numberOfLines,
}: {
  label: string;
  tone: TagTone;
  style?: StyleProp<TextStyle>;
  /** Unset wraps (the transfers match pill); the Categorize chips pass 1. */
  numberOfLines?: number;
}) {
  const c = TONES[tone];
  return (
    <Text numberOfLines={numberOfLines} style={[styles.pill, { backgroundColor: c.bg, color: c.fg }, style]}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontSize: 11,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
});
