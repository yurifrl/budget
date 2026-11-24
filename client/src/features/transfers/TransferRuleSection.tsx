/**
 * Payee screen: "Treat as transfer" (mock ③). The toggle turns the payee's
 * rule on (rows of this payee are transfers, no category), the other account
 * is picked automatically or fixed, and a no-match policy says what happens
 * when the other side never shows up. "Never a transfer" suppresses
 * suggestions. Save keeps past rows as they are; "Apply to N past rows" also
 * links them. Plus the "Transfer rules" list (Payees › Rules).
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useGetPayeeTransferRuleQuery, useSetPayeeTransferRuleMutation, type TransferRuleInput } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import type { Account } from '@/domain/types';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import { accountsHint, transferRules, transferTargets } from './transfers.logic';

const WAIT_CHOICES = [3, 5, 7, 14] as const;

interface Draft {
  on: boolean;
  never: boolean;
  /** 'auto' or a fixed account id. */
  target: string;
  noMatch: 'outside' | 'review';
  waitDays: number;
}

function Radio({ on, title, sub, onPress }: { on: boolean; title: string; sub?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.radioRow} accessibilityRole="radio" accessibilityState={{ selected: on }}>
      <Text style={[styles.radioDot, on && styles.radioDotOn]}>{on ? '●' : '○'}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.text}>{title}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

function Toggle({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label} hitSlop={6}>
      <View style={[styles.toggle, !on && styles.toggleOff]}>
        <View style={[styles.knob, on ? styles.knobOn : styles.knobOff]} />
      </View>
    </Pressable>
  );
}

