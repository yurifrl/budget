/** Row primitives shared by the settings panes. */
import type { ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { s } from './styles';

/** One option in a segmented-select row (Plan Settings selects). */
export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.seg}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={[s.segBtn, o.value === value && s.segBtnActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          accessibilityLabel={o.label}>
          <Text style={[s.segText, o.value === value && s.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A menu list row — the switcher item look (pressed + active states). */
export function MenuRow({
  label,
  onPress,
  active,
  emphasized,
  chevron,
  trailing,
  dense,
}: {
  label: string;
  onPress: () => void;
  /** Content between the label and the chevron (e.g. the People avatar stack). */
  trailing?: ReactNode;
  /** Current selection highlight (budget switcher). */
  active?: boolean;
  /** CTA look (Create / Rename / Back to Plan). */
  emphasized?: boolean;
  /** Right glyph override; default is the navigable chevron. */
  chevron?: string;
  /** Shorter row: the root menu lists every section at once and must fit a laptop window. */
  dense?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        s.row,
        dense && s.rowDense,
        pressed && s.rowPressed,
        active && s.rowActive,
        emphasized && s.rowEmphasized,
      ]}>
      <Text style={[s.rowLabel, emphasized && s.rowLabelStrong, trailing ? { flex: 1 } : null]}>{label}</Text>
      {trailing}
      <Text style={s.rowChevron}>{chevron ?? '›'}</Text>
    </Pressable>
  );
}

export function ToggleRow({
  label,
  sub,
  value,
  onChange,
}: {
  label: string;
  sub: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={s.rowStatic}>
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

export function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <View style={s.rowStatic}>
      <Text style={s.shortcutKeys}>{keys}</Text>
      <Text style={s.rowSub}>{desc}</Text>
    </View>
  );
}
