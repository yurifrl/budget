/**
 * Import-transactions page — bank/YNAB statement import.
 *
 * Flow: pick account → pick a file (web file input / native document picker)
 * → parse (`parseStatementFile`: Nubank CSV, Itaú extrato TXT/XLS,
 * generic CSV) → an unrecognized CSV layout opens a column mapper whose
 * mapping is persisted per account via {@link ImportMappingStoreToken} →
 * review parsed rows in a paginated, editable table (exclude rows, edit
 * date/payee/memo/amounts, associate statement payees with budget payees) →
 * bulk import (`POST /transactions/bulk`), saving payee associations as
 * per-payee 'contains' rename rules so future statements auto-resolve.
 *
 * A page (budget/import route), not a modal: the Accounts toolbar opens it
 * via the shell (`openImportTransactions` → router.push).
 */

import { ScrollView, Text, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import { GhostButton } from '@/ui/bits';
import { MappingSection } from './flow/MappingSection';
import { ReviewSection } from './flow/ReviewSection';
import { styles } from './flow/styles';
import { useImportFlow } from './flow/useImportFlow';
import { ManagePayeesModal } from '@/features/payees';
import { useBudgetShell } from '@/shell/context';

/**
 * Import-transactions page. Renders nothing useful before a budget exists;
 * the shell only routes here once a budget is active.
 */
export function ImportScreen() {
  const shell = useBudgetShell();
  const flow = useImportFlow();
  const { budgetId, accounts, account, setAccount, fileName, chooseFile, stage, rawText, drafts, rulesError, error, payeesOpen, setPayeesOpen } =
    flow;

  if (!budgetId) {
    return (
      <View style={styles.screen}>
        <Text style={styles.hint}>Activate a budget to import transactions.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}
    >
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Import Transactions</Text>
        <Text style={styles.heroSub}>
          Bank statements — Nubank CSV, Itaú extrato, generic CSV
        </Text>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Account</Text>
        <Combobox
          value={account?.name ?? ''}
          onChangeText={() => {}}
          onPick={(key) => {
            const match = (accounts.data ?? []).find((a) => a.id === key);
            setAccount(match ? { id: match.id, name: match.name } : null);
          }}
          options={(accounts.data ?? [])
            .filter((a) => !a.closed)
            .map((a) => ({ key: a.id, label: a.name, sub: a.account_group }))}
          placeholder="Choose account…"
          chevron
          accessibilityLabel="Import account"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>File</Text>
        <View style={styles.fileRow}>
          <GhostButton label="Choose file…" onPress={() => void chooseFile()} />
          <Text style={styles.fileName} numberOfLines={1}>
            {fileName ?? 'No file selected'}
          </Text>
          <GhostButton label="Manage payees" onPress={() => setPayeesOpen(true)} />
        </View>
        <Text style={styles.hint}>Supports Nubank CSV, Itaú extrato TXT/XLS, and generic CSV.</Text>
      </View>

      {stage === 'mapping' && rawText ? <MappingSection flow={flow} /> : null}

      {stage === 'preview' && drafts ? <ReviewSection flow={flow} drafts={drafts} /> : null}

      {rulesError ? <Text style={styles.errorText}>{rulesError}</Text> : null}
      {payeesOpen ? <ManagePayeesModal visible={payeesOpen} onClose={() => setPayeesOpen(false)} /> : null}
    </ScrollView>
  );
}
