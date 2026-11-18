/**
 * The panels TxnRowMenu swaps inside its card: the main item list and the
 * Match / Make Repeating / Flag / Categorize / Move to Account submenus.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { displayFlagLabel, type FlagLabels } from '@/domain/flagLabels';
import { REPEAT_FREQS, REPEAT_LABELS } from '@/domain/inlineAdd';
import type { Budget, FlagColor, RepeatFrequency, Transaction } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { FLAG_COLORS, colors } from '@/ui/theme';
import { menuCategoryGroups, type MainItem, type MainItemKey } from './txnRowMenu.logic';

/** The main list: icon, label, shortcut chips and ▸ per item, hairline dividers between sections. */
export function MainPanel({ sections, onItem }: { sections: MainItem[][]; onItem: (key: MainItemKey) => void }) {
  return (
    <View>
      {sections.map((sec, si) => (
        <View key={si}>
          {si > 0 ? <View style={styles.divider} /> : null}
          {sec.map((it) => (
            <Pressable
              key={it.key}
              style={styles.item}
              disabled={it.disabled}
              onPress={() => onItem(it.key)}
              accessibilityLabel={it.label.replace('…', '')}>
              <View style={styles.itemIcon}>
                <Ionicons
                  name={it.icon}
                  size={15}
                  color={it.danger ? colors.redFg : it.disabled ? colors.faint : colors.muted}
                />
              </View>
              <Text
                style={[
                  styles.itemText,
                  it.danger && styles.itemDanger,
                  it.disabled && styles.itemDisabled,
                ]}>
                {it.label}
              </Text>
              {it.kbd ? (
                <View style={styles.kbdRow}>
                  {it.kbd.map((k) => (
                    <Text key={k} style={styles.kbd}>
                      {k}
                    </Text>
                  ))}
                </View>
              ) : null}
              {it.submenu ? <Text style={styles.itemHint}>▸</Text> : null}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Match: the rows this one can pair with, plus the current partner. */
export function MatchPanel({
  candidates,
  matched,
  onMatch,
}: {
  candidates: Transaction[];
  matched: Transaction | undefined;
  onMatch: (other: Transaction) => void;
}) {
  const { formatDate, formatMoney } = useMoneyFormat();
  return (
    <View>
      {candidates.length === 0 ? (
        <Text style={styles.empty}>No matching transactions</Text>
      ) : (
        candidates.map((t) => (
          <Pressable
            key={t.id}
            style={styles.item}
            onPress={() => onMatch(t)}
            accessibilityLabel={`Match with ${t.payee}`}>
            <Text style={styles.itemText} numberOfLines={1}>
              {t.payee || '(no payee)'}
            </Text>
            <Text style={styles.itemHint}>
              {formatDate(t.date)} · {formatMoney(t.inflow - t.outflow)}
            </Text>
          </Pressable>
        ))
      )}
      {matched ? (
        <Text style={styles.empty}>Matched with {matched.payee || '(no payee)'}</Text>
      ) : null}
    </View>
  );
}

export function RepeatPanel({ onPick }: { onPick: (frequency: RepeatFrequency) => void }) {
  return (
    <View>
      {REPEAT_FREQS.map((f) => (
        <Pressable key={f} style={styles.item} onPress={() => onPick(f)}>
          <Text style={styles.itemText}>{REPEAT_LABELS[f]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function FlagPanel({ flagLabels, onPick }: { flagLabels: FlagLabels; onPick: (flag: FlagColor | null) => void }) {
  return (
    <View>
      <Pressable
        style={styles.item}
        onPress={() => onPick(null)}
        accessibilityLabel="No flag">
        <View style={styles.itemIcon}>
          <Ionicons name="flag" size={15} color={colors.faint} />
        </View>
        <Text style={styles.itemText}>No flag</Text>
      </Pressable>
      {FLAG_COLORS.map((f) => (
        <Pressable
          key={f.key}
          style={styles.item}
          onPress={() => onPick(f.key)}
          accessibilityLabel={displayFlagLabel(flagLabels, f.key)}>
          <View style={styles.itemIcon}>
            <Ionicons name="flag" size={15} color={f.hex} />
          </View>
          <Text style={styles.itemText}>{displayFlagLabel(flagLabels, f.key)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function CategoryPanel({
  budget,
  onPick,
}: {
  budget: Pick<Budget, 'groups' | 'categories'>;
  /** null = Ready to Assign. */
  onPick: (categoryId: string | null) => void;
}) {
  return (
    <ScrollView style={styles.listScroll} contentContainerStyle={{ paddingBottom: 4 }}>
      <Pressable style={styles.item} onPress={() => onPick(null)}>
        <View style={styles.itemIcon}>
          <Ionicons name="pricetag-outline" size={15} color={colors.faint} />
        </View>
        <Text style={styles.itemText}>Ready to Assign</Text>
      </Pressable>
      {menuCategoryGroups(budget).map((g) => (
        <View key={g.id}>
          <Text style={styles.groupLabel}>{g.name}</Text>
          {g.categories.map((c) => (
            <Pressable key={c.id} style={styles.item} onPress={() => onPick(c.id)}>
              <View style={styles.itemIcon}>
                <Ionicons name="pricetag-outline" size={15} color={colors.muted} />
              </View>
              <Text style={styles.itemText} numberOfLines={1}>
                {c.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
  </ScrollView>
  );
}

export function MovePanel({ targets, onPick }: { targets: { id: string; name: string }[]; onPick: (accountId: string) => void }) {
  return (
    <View>
      {targets.map((a) => (
        <Pressable
          key={a.id}
          style={styles.item}
          onPress={() => onPick(a.id)}
          accessibilityLabel={`Move to ${a.name}`}>
          <Text style={styles.itemText} numberOfLines={1}>
            {a.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 3 },
  item: { paddingVertical: 7, paddingHorizontal: 14, flexDirection: 'row', gap: 8, alignItems: 'center' },
  itemIcon: { width: 22, alignItems: 'center' },
  itemText: { color: colors.text, fontSize: 13, flexShrink: 1 },
  itemHint: { color: colors.muted, fontSize: 12 },
  kbdRow: { marginLeft: 'auto', flexDirection: 'row', gap: 3, alignItems: 'center' },
  kbd: {
    minWidth: 18,
    paddingVertical: 1,
    paddingHorizontal: 4,
    textAlign: 'center',
    color: colors.muted,
    fontSize: 10,
    fontWeight: '600',
    backgroundColor: colors.card2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  listScroll: { maxHeight: 320, flexGrow: 0 },
  groupLabel: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 2,
  },
  itemDanger: { color: colors.redFg },
  itemDisabled: { color: colors.faint },
  empty: { color: colors.muted, fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
});
