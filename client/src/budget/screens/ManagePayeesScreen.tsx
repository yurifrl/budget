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

import { Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '../ui/theme';
import { PayeeDetailPane } from './payees/PayeeDetailPane';
import { PayeeListPane } from './payees/PayeeListPane';
import { styles } from './payees/styles';
import { usePayeeAdmin } from './payees/usePayeeAdmin';
import { useBudgetShell } from './shell';

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

  return (
    <View style={[styles.screen, contentTopPad > 0 && { paddingTop: contentTopPad }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Manage Payees</Text>
        {onClose ? (
          <Pressable onPress={onClose} accessibilityLabel="Close" hitSlop={8}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name"
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
    </View>
  );
}

/** The routed page: same body, no ✕ — navigation lives in the shell chrome. */
export function ManagePayeesScreen() {
  const shell = useBudgetShell();
  return <ManagePayeesBody contentTopPad={shell.isDesktop ? 0 : shell.contentTopPad} />;
}
