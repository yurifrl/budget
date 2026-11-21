/**
 * Reflect — reports (tasks 7.1–7.3): Net Worth, Spending Breakdown and
 * Spending Trends, computed from the active budget's data and charted with
 * react-native-svg (renders on web and iOS). Includes the report switcher,
 * a date-range filter and account/category filters. The budget-wide person
 * filter scopes every figure to that person's ACCOUNTS (`budgetForPerson`):
 * net worth = their accounts' balances, spending = transactions on them.
 * Reflect has no category-assigned figures, so category ownership does not
 * apply; category chips stay whole (a person's accounts can spend in any).
 */

import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import { filterChips, selectionCategoryIds, spendRows, type CategorySelection } from '@/domain/bundleSpend';
import { transactionActivity, workingBalance } from '@/domain/engine';
import { formatMonth, monthOfDate } from '@/domain/format';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { budgetForPerson } from '@/domain/people';
import type { Budget, Cents, MonthKey } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { useBudgetModel } from '@/state/useBudgetModel';
import { usePersonFilter , PersonFilterBar } from '@/features/people';
import { useBudgetShell } from '@/shell/context';

import { t } from './i18n';

type Report = 'breakdown' | 'trends' | 'networth';
type Range = 3 | 6 | 0; // months back; 0 = all

const REPORTS: { key: Report; label: string }[] = [
  { key: 'breakdown', get label() { return t('report.breakdown'); } },
  { key: 'trends', get label() { return t('report.trends'); } },
  { key: 'networth', get label() { return t('report.networth'); } },
];

/** Month-end net worth per month, walking back from current balances. */
function netWorthSeries(budget: Budget, months: MonthKey[]): { month: MonthKey; assets: Cents; debts: Cents }[] {
  return months.map((m) => {
    let assets = 0;
    let debts = 0;
    for (const account of budget.accounts) {
      const futureDelta = budget.transactions
        .filter((t) => t.accountId === account.id && monthOfDate(t.date) > m)
        .reduce((sum, t) => sum + transactionActivity(t), 0);
      const balance = workingBalance(account) - futureDelta;
      if (balance >= 0) assets += balance;
      else debts += -balance;
    }
    return { month: m, assets, debts };
  });
}

