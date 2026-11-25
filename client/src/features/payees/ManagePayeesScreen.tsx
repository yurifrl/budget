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
 * with a default-category picker, "Never a transfer", the Renaming card
 * (several rules, each applicable to past transactions with undo), hide,
 * merge, and delete (routes to a merge prompt when the payee still has
 * transactions). The list has two groups: the payees and the accounts'
 * transfer payees; a transfer payee shows only its name and Renaming card.
 *
 * Data comes straight from the payee endpoints added by syscd-app-7pa;
 * mutations live in data/api.ts.
 */

import { Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { colors } from '@/ui/theme';
import { t } from './i18n';
import { PayeeDetailPane } from './PayeeDetailPane';
import { PayeeListPane } from './PayeeListPane';
import { styles } from './styles';
import { usePayeeAdmin } from './usePayeeAdmin';
import { useBudgetShell } from '@/shell/context';
import { useApplyUndo } from './useApplyUndo';

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
  // "Apply to past transactions" toast with Undo: lives here so it outlasts picking another payee.
  const undo = useApplyUndo(admin.budgetId);
  // Phone width: one pane at a time (the list, or the selected payee with a back link).
  const narrow = useWindowDimensions().width < 700;

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

      {narrow && admin.selected ? (
        <Pressable onPress={admin.clearSelected} accessibilityRole="button" style={{ marginBottom: 6 }}>
          <Text style={styles.linkText}>{t('screen.back')}</Text>
        </Pressable>
      ) : null}
      <View style={styles.body}>
        {!narrow || !admin.selected ? <PayeeListPane admin={admin} fill={narrow} /> : null}
        {!narrow || admin.selected ? <PayeeDetailPane admin={admin} onApplied={undo.show} /> : null}
      </View>
      {undo.node}
    </View>
  );
}

/** The routed page: same body, no ✕ — navigation lives in the shell chrome. */
export function ManagePayeesScreen() {
  const shell = useBudgetShell();
  return <ManagePayeesBody contentTopPad={shell.isDesktop ? 0 : shell.contentTopPad} />;
}
