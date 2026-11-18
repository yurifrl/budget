/**
 * TargetEditor — the YNAB-parity funding-target form (syscd-app-1n0s,
 * refs: CleanShot #8–#11): Weekly / Monthly / Yearly / Custom segmented
 * tabs, one MoneyInput for "I need", the per-kind config fields the engine
 * (domain/targets.ts) and the server whitelist (category-targets route)
 * consume, and a Delete / Cancel / Save footer.
 *
 * Purely presentational: parents own the RTK mutations. `onSave`/`onDelete`
 * return promises — a rejection keeps the form open with the error inline;
 * resolution calls `onSaved` (sheets close, inline editors reset).
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import { GhostButton, IndigoButton, MoneyInput } from '@/ui/bits';
import { DatePickerPopover } from '@/ui/dropdown/DatePickerPopover';
import { barColor, colors, radius } from '@/ui/theme';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { MONTH_ABBR, WEEKDAY_ABBR } from '@/domain/format';
import type { CategoryTarget, CategoryTargetConfig, Cents, FundingState, MonthKey, TargetKind } from '@/domain/types';
import { neededBy } from '@/domain/targets';

export interface TargetDraft {
  kind: TargetKind;
  amountCents: Cents;
  /** Preserved from the stored target across edits (syscd-app-hsjm). */
  snoozeMonth?: MonthKey | null;
  config: CategoryTargetConfig;
}

const KINDS: { key: TargetKind; label: string }[] = [
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
  { key: 'custom', label: 'Custom' },
];

const WEEKDAYS = WEEKDAY_ABBR;
const MONTHS = MONTH_ABBR;

/** Accepts calendar-picked or typed dates once committed as ISO (YYYY-MM-DD). */
const BY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A small labeled field row ("I need [input]") shared by every kind. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

/** Chip-select used for weekday / month-of-year choices. */
function ChipSelect({
  options,
  value,
  onSelect,
  columns,
}: {
  options: readonly string[];
  value: number;
  onSelect: (index: number) => void;
  columns?: number;
}) {
  return (
    <View style={[styles.chipWrap, columns ? { maxWidth: 999 } : null]}>
      {options.map((label, i) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityState={{ selected: i === value }}
          onPress={() => onSelect(i)}
          style={[styles.chip, i === value && styles.chipActive]}>
          <Text style={[styles.chipText, i === value && styles.chipTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Plain number entry for repeat counts / due days (positive integers). */
function NumberField({
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  value: number;
  onChange: (n: number) => void;
  accessibilityLabel: string;
  style?: object;
}) {
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      value={String(value)}
      onChangeText={(t) => {
        const n = parseInt(t.replace(/\D/g, ''), 10);
        if (!Number.isNaN(n)) onChange(Math.max(1, n));
      }}
      keyboardType="number-pad"
      style={[styles.numberInput, style]}
    />
  );
}

export function TargetEditor({
  target,
  onSave,
  onDelete,
  onSaved,
  onCancel,
}: {
  target: CategoryTarget | null;
  onSave: (draft: TargetDraft) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
  /** Called after a successful save — sheets close; inline editors reset. */
  onSaved?: () => void;
  /** Re-seed the draft from the stored target (inline editors, no sheet). */
  onCancel?: () => void;
}) {
  const { formatDate, parseDateInput } = useMoneyFormat();
  const [kind, setKind] = useState<TargetKind>(target?.kind ?? 'monthly');
  const [amount, setAmount] = useState<Cents>(target?.amountCents ?? 0);
  const [config, setConfig] = useState<CategoryTargetConfig>(target?.config ?? {});
  const [byDateText, setByDateText] = useState(
    target?.config.byDate ? formatDate(target.config.byDate) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed when the stored target changes (RTK refetch after a save, or the
  // sheet re-opened for another category).
  useEffect(() => {
    if (!target) return;
    setKind(target.kind);
    setAmount(target.amountCents);
    setConfig(target.config ?? {});
    setByDateText(target.config.byDate ? formatDate(target.config.byDate) : '');
  }, [target, formatDate]);

  const amountInvalid = amount <= 0;
  const byDateInvalid = kind === 'custom' && !(config.byDate && BY_DATE_RE.test(config.byDate));
  const canSave = !amountInvalid && !byDateInvalid && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ kind, amountCents: amount, snoozeMonth: target?.snoozeMonth ?? null, config });
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save target');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to delete target');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <View style={styles.kindRow}>
        {KINDS.map((k) => (
          <Pressable
            key={k.key}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === k.key }}
            onPress={() => setKind(k.key)}
            style={[styles.kindChip, kind === k.key && styles.kindChipActive]}>
            <Text style={[styles.kindChipText, kind === k.key && styles.kindChipTextActive]}>
              {k.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Field label="I need">
        <View style={styles.amountBox}>
          <MoneyInput cents={amount} onCommit={setAmount} />
        </View>
      </Field>

      {kind === 'weekly' ? (
        <Field label="Every">
          <ChipSelect options={WEEKDAYS} value={config.dayOfWeek ?? 1} onSelect={(i) => setConfig({ ...config, dayOfWeek: i })} />
        </Field>
      ) : null}

      {kind === 'monthly' ? (
        <Field label="Every">
          <NumberField
            value={config.repeatEvery ?? 1}
            onChange={(n) => setConfig({ ...config, repeatEvery: n })}
            accessibilityLabel="Repeat every months"
            style={{ width: 56 }}
          />
          <Text style={styles.fieldLabel}>months</Text>
        </Field>
      ) : null}

      {kind === 'yearly' ? (
        <>
          <Field label="Due month">
            <ChipSelect options={MONTHS} value={(config.monthOfYear ?? 12) - 1} onSelect={(i) => setConfig({ ...config, monthOfYear: i + 1 })} />
          </Field>
          <Field label="Due day">
            <NumberField
              value={config.dayOfMonth ?? 1}
              onChange={(n) => setConfig({ ...config, dayOfMonth: n })}
              accessibilityLabel="Due day of month"
              style={{ width: 56 }}
            />
          </Field>
        </>
      ) : null}

      {kind === 'custom' ? (
        <Field label="By date">
          <DatePickerPopover
            accessibilityLabel="Target due date"
            containerStyle={{ flex: 1, minWidth: 120 }}
            value={byDateText}
            onChangeText={(t) => {
              setByDateText(t);
              const iso = parseDateInput(t);
              setConfig({ ...config, byDate: iso ?? undefined });
            }}
            onEscape={() => {
              if (onCancel) onCancel();
              else {
                setConfig(target?.config ?? {});
                setByDateText(target?.config.byDate ? formatDate(target.config.byDate) : '');
              }
            }}
            onEnter={save}
          />
        </Field>
      ) : null}

      <View style={styles.footerRow}>
        {onDelete ? (
          <Pressable accessibilityRole="button" onPress={remove} style={styles.deleteBtn}>
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <GhostButton
          label="Cancel"
          onPress={() => {
            if (onCancel) onCancel();
            else if (target) {
              setKind(target.kind);
              setAmount(target.amountCents);
              setConfig(target.config ?? {});
              setByDateText(target.config.byDate ? formatDate(target.config.byDate) : '');
            }
          }}
        />
        <IndigoButton
          label={busy ? 'Saving…' : 'Save Target'}
          onPress={save}
          style={amountInvalid || byDateInvalid ? styles.saveDisabled : undefined}
        />
      </View>

      {amountInvalid || byDateInvalid ? (
        <Text style={styles.hint}>
          {amountInvalid ? 'Enter an amount.' : 'Type a date (DD/MM/YYYY or 5, 5/9) or pick one from the calendar.'}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Read view for a saved target (syscd-app-hsjm, ref: CleanShot #7): progress
 * ring with the funded fraction, the "Set Aside …" headline per kind, the
 * on-track guidance line, and the snooze / edit actions. Parents own the
 * mutations — `onToggleSnooze(true)` snoozes `month`, false clears it.
 */
export function TargetSummary({
  target,
  month,
  assigned,
  available,
  onEdit,
  onToggleSnooze,
  busy,
}: {
  target: CategoryTarget;
  month: MonthKey;
  assigned: Cents;
  available: Cents;
  onEdit: () => void;
  onToggleSnooze: (snooze: boolean) => void;
  busy?: boolean;
}) {
  const { formatMoney } = useMoneyFormat();
  const snoozed = target.snoozeMonth === month;
  const need = neededBy(target, month);
  const state: FundingState = available < 0 ? 'red' : need > 0 && assigned >= need ? 'green' : need > 0 ? 'yellow' : 'gray';
  const fraction = need > 0 ? Math.max(0, Math.min(1, assigned / need)) : assigned > 0 ? 1 : 0;

  const headline = (() => {
    if (snoozed) return 'Target snoozed for this month';
    const amt = formatMoney(target.amountCents);
    switch (target.kind) {
      case 'weekly':
        return `Set Aside ${amt} Every Week`;
      case 'monthly':
        return `Set Aside ${amt} Each Month`;
      case 'yearly': {
        const m = target.config.monthOfYear ?? 12;
        return `Save ${amt} by ${MONTHS[m - 1]} ${Math.floor(month / 100)}`;
      }
      case 'custom':
        return target.config.byDate
          ? `Save ${amt} by ${target.config.byDate.split('-').reverse().join('/')}`
          : `Save ${amt} by your target date`;
    }
  })();

  const guidance = (() => {
    if (snoozed) return 'This month is skipped — later months resume the target.';
    if (need <= 0) return assigned > 0 ? `${formatMoney(assigned)} assigned toward this target.` : 'Nothing needed this month.';
    if (available < 0) return `Cover the ${formatMoney(-available)} overspending to stay on target.`;
    if (assigned >= need) return `Target met for ${MONTHS[(month % 100) - 1]} — ${formatMoney(assigned)} assigned.`;
    return `Assign ${formatMoney(need - assigned)} more to meet your target (${formatMoney(assigned)} of ${formatMoney(need)}).`;
  })();

  return (
    <View>
      <View style={styles.summaryHead}>
        <Ring state={state} fraction={fraction} />
        <View style={styles.summaryCopy}>
          <Text style={styles.summaryHeadline}>{headline}</Text>
          <Text style={styles.summarySub}>
            {snoozed ? 'Snoozed' : 'By the End of the Month'}
          </Text>
        </View>
      </View>
      <Text style={styles.summaryGuidance}>{guidance}</Text>
      <View style={styles.summaryActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={snoozed ? 'Unsnooze target' : 'Snooze target for this month'}
          disabled={busy}
          onPress={() => onToggleSnooze(!snoozed)}
          style={styles.summaryBtn}>
          <Text style={styles.summaryBtnText}>{busy ? 'Saving…' : snoozed ? 'Unsnooze' : 'Snooze target for this month'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Edit target" onPress={onEdit} style={styles.summaryBtn}>
          <Text style={styles.summaryBtnText}>Edit Target</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Donut ring for the summary: filled fraction of the month's target. */
function Ring({ state, fraction }: { state: FundingState; fraction: number }) {
  const stroke = 5;
  const size = 40;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.bg2} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={barColor(state)}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={`${c * Math.max(0.01, fraction)} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <SvgText x={size / 2} y={size / 2 + 3.5} textAnchor="middle" fontSize={9.5} fontWeight="700" fill={colors.text}>
        {pct}%
      </SvgText>
    </Svg>
  );
}

const styles = StyleSheet.create({
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  summaryCopy: {
    flex: 1,
    gap: 2,
  },
  summaryHeadline: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  summarySub: {
    color: colors.muted,
    fontSize: 12,
  },
  summaryGuidance: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  summaryActions: {
    flexDirection: 'row',
    gap: 10,
  },
  summaryBtn: {
    paddingVertical: 6,
  },
  summaryBtnText: {
    color: colors.indigo2,
    fontSize: 13,
    fontWeight: '600',
  },
  kindRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
  },
  kindChip: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  kindChipActive: {
    backgroundColor: colors.indigoSoft,
    borderColor: colors.indigo2,
  },
  kindChipText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  kindChipTextActive: {
    color: colors.indigo2,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 13,
    width: 84,
  },
  amountBox: {
    flex: 1,
    minWidth: 120,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    flex: 1,
  },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.indigoSoft,
    borderColor: colors.indigo2,
  },
  chipText: {
    color: colors.muted,
    fontSize: 12,
  },
  chipTextActive: {
    color: colors.indigo2,
    fontWeight: '600',
  },
  numberInput: {
    color: colors.text,
    fontSize: 14,
    backgroundColor: colors.bg2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  deleteBtn: {
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  deleteText: {
    color: colors.redFg,
    fontSize: 14,
    fontWeight: '600',
  },
  saveDisabled: {
    opacity: 0.5,
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 6,
  },
  errorText: {
    color: colors.redFg,
    fontSize: 12,
    marginTop: 6,
  },
});
