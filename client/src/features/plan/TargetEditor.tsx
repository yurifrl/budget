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
import { monthAbbr, weekdayAbbr } from '@/domain/format';
import type { CategoryTarget, CategoryTargetConfig, Cents, FundingState, MonthKey, TargetKind } from '@/domain/types';
import { neededBy } from '@/domain/targets';
import { labels } from '@shared/i18n';
import { tCommon } from '@shared/i18n/common';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { t } from './inspector/i18n';

export interface TargetDraft {
  kind: TargetKind;
  amountCents: Cents;
  /** Preserved from the stored target across edits (syscd-app-hsjm). */
  snoozeMonth?: MonthKey | null;
  config: CategoryTargetConfig;
}

const KIND_KEYS: readonly TargetKind[] = ['weekly', 'monthly', 'yearly', 'custom'];

const KIND_LABELS: Record<TargetKind, string> = labels(t, {
  weekly: 'editor.kindWeekly',
  monthly: 'editor.kindMonthly',
  yearly: 'editor.kindYearly',
  custom: 'editor.kindCustom',
});

/** Weekday / month chip labels in the active language (Sunday first, January first). */
const weekdayLabels = (): string[] => Array.from({ length: 7 }, (_, i) => weekdayAbbr(i));
const monthLabels = (): string[] => Array.from({ length: 12 }, (_, i) => monthAbbr(i + 1));

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
      onChangeText={(text) => {
        const n = parseInt(text.replace(/\D/g, ''), 10);
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
      setError(e instanceof Error ? e.message : apiErrorMessage(e, t('editor.saveFailed')));
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
      setError(e instanceof Error ? e.message : apiErrorMessage(e, t('editor.deleteFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <View style={styles.kindRow}>
        {KIND_KEYS.map((k) => (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === k }}
            onPress={() => setKind(k)}
            style={[styles.kindChip, kind === k && styles.kindChipActive]}>
            <Text style={[styles.kindChipText, kind === k && styles.kindChipTextActive]}>
              {KIND_LABELS[k]}
            </Text>
          </Pressable>
        ))}
      </View>

      <Field label={t('editor.need')}>
        <View style={styles.amountBox}>
          <MoneyInput cents={amount} onCommit={setAmount} />
        </View>
      </Field>

      {kind === 'weekly' ? (
        <Field label={t('editor.every')}>
          <ChipSelect options={weekdayLabels()} value={config.dayOfWeek ?? 1} onSelect={(i) => setConfig({ ...config, dayOfWeek: i })} />
        </Field>
      ) : null}

      {kind === 'monthly' ? (
        <Field label={t('editor.every')}>
          <NumberField
            value={config.repeatEvery ?? 1}
            onChange={(n) => setConfig({ ...config, repeatEvery: n })}
            accessibilityLabel={t('editor.repeatEveryLabel')}
            style={{ width: 56 }}
          />
          <Text style={styles.fieldLabel}>{t('editor.monthsUnit', { count: config.repeatEvery ?? 1 })}</Text>
        </Field>
      ) : null}

      {kind === 'yearly' ? (
        <>
          <Field label={t('editor.dueMonth')}>
            <ChipSelect options={monthLabels()} value={(config.monthOfYear ?? 12) - 1} onSelect={(i) => setConfig({ ...config, monthOfYear: i + 1 })} />
          </Field>
          <Field label={t('editor.dueDay')}>
            <NumberField
              value={config.dayOfMonth ?? 1}
              onChange={(n) => setConfig({ ...config, dayOfMonth: n })}
              accessibilityLabel={t('editor.dueDayLabel')}
              style={{ width: 56 }}
            />
          </Field>
        </>
      ) : null}

      {kind === 'custom' ? (
        <Field label={t('editor.byDate')}>
          <DatePickerPopover
            accessibilityLabel={t('editor.dueDateLabel')}
            containerStyle={{ flex: 1, minWidth: 120 }}
            value={byDateText}
            onChangeText={(text) => {
              setByDateText(text);
              const iso = parseDateInput(text);
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
            <Text style={styles.deleteText}>{tCommon('delete')}</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <GhostButton
          label={tCommon('cancel')}
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
          label={busy ? t('editor.saving') : t('editor.save')}
          onPress={save}
          style={amountInvalid || byDateInvalid ? styles.saveDisabled : undefined}
        />
      </View>

      {amountInvalid || byDateInvalid ? (
        <Text style={styles.hint}>
          {amountInvalid ? t('editor.amountHint') : t('editor.dateHint')}
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
    if (snoozed) return t('summary.snoozedHeadline');
    const amount = formatMoney(target.amountCents);
    switch (target.kind) {
      case 'weekly':
        return t('summary.weekly', { amount });
      case 'monthly':
        return t('summary.monthly', { amount });
      case 'yearly': {
        const m = target.config.monthOfYear ?? 12;
        return t('summary.yearly', { amount, month: monthAbbr(m), year: Math.floor(month / 100) });
      }
      case 'custom':
        return target.config.byDate
          ? t('summary.customDate', { amount, date: target.config.byDate.split('-').reverse().join('/') })
          : t('summary.customNoDate', { amount });
    }
  })();

  const guidance = (() => {
    if (snoozed) return t('summary.skipped');
    if (need <= 0) {
      return assigned > 0
        ? t('summary.assignedToward', { amount: formatMoney(assigned) })
        : t('summary.nothingNeeded');
    }
    if (available < 0) return t('summary.cover', { amount: formatMoney(-available) });
    if (assigned >= need) {
      return t('summary.met', { month: monthAbbr(month % 100), amount: formatMoney(assigned) });
    }
    return t('summary.assignMore', {
      remaining: formatMoney(need - assigned),
      assigned: formatMoney(assigned),
      need: formatMoney(need),
    });
  })();

  return (
    <View>
      <View style={styles.summaryHead}>
        <Ring state={state} fraction={fraction} />
        <View style={styles.summaryCopy}>
          <Text style={styles.summaryHeadline}>{headline}</Text>
          <Text style={styles.summarySub}>
            {snoozed ? t('summary.snoozed') : t('summary.endOfMonth')}
          </Text>
        </View>
      </View>
      <Text style={styles.summaryGuidance}>{guidance}</Text>
      <View style={styles.summaryActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={snoozed ? t('summary.unsnoozeLabel') : t('summary.snoozeButton')}
          disabled={busy}
          onPress={() => onToggleSnooze(!snoozed)}
          style={styles.summaryBtn}>
          <Text style={styles.summaryBtnText}>{busy ? t('editor.saving') : snoozed ? t('summary.unsnooze') : t('summary.snoozeButton')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('summary.editLabel')} onPress={onEdit} style={styles.summaryBtn}>
          <Text style={styles.summaryBtnText}>{t('summary.edit')}</Text>
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
