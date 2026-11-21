import { useGlobalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useGetAccountsQuery } from '@/budget/data/api';
import type { AccountRow } from '@/budget/data/rows';
import { AccountEditModal, AddAccountModal } from '@/features/accounts';
import { usePeople } from '@/features/people';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppSelector } from '@/state/hooks';
import { selectShowClosedAccounts } from '@/state/ui';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { AccountOwnerFace } from '@/ui/PersonFace';
import { colors } from '@/ui/theme';

import { t } from '../i18n';
import { railAccountBalance, railSections, railSectionTotal } from './rail.logic';

/** Per-account-group chevron collapse (CASH/CREDIT/...), shared with the osb spec. */
const GROUP_COLLAPSED_KEY = 'budget.sidebar.collapsedAccountGroups';

/**
 * The rail's secondary section: accounts grouped under small section labels
 * (each collapsible, with its total), clickable into the register, and a
 * "+ Add Account" button under the last group.
 */
export function RailAccounts({ budgetId, onNavigate }: { budgetId: string | null; onNavigate: () => void }) {
  const { formatMoney } = useMoneyFormat();
  const router = useRouter();
  // Account selection lives in the URL (?account=) so the register on
  // /accounts can react to rail picks from any tab.
  // Global, not local: the rail mounts in the Tabs layout (parent route) and
  // expo-router's useLocalSearchParams there doesn't see child-screen query
  // params (?account=<id> on /accounts) — useGlobalSearchParams does.
  const { account: accountParam } = useGlobalSearchParams<{ account?: string }>();
  const storage = useService(Tokens.Storage);
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void storage.get<Record<string, boolean>>(GROUP_COLLAPSED_KEY, {}).then(setGroupCollapsed);
  }, [storage]);
  const toggleGroup = (group: string) => {
    setGroupCollapsed((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      void storage.set(GROUP_COLLAPSED_KEY, next);
      return next;
    });
  };

  const accounts = useGetAccountsQuery(budgetId ? { budgetId } : { budgetId: '' }, { skip: !budgetId });
  const { personOf } = usePeople(budgetId);
  const showClosedAccounts = useAppSelector((s) => selectShowClosedAccounts(s));
  const groups = useMemo(() => railSections(accounts.data ?? [], showClosedAccounts), [accounts.data, showClosedAccounts]);

  const selectAccount = (id: string) => {
    router.navigate({ pathname: '/accounts', params: { account: id } } as never);
    onNavigate();
  };

  // YNAB parity: right-click (web) / long-press (native) an account row → Edit
  // Account; a + Add Account button sits under the last group.
  const [editAccount, setEditAccount] = useState<AccountRow | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  return (
    <ScrollView style={styles.accts}>
      {groups.map(({ key, label, accs }) => {
        const open = !groupCollapsed[key];
        const groupTotal = railSectionTotal(accs);
        return (
          <View key={key}>
            <Pressable style={styles.groupRow} onPress={() => toggleGroup(key)}>
              <Text style={styles.groupText}>{open ? '▾' : '▸'}</Text>
              <Text style={[styles.groupText, { flex: 1 }]}>{label}</Text>
              <Text style={[styles.groupText, groupTotal < 0 && styles.balanceNeg]}>{formatMoney(groupTotal)}</Text>
            </Pressable>
            {open
              ? accs.map((a) => {
                  const bal = railAccountBalance(a);
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => selectAccount(a.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setEditAccount(a);
                      }}
                      onLongPress={() => setEditAccount(a)}
                      accessibilityLabel={t('rail.openAccount', { name: a.name })}
                      style={[styles.row, accountParam === a.id && styles.rowSelected]}>
                      <View style={styles.nameCol}>
                        <Text style={styles.name} numberOfLines={1}>
                          {a.name}
                        </Text>
                      </View>
                      <AccountOwnerFace person={personOf(a.user_id)} />
                      <Text style={[styles.balance, bal < 0 && styles.balanceNeg]}>{formatMoney(bal)}</Text>
                    </Pressable>
                  );
                })
              : null}
          </View>
        );
      })}
      <Pressable style={styles.addBtn} onPress={() => setAddAccountOpen(true)} accessibilityLabel={t('rail.addAccount')}>
        <Text style={styles.addText}>{t('rail.addAccountButton')}</Text>
      </Pressable>
      {editAccount && budgetId ? (
        <AccountEditModal account={editAccount} budgetId={budgetId} onClose={() => setEditAccount(null)} />
      ) : null}
      {addAccountOpen && budgetId ? (
        <AddAccountModal budgetId={budgetId} visible onClose={() => setAddAccountOpen(false)} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  accts: { marginTop: 12, flex: 1 },
  groupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  groupText: {
    color: colors.faint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 6,
    gap: 8,
  },
  rowSelected: { backgroundColor: colors.indigo2 + '2e' },
  name: { color: colors.text, fontSize: 13, flex: 1 },
  nameCol: { flex: 1, gap: 1 },
  balance: { color: colors.greenPillFg, fontSize: 13, fontVariant: ['tabular-nums'] },
  balanceNeg: { color: colors.redFg },
  addBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  addText: { color: colors.indigo3, fontSize: 13, fontWeight: '600' },
});
