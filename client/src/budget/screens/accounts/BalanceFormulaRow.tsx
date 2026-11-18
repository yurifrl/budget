/**
 * YNAB-style balance formula row — Cleared + Uncleared = Working, laid out as
 * value-over-label terms joined by + and = separators. Cleared and Working are
 * green; the uncleared term is green when non-negative and red when negative.
 * `compact` (phone) shortens the labels so the identity stays on one line
 * inside the stacked header; the parent owns horizontal padding.
 * `hero` (phone, YNAB iOS parity) renders the big centered Working Balance
 * value with an expand chevron; tapping it reveals the Cleared + Uncleared
 * terms inline. The same Term pair backs both modes, so there is no duplicate
 * formula rendering.
 * Sums come from the account's cleared/uncleared aggregates, so the identity
 * holds for a single account and for the all-accounts aggregate alike.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatMoney } from '../../domain/format';
import type { Cents } from '../../domain/types';
import { colors } from '../../ui/theme';

function Term({ label, cents }: { label: string; cents: Cents }) {
  return (
    <View style={styles.term}>
      <Text style={[styles.value, cents < 0 && styles.valueNeg]}>{formatMoney(cents)}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

export function BalanceFormulaRow({
  cleared,
  uncleared,
  working,
  compact = false,
  hero = false,
}: {
  cleared: Cents;
  uncleared: Cents;
  working: Cents;
  /** Phone: short labels + no inset so all three terms fit on one line. */
  compact?: boolean;
  /** Phone hero: big centered working balance, chevron expands the formula. */
  hero?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (hero) {
    return (
      <View style={styles.hero}>
        <View style={styles.heroRow}>
          <Text style={[styles.heroValue, working < 0 && styles.valueNeg]}>
            {formatMoney(working)}
          </Text>
          <Pressable
            hitSlop={8}
            onPress={() => setExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide balance details' : 'Show balance details'}
          >
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.faint}
            />
          </Pressable>
        </View>
        {expanded ? (
          <View style={styles.heroDetail}>
            <Term label="Cleared" cents={cleared} />
            <Text style={styles.op}>+</Text>
            <Term label="Uncleared" cents={uncleared} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Term label={compact ? 'Cleared' : 'Cleared Balance'} cents={cleared} />
      <Text style={styles.op}>+</Text>
      <Term label={compact ? 'Uncleared' : 'Uncleared Balance'} cents={uncleared} />
      <Text style={styles.op}>=</Text>
      <Term label={compact ? 'Working' : 'Working Balance'} cents={working} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    flexWrap: 'wrap',
  },
  hero: { alignItems: 'center', paddingVertical: 4 },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heroValue: {
    color: colors.greenPillFg,
    fontSize: 28,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  heroDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 4,
  },
  term: { gap: 1 },
  value: {
    color: colors.greenPillFg,
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  valueNeg: { color: colors.redFg },
  label: { color: colors.faint, fontSize: 11 },
  op: { color: colors.muted, fontSize: 15, fontWeight: '700' },
});