/**
 * Manage Payees — YNAB parity (issue syscd-app-0px). One shared body: the
 * settings pane routes to /payees (page wrapper below); every other
 * entry point (register dropdown, Home, Import) opens it as a modal sheet
 * (ManagePayeesModal) — `onClose` supplies the ✕ header button, so the page
 * variant carries none.
 *
 * Two-pane layout: searchable payee list (with live usage counts and an
 * inline add row) on the left, detail pane on the right — rename, a
 * paginated transactions table, categorization radio (auto / fixed / never)
 * with a default-category picker, renaming rules editor (Contains X →
 * rename to Y), hide, merge, and delete (routes to a merge prompt when the
 * payee still has transactions).
 *
 * Data comes straight from the payee endpoints added by syscd-app-7pa;
 * mutations live in data/api.ts.
 */

import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { colors } from '@/ui/theme';
import { t } from './i18n';
import { PayeeDetailPane } from './PayeeDetailPane';
import { PayeeListPane } from './PayeeListPane';
import { styles } from './styles';
import { usePayeeAdmin } from './usePayeeAdmin';
import { useBudgetShell } from '@/shell/context';
import { TransferRulesList } from '@/features/transfers';

export function ManagePayeesBody({
  /** Native top inset — page only; the modal sheet floats with its own padding. */
  contentTopPad = 0,
  /** Modal variant supplies it (✕ in the header); the routed page omits it. */
  onClose,
}: {
  contentTopPad?: number;
  onClose?: () => void;
}) {
  const admin = usePayeeAdmin();
  const { search, setSearch, error } = admin;
  // Payees › Rules (budget-mit6): the transfer rules list; a row opens its payee.
  const [tab, setTab] = useState<'payees' | 'rules'>('payees');

  return (
    <View style={[styles.screen, contentTopPad > 0 && { paddingTop: contentTopPad }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('screen.title')}</Text>
        {onClose ? (
          <Pressable onPress={onClose} accessibilityLabel={tCommon('close')} hitSlop={8}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.tabs}>
        {(['payees', 'rules'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => setTab(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === k }}
            style={[styles.tab, tab === k && styles.tabOn]}>
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{k === 'payees' ? t('tabs.payees') : t('tabs.rules')}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'rules' ? (
        <ScrollView>
          <TransferRulesList
            payees={admin.all}
            accounts={admin.pickerBudget?.accounts ?? []}
            onOpen={(id) => {
              admin.selectById(id);
              setTab('payees');
            }}
          />
        </ScrollView>
      ) : (
      <>
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('screen.search')}
          placeholderTextColor={colors.faint}
          style={styles.searchInput}
        />
      </View>

      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <View style={styles.body}>
        <PayeeListPane admin={admin} />
        <PayeeDetailPane admin={admin} />
      </View>
      </>
      )}
    </View>
  );
}

/** The routed page: same body, no ✕ — navigation lives in the shell chrome. */
export function ManagePayeesScreen() {
  const shell = useBudgetShell();
  return <ManagePayeesBody contentTopPad={shell.isDesktop ? 0 : shell.contentTopPad} />;
}
