import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import type { Cents, FundingState } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { barColor, colors, pillColors, radius } from '../theme';

/** YNAB-style target-progress ball (syscd-app-6jns): a small ring that fills
 * clockwise with the category's funding progress. Null/undefined renders
 * nothing — only categories with a target show it. */
function ProgressBall({ state, progress }: { state: FundingState; progress: number }) {
  const pct = Math.max(0, Math.min(1, progress));
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <Svg width={15} height={15} viewBox="0 0 15 15">
      <Circle cx={7.5} cy={7.5} r={r} stroke={colors.faint} strokeWidth={2.5} fill="none" />
      <Circle
        cx={7.5}
        cy={7.5}
        r={r}
        stroke={barColor(state)}
        strokeWidth={2.5}
        fill="none"
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 7.5 7.5)"
      />
    </Svg>
  );
}

/** The AVAILABLE pill, colored by funding state. `progress` (0..1) shows the
 * YNAB target ball left of the amount when set. */
export function Pill({
  state,
  cents,
  progress,
  small = false,
  onPress,
}: {
  state: FundingState;
  cents: Cents;
  progress?: number | null;
  /** Compact padding/font — phone rows, where a wide amount ("R$ 4.453,69")
   * would overflow the AVAILABLE cell over the ASSIGNED column. */
  small?: boolean;
  /** Receives the press event: web pill presses anchor the move popover at
   * the pill (syscd-app-pjtv) via nativeEvent.pageX/pageY. */
  onPress?: (e: GestureResponderEvent) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const c = pillColors(state);
  const pill = (
    <View style={[styles.pill, small && styles.pillSmall, { backgroundColor: c.bg }]}>
      {progress != null ? <ProgressBall state={state} progress={progress} /> : null}
      <Text style={[styles.pillText, small && styles.pillTextSmall, { color: c.fg }]}>{formatMoney(cents)}</Text>
    </View>
  );
  if (!onPress) return pill;
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityLabel="Available — move money">
      {pill}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    alignSelf: 'flex-end',
  },
  pillText: { fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] },
  pillSmall: { paddingHorizontal: 7, gap: 4 },
  pillTextSmall: { fontSize: 12 },
});
