import { StyleSheet, View } from 'react-native';

import type { FundingState } from '@/domain/types';
import { barColor, colors } from '@/ui/theme';

/** Funding progress bar under a category row (assigned vs needed). */
export function FundingBar({ state, fraction }: { state: FundingState; fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: barColor(state) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  barTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.grayPillBg,
    overflow: 'hidden',
    marginTop: 6,
  },
  barFill: { height: 3, borderRadius: 2 },
});