export function TransferRuleSection({
  budgetId,
  payee,
  accounts,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  accounts: readonly Account[];
}) {
  const rule = useGetPayeeTransferRuleQuery({ budgetId, payeeId: payee.id }, { skip: !budgetId });
  const [save, saving] = useSetPayeeTransferRuleMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const targets = transferTargets(accounts);

  // A new payee (or a reloaded rule) resets the draft.
  useEffect(() => {
    setDraft(null);
    setStatus(null);
  }, [payee.id]);

  const data = rule.data;
  const current: Draft = draft ?? {
    on: data?.mode === 'auto' || data?.mode === 'account',
    never: data?.mode === 'never',
    target: data?.mode === 'account' && data.account_id ? data.account_id : 'auto',
    noMatch: data?.no_match ?? 'outside',
    waitDays: data?.wait_days ?? 5,
  };
  const edit = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });

  const submit = async (applyToPast: boolean) => {
    const input: TransferRuleInput = {
      mode: current.never ? 'never' : current.on ? (current.target === 'auto' ? 'auto' : 'account') : 'off',
      account_id: current.on && current.target !== 'auto' ? current.target : null,
      no_match: current.noMatch,
      wait_days: current.waitDays,
      apply_to_past: applyToPast,
    };
    try {
      const saved = await save({ budgetId, payeeId: payee.id, rule: input }).unwrap();
      setDraft(null);
      setStatus(t('rule.saved', { count: saved.linked }));
    } catch (err) {
      setStatus(apiErrorMessage(err, t('error.rule')));
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.payee} numberOfLines={2}>
          {payee.name}
        </Text>
        <Text style={styles.sub}>{t('rule.payeeCount', { count: payee.transaction_count })}</Text>
      </View>
      <Text style={styles.label}>{t('rule.section')}</Text>
      <View style={styles.row}>
        <Toggle on={current.on} label={t('rule.toggle')} onPress={() => edit({ on: !current.on, never: false })} />
        <Text style={[styles.text, { flex: 1 }]}>{current.on ? t('rule.on') : t('rule.off')}</Text>
      </View>
      {current.on ? (
        <>
          <Text style={styles.label}>{t('rule.otherAccount')}</Text>
          <Radio on={current.target === 'auto'} title={t('rule.auto', { accounts: accountsHint(targets) })} onPress={() => edit({ target: 'auto' })} />
          {targets.map((a) => (
            <Radio key={a.id} on={current.target === a.id} title={a.name} onPress={() => edit({ target: a.id })} />
          ))}
          {targets[0] ? <Text style={styles.sub}>{t('rule.fixedHint', { account: targets[0].name })}</Text> : null}
          <Text style={styles.label}>{t('rule.noMatchLabel', { count: current.waitDays })}</Text>
          <View style={styles.chips}>
            {WAIT_CHOICES.map((d) => (
              <Pressable
                key={d}
                onPress={() => edit({ waitDays: d })}
                style={[styles.chip, current.waitDays === d && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: current.waitDays === d }}>
                <Text style={[styles.sub, current.waitDays === d && styles.chipOnText]}>{t('rule.waitDays', { count: d })}</Text>
              </Pressable>
            ))}
          </View>
          <Radio on={current.noMatch === 'outside'} title={t('rule.noMatchOutside')} onPress={() => edit({ noMatch: 'outside' })} />
          <Radio on={current.noMatch === 'review'} title={t('rule.noMatchReview')} onPress={() => edit({ noMatch: 'review' })} />
        </>
      ) : null}
      <View style={[styles.row, { marginTop: 10 }]}>
        <Toggle on={current.never} label={t('rule.never')} onPress={() => edit({ never: !current.never, on: false })} />
        <View style={{ flex: 1 }}>
          <Text style={styles.text}>{t('rule.never')}</Text>
          <Text style={styles.sub}>{t('rule.neverSub')}</Text>
        </View>
      </View>
      <View style={[styles.row, { marginTop: 14 }]}>
        {current.on && (data?.past_rows ?? 0) > 0 ? (
          <Pressable style={styles.btn} accessibilityRole="button" disabled={saving.isLoading} onPress={() => void submit(true)}>
            <Text style={styles.btnText}>{t('rule.applyPast', { count: data?.past_rows ?? 0 })}</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          style={[styles.btn, styles.primary, !draft && styles.disabled]}
          disabled={!draft || saving.isLoading}
          accessibilityRole="button"
          onPress={() => void submit(false)}>
          <Text style={styles.primaryText}>{tCommon('save')}</Text>
        </Pressable>
      </View>
      {status ? <Text style={[styles.sub, { marginTop: 6 }]}>{status}</Text> : null}
    </View>
  );
}

/** "Transfer rules" (Payees › Rules): every payee with a rule; a row opens the payee. */
export function TransferRulesList({
  payees,
  accounts,
  onOpen,
}: {
  payees: readonly PayeeAdminRow[];
  accounts: readonly Pick<Account, 'id' | 'name'>[];
  onOpen: (payeeId: string) => void;
}) {
  const rows = transferRules(payees, accounts);
  return (
    <View style={styles.card}>
      <Text style={styles.text}>
        <Text style={{ fontWeight: '700' }}>{t('rules.title')}</Text> <Text style={styles.sub}>{t('rules.crumb')}</Text>
      </Text>
      {rows.length === 0 ? <Text style={[styles.sub, { marginTop: 10 }]}>{t('rules.empty')}</Text> : null}
      {rows.map((r, i) => (
        <Pressable
          key={r.payeeId}
          onPress={() => onOpen(r.payeeId)}
          accessibilityRole="button"
          accessibilityLabel={t('rules.open', { payee: r.name })}
          style={[styles.ruleRow, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={[styles.ruleIcon, r.never && styles.ruleIconNever]}>{r.never ? '✕' : '⇄'}</Text>
          <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
            {r.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {r.target}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.r,
    padding: 14,
    marginTop: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' },
  payee: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  label: { color: colors.muted, fontSize: 11, letterSpacing: 0.6, marginTop: 12, marginBottom: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { color: colors.text, fontSize: 13 },
  sub: { color: colors.muted, fontSize: 12 },
  radioRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 4 },
  radioDot: { color: colors.faint, fontSize: 13, width: 14 },
  radioDotOn: { color: colors.indigo2 },
  toggle: { width: 34, height: 20, borderRadius: 10, backgroundColor: colors.indigo, justifyContent: 'center' },
  toggleOff: { backgroundColor: colors.grayPillBg },
  knob: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.white, position: 'absolute' },
  knobOn: { right: 3 },
  knobOff: { left: 3 },
  chips: { flexDirection: 'row', gap: 6, marginBottom: 4, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 10 },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.bluePillBg },
  chipOnText: { color: colors.blue },
  btn: { borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingVertical: 5, paddingHorizontal: 9 },
  btnText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  primary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  primaryText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  ruleIcon: {
    color: colors.blue,
    backgroundColor: colors.bluePillBg,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 11,
    overflow: 'hidden',
  },
  ruleIconNever: { color: colors.redFg, backgroundColor: colors.redPillBg },
});