function BarChart({ data, color, height = 180 }: { data: { label: string; value: number; accent?: boolean }[]; color: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const barW = 100 / Math.max(1, data.length);
  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const h = (Math.abs(d.value) / max) * (height - 8);
          return (
            <Rect
              key={i}
              x={i * barW + barW * 0.27}
              y={height - h}
              width={barW * 0.46}
              height={h}
              rx={2}
              fill={d.accent ? colors.indigo2 : color}
            />
          );
        })}
      </Svg>
      <View style={styles.chartLabels}>
        {data.map((d, i) => (
          <Text key={i} style={styles.chartLabel} numberOfLines={1}>
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

export function ReflectScreen() {
  const { formatMoney } = useMoneyFormat();
  const shell = useBudgetShell();
  const { budget: fullBudget, budgetId, error } = useBudgetModel();
  const byPerson = usePersonFilter(fullBudget, budgetId);
  const budget = useMemo(
    () => (fullBudget ? budgetForPerson(fullBudget, byPerson.person) : undefined),
    [fullBudget, byPerson.person],
  );
  const [report, setReport] = useState<Report>('networth');
  const [range, setRange] = useState<Range>(6);
  const [pickedAccount, setAccountFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategorySelection | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // An account chip hidden by the person filter no longer applies.
  const accountFilter = budget?.accounts.some((a) => a.id === pickedAccount) ? pickedAccount : null;

  const months = useMemo(() => {
    if (!budget) return [];
    const all = budget.months;
    return range === 0 ? all : all.slice(-range);
  }, [budget, range]);

  const txns = useMemo(() => {
    if (!budget) return [];
    const catIds = categoryFilter ? selectionCategoryIds(categoryFilter, budget.categories) : null;
    return budget.transactions.filter(
      (t) =>
        (accountFilter ? t.accountId === accountFilter : true) &&
        (catIds ? t.categoryId != null && catIds.has(t.categoryId) : true) &&
        (months.length ? months.includes(monthOfDate(t.date)) : true),
    );
  }, [budget, accountFilter, categoryFilter, months]);

  if (!budget) {
    return (
      <View style={styles.center}>
        {error ? <Text style={{ color: colors.redFg }}>{error}</Text> : <ActivityIndicator color={colors.indigo2} />}
      </View>
    );
  }

  const nw = netWorthSeries(budget, months);
  const latest = nw[nw.length - 1];
  const first = nw[0];
  const latestNet = latest ? latest.assets - latest.debts : 0;
  const firstNet = first ? first.assets - first.debts : 0;
  const changePct = firstNet !== 0 ? ((latestNet - firstNet) / Math.abs(firstNet)) * 100 : 0;

  const spendByCategory = spendRows(budget.categories, budget.bundles, (c) =>
    txns.filter((t) => t.categoryId === c.id).reduce((sum, t) => sum + t.outflow - t.inflow, 0),
  );
  const spendMax = Math.max(1, ...spendByCategory.map((x) => x.total));

  const trendData = months.map((m) => ({
    label: formatMonth(m).split(' ')[0],
    value: txns
      .filter((t) => monthOfDate(t.date) === m && t.outflow > 0)
      .reduce((sum, t) => sum + t.outflow, 0),
    accent: m === budget.currentMonth,
  }));

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <Text style={styles.title}>{t('screen.title')}</Text>
      <PersonFilterBar
        byPerson={byPerson}
        budgetId={budgetId}
        caption={byPerson.accountsLabel ? t('caption.accounts', { accounts: byPerson.accountsLabel }) : null}
      />
      {/* report switcher */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rtabs} contentContainerStyle={{ gap: 18, paddingHorizontal: 20 }}>
        {REPORTS.map((r) => (
          <Pressable key={r.key} onPress={() => setReport(r.key)}>
            <Text style={[styles.rtab, report === r.key && styles.rtabActive]}>{r.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {/* filters: range + account + category */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}>
        {([3, 6, 0] as Range[]).map((r) => (
          <Pressable key={r} onPress={() => setRange(r)} style={[styles.chip, range === r && styles.chipActive]}>
            <Text style={[styles.chipText, range === r && { color: colors.white }]}>
              {r === 0 ? t('range.all') : t('range.last', { count: r })}
            </Text>
          </Pressable>
        ))}
        {budget.accounts.map((a) => (
          <Pressable
            key={a.id}
            onPress={() => setAccountFilter(accountFilter === a.id ? null : a.id)}
            style={[styles.chip, accountFilter === a.id && styles.chipActive]}>
            <Text style={[styles.chipText, accountFilter === a.id && { color: colors.white }]}>{a.name}</Text>
          </Pressable>
        ))}
        {report !== 'networth'
          ? filterChips(budget.categories, budget.bundles).map(({ sel, label }) => {
              const active = categoryFilter?.kind === sel.kind && categoryFilter.id === sel.id;
              return (
                <Pressable
                  key={`${sel.kind}:${sel.id}`}
                  onPress={() => setCategoryFilter(active ? null : sel)}
                  style={[styles.chip, active && styles.chipActive]}>
                  <Text style={[styles.chipText, active && { color: colors.white }]}>{label}</Text>
                </Pressable>
              );
            })
          : null}
      </ScrollView>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 90 }}>
        {report === 'networth' ? (
          <>
            <Text style={styles.kicker}>{t('report.networth')}</Text>
            <Text style={styles.big}>{formatMoney(latestNet)}</Text>
            <View style={styles.legendRow}>
              <Text style={{ color: colors.indigo2, fontSize: 13 }}>
                {t('networth.assets', { amount: formatMoney(latest?.assets ?? 0) })}
              </Text>
              <Text style={{ color: colors.redFg, fontSize: 13 }}>
                {t('networth.debts', { amount: formatMoney(latest?.debts ?? 0) })}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                {t('networth.change', { percent: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%` })}
              </Text>
            </View>
            <BarChart
              data={nw.map((p) => ({
                label: formatMonth(p.month).split(' ')[0],
                value: p.assets - p.debts,
                accent: p.month === budget.currentMonth,
              }))}
              color={colors.indigo}
            />
          </>
        ) : null}

        {report === 'trends' ? (
          <>
            <Text style={styles.kicker}>{t('trends.total')}</Text>
            <Text style={styles.big}>{formatMoney(trendData.reduce((s, d) => s + d.value, 0))}</Text>
            <BarChart data={trendData} color={colors.indigo} />
          </>
        ) : null}

        {report === 'breakdown' ? (
          <>
            <Text style={styles.kicker}>{t('report.breakdown')}</Text>
            <Text style={styles.big}>
              {formatMoney(spendByCategory.reduce((s, x) => s + x.total, 0))}
            </Text>
            <View style={{ marginTop: 16, gap: 12 }}>
              {spendByCategory.map((row) => {
                const key = row.kind === 'bundle' ? `b:${row.bundle.id}` : row.category.id;
                const open = row.kind === 'bundle' && expanded.has(row.bundle.id);
                const bar = (total: number) => (
                  <View style={styles.breakdownTrack}>
                    <View style={[styles.breakdownFill, { width: `${(total / spendMax) * 100}%` }]} />
                  </View>
                );
                return (
                  <View key={key}>
                    <Pressable
                      disabled={row.kind !== 'bundle'}
                      accessibilityLabel={row.kind === 'bundle' ? t('breakdown.bundleLabel', { name: row.bundle.name }) : undefined}
                      onPress={() => {
                        if (row.kind !== 'bundle') return;
                        const next = new Set(expanded);
                        if (!next.delete(row.bundle.id)) next.add(row.bundle.id);
                        setExpanded(next);
                      }}
                      style={styles.breakdownRow}>
                      <Text style={styles.breakdownName}>
                        {row.kind === 'bundle' ? `${open ? '▾' : '▸'} ${row.bundle.name}` : row.category.name}
                      </Text>
                      <Text style={styles.breakdownAmt}>{formatMoney(row.total)}</Text>
                    </Pressable>
                    {bar(row.total)}
                    {open && row.kind === 'bundle'
                      ? row.children.map(({ category, total }) => (
                          <View key={category.id} style={{ marginTop: 8, marginLeft: 18 }}>
                            <View style={styles.breakdownRow}>
                              <Text style={styles.breakdownName}>{category.name}</Text>
                              <Text style={styles.breakdownAmt}>{formatMoney(total)}</Text>
                            </View>
                            {bar(total)}
                          </View>
                        ))
                      : null}
                  </View>
                );
              })}
              {spendByCategory.length === 0 ? (
                <Text style={{ color: colors.faint }}>{t('breakdown.empty')}</Text>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', paddingHorizontal: 20, paddingVertical: 10 },
  rtabs: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  rtab: { color: colors.muted, fontSize: 14, fontWeight: '600', paddingVertical: 12 },
  rtabActive: { color: colors.text, borderBottomWidth: 2, borderBottomColor: colors.indigo },
  filters: { flexGrow: 0, paddingVertical: 10 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  kicker: { color: colors.muted, fontSize: 13 },
  big: { color: colors.text, fontSize: 30, fontWeight: '800', marginVertical: 4 },
  legendRow: { flexDirection: 'row', gap: 24, marginBottom: 16, flexWrap: 'wrap' },
  chartLabels: { flexDirection: 'row' },
  chartLabel: { flex: 1, textAlign: 'center', color: colors.faint, fontSize: 11, marginTop: 6 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  breakdownName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  breakdownAmt: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  breakdownTrack: { height: 8, borderRadius: 4, backgroundColor: colors.grayPillBg, overflow: 'hidden' },
  breakdownFill: { height: 8, borderRadius: 4, backgroundColor: colors.indigo },
});
