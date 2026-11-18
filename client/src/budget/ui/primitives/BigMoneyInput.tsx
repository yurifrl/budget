import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import type { Cents } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { colors, radius } from '../theme';

/**
 * Hero amount field (mobile category detail / move-money pages): one large
 * centered input — the amount IS the page's headline. Same draft/commit
 * semantics as MoneyInput (blur/Enter commits, parseMoney reads pt-BR drafts,
 * the privacy mask blocks saving) without the operator popover; Escape resets
 * the draft. External cents changes re-seed the draft only while unfocused.
 */
export function BigMoneyInput({
  cents,
  onCommit,
  autoFocus = false,
  accent = colors.indigo2,
  color = colors.text,
  accessibilityLabel = 'Amount',
}: {
  cents: Cents;
  onCommit: (next: Cents) => void;
  autoFocus?: boolean;
  /** Focus-ring color (cover flows may pass red). */
  accent?: string;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { formatAmount, parseMoney, masked } = useMoneyFormat();
  const [text, setText] = useState(() => formatAmount(cents));
  const [focused, setFocused] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (focused) return;
    if (parseMoney(text) === cents) return;
    setText(formatAmount(cents));
  }, [cents, focused, text, formatAmount, parseMoney]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    // Privacy mask: YNAB parity — "Changes to amounts will not be saved."
    if (masked) return;
    const next = parseMoney(text);
    // Normalize the visible draft ("100" → "100,00") even when the parsed
    // value didn't change — the sync effect can't (parse-equal early return).
    const formatted = formatAmount(next);
    if (formatted !== text) setText(formatted);
    if (next !== cents) onCommit(next);
  };

  return (
    <View style={[styles.bigMoney, focused && { borderColor: accent }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onSubmitEditing={commit}
        onKeyPress={(e) => {
          if (e.nativeEvent.key !== 'Escape') return;
          cancelledRef.current = true;
          setText(formatAmount(cents));
        }}
        autoFocus={autoFocus}
        selectTextOnFocus
        keyboardType="numbers-and-punctuation"
        style={[styles.bigMoneyText, { color }]}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Hero amount field (BigMoneyInput): the amount as the page's headline.
  // stretch: parents center their children (hero rows), the field fills them.
  bigMoney: {
    alignSelf: 'stretch',
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.r,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  bigMoneyText: {
    width: '100%',
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    paddingVertical: 0,
  },
});
