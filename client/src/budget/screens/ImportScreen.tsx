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

import { useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useService } from '@/platform/di/ServiceContext';

import {
  useGetAccountsQuery,
  useGetPayeesQuery,
  useImportTransactionsMutation,
  useSetPayeeRenameRuleMutation,
} from '../data/api';
import { snakeImportRow } from '../data/mapping';
import type { PayeeAdminRow } from '../data/rows';
import { pickImportFile } from '@/platform/import/pickImportFile';
import { formatDate, parseDateInput } from '../domain/format';
import {
  assocRules,
  emptyMapping,
  ImportMappingStoreToken,
  makeDraftRows,
  parseCsv,
  parseMappedCsv,
  parseStatementFile,
  sniffDelimiter,
  type ColumnKey,
  type CsvMapping,
  type DraftImportRow,
  type ImportMappingStore,
  type ImportParseResult,
} from '../import';
import { useBudgetModel } from '../model/useBudgetModel';
import { Combobox } from '@/ui/combobox';
import { AmountCell, GhostButton, IndigoButton } from '../ui/bits';
import { colors, radius } from '../ui/theme';
import { ManagePayeesModal } from './ManagePayeesModal';
import { useBudgetShell } from './shell';

/** Review rows per page — a full statement at once is unusable on web. */
const PAGE_SIZE = 25;
/** Roles the mapper exposes; `amount` is the alternative to outflow+inflow. */
const COLUMN_ROLES: { key: ColumnKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'payee', label: 'Payee' },
  { key: 'memo', label: 'Memo' },
  { key: 'outflow', label: 'Outflow' },
  { key: 'inflow', label: 'Inflow' },
  { key: 'amount', label: 'Amount (signed)' },
];

const DELIMITERS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

function isUnrecognized(result: ImportParseResult): boolean {
  return result.errors.length === 1 && result.errors[0].startsWith('unrecognized file layout');
}

/** Small square toggle used for the mapper options and row inclusion. */
function CheckRow({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label?: string;
  onToggle: () => void;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.checkRow}>
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      {label ? <Text style={styles.checkLabel}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * Editable date cell — ISO display while idle, partial date entry
 * (DD, DD/MM, DD/MM/YYYY) committed on blur/Enter; invalid input reverts.
 */
function DateCell({ value, onCommit }: { value: string; onCommit: (iso: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <TextInput
      value={text ?? formatDate(value)}
      onChangeText={setText}
      onEndEditing={() => {
        const raw = text;
        setText(null);
        if (raw == null) return;
        const parsed = parseDateInput(raw.trim());
        if (parsed && parsed !== value) onCommit(parsed);
      }}
      style={styles.cellInput}
      accessibilityLabel="Transaction date"
    />
  );
}

/** Editable memo cell — commits on blur/Enter, trims whitespace. */
function MemoCell({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <TextInput
      value={text ?? value}
      onChangeText={setText}
      onEndEditing={() => {
        const raw = text;
        setText(null);
        if (raw == null) return;
        const next = raw.trim();
        if (next !== value) onCommit(next);
      }}
      style={styles.cellInput}
      accessibilityLabel="Transaction memo"
    />
  );
}

/**
 * Payee editor with a permanent ✕. A row associated with a budget payee shows
 * the payee's name as pure text; an unassociated row is a searchable payee
 * list whose create fallback keeps the typed statement text (the import
 * upserts it). In both states the ✕ returns the field to the original
 * statement text and drops the association.
 */
function PayeeCell({
  display,
  original,
  bound,
  options,
  onChange,
}: {
  /** Payee's name when bound, else the raw statement text. */
  display: string;
  /** Statement text at parse time — the ✕ reset target. */
  original: string;
  /** true = associated with a budget payee: pure text, not inline-editable. */
  bound: boolean;
  options: { key: string; label: string }[];
  onChange: (patch: { payee?: string; payeeId?: string | null }) => void;
}) {
  const reset = () => onChange({ payee: original, payeeId: null });
  const unbind = (
    <Pressable
      accessibilityLabel="Return payee to original statement text"
      onPress={reset}
      style={styles.payeeUnbind}
    >
      <Text style={styles.payeeUnbindGlyph}>✕</Text>
    </Pressable>
  );
  if (bound) {
    return (
      <View style={styles.payeeBound}>
        <Text style={styles.payeeBoundName} numberOfLines={1}>
          {display}
        </Text>
        {unbind}
      </View>
    );
  }
  return (
    <View style={styles.payeeBound}>
      <Combobox
        value={display}
        onChangeText={(text) => onChange({ payee: text, payeeId: null })}
        onPick={(key) => onChange({ payeeId: key })}
        onCreate={(query) => onChange({ payee: query, payeeId: null })}
        options={options}
        placeholder="Payee…"
        style={styles.payeeInput}
        containerStyle={styles.payeeEditorField}
        accessibilityLabel="Transaction payee"
      />
      {unbind}
    </View>
  );
}

/**
 * Import-transactions page. Renders nothing useful before a budget exists;
 * the shell only routes here once a budget is active.
 */
export function ImportScreen() {
  const shell = useBudgetShell();
  const router = useRouter();
  const { budgetId } = useBudgetModel();
  const scope = { budgetId: budgetId ?? '' };
  const accounts = useGetAccountsQuery(scope, { skip: !budgetId });
  const payees = useGetPayeesQuery(scope, { skip: !budgetId });
  const [importTxns, { isLoading: importing }] = useImportTransactionsMutation();
  const [setRenameRule] = useSetPayeeRenameRuleMutation();
  const mappingStore: ImportMappingStore = useService(ImportMappingStoreToken);

  const [account, setAccount] = useState<{ id: string; name: string } | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [stage, setStage] = useState<'pick' | 'mapping' | 'preview'>('pick');
  const [rawText, setRawText] = useState<string | null>(null);
  const [mapping, setMapping] = useState<CsvMapping>(emptyMapping);
  const [mappingNote, setMappingNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftImportRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [imported, setImported] = useState<{ imported: number; duplicates: number } | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payeesOpen, setPayeesOpen] = useState(false);

  // Visible payees for the per-row association dropdown (hidden payees
  // vanish from pickers; deleted rows are inert history).
  const payeeOptions = useMemo(
    () =>
      (payees.data ?? [])
        .filter((p: PayeeAdminRow) => !p.deleted && !p.hidden)
        .sort((a: PayeeAdminRow, b: PayeeAdminRow) => a.name.localeCompare(b.name))
        .map((p: PayeeAdminRow) => ({ key: p.id, label: p.name })),
    [payees.data],
  );
  const payeeById = useMemo(() => {
    const byId = new Map<string, PayeeAdminRow>();
    for (const p of payees.data ?? []) byId.set(p.id, p);
    return byId;
  }, [payees.data]);

  // Auto-selection pool (same visibility filter as the dropdown): statement
  // text that case-insensitively equals a payee name is pre-associated.
  const visiblePayees = useMemo(
    () => (payees.data ?? []).filter((p: PayeeAdminRow) => !p.deleted && !p.hidden),
    [payees.data],
  );

  // Pending associations: statement text → chosen payee name, shown so the
  // user sees what will be saved as rename rules (conflicts are dropped, and
  // payees that already carry a different rule keep their saved rule).
  const rules = useMemo(
    () =>
      drafts
        ? assocRules(drafts, payeeById).filter((rule) => {
            const current = payeeById.get(rule.payeeId)?.rename_condition;
            return current == null || current === rule.condition;
          })
        : [],
    [drafts, payeeById],
  );

  // Column count of the (suspected) header row drives the mapper dropdowns.
  const columnCount = useMemo(() => {
    if (!rawText) return 0;
    const rows = parseCsv(rawText, mapping.delimiter);
    return rows[mapping.headerRow]?.length ?? 0;
  }, [rawText, mapping.delimiter, mapping.headerRow]);

  // Live re-parse while the user adjusts the mapping.
  const mapped = useMemo(
    () => (stage === 'mapping' && rawText ? parseMappedCsv(rawText, mapping) : null),
    [stage, rawText, mapping],
  );

  const chooseFile = async () => {
    setError(null);
    setImported(null);
    setRulesError(null);
    try {
      const picked = await pickImportFile();
      if (!picked) return;
      setFileName(picked.name);
      setRawText(picked.text || null);
      const result = parseStatementFile(picked.name, picked);
      if (isUnrecognized(result)) {
        // Unknown layout → column mapper, prefilled from this account's
        // saved mapping when there is one.
        setDrafts(null);
        const firstLine = picked.text.split('\n', 1)[0] ?? '';
        const base: CsvMapping = { ...emptyMapping(), delimiter: sniffDelimiter(firstLine) };
        const saved = account ? mappingStore.load(account.id) : null;
        if (saved) {
          setMapping({ ...base, ...saved });
          setMappingNote('Using the mapping saved for this account.');
        } else {
          setMapping(base);
          setMappingNote(null);
        }
        setStage('mapping');
      } else if (result.rows.length === 0) {
        // Nothing parsed out of the file — surface the parser's rejection
        // (unreadable XLS, unsupported legacy OFC, …) instead of an empty
        // review table.
        setDrafts(null);
        setStage('pick');
        setError(apiErrorMessage(new Error(result.errors.join('; ')), 'failed to read the file'));
      } else {
        setDrafts(makeDraftRows(result.rows, visiblePayees));
        setStage('preview');
        setPage(0);
      }
    } catch (err) {
      setFileName(null);
      setRawText(null);
      setDrafts(null);
      setStage('pick');
      setError(apiErrorMessage(err, 'failed to read the file'));
    }
  };

  const confirmMapping = () => {
    if (!mapped || mapped.rows.length === 0) return;
    if (account) mappingStore.save(account.id, mapping);
    setDrafts(makeDraftRows(mapped.rows, visiblePayees));
    setStage('preview');
    setPage(0);
  };

  /** Reset the review table so another file can be imported. */
  const resetReview = () => {
    setDrafts(null);
    setFileName(null);
    setRawText(null);
    setMapping(emptyMapping());
    setMappingNote(null);
    setStage('pick');
    setImported(null);
    setRulesError(null);
    setPage(0);
  };

  // Functional update: a blur commit and the click that follows it (e.g.
  // pressing the amount's −/+ toggle) must not race on a stale drafts array.
  const patchDraft = (index: number, patch: Partial<DraftImportRow>) => {
    setDrafts((prev) => prev?.map((d, i) => (i === index ? { ...d, ...patch } : d)) ?? prev);
  };

  const included = drafts?.filter((d) => d.included) ?? [];
  const pageCount = drafts ? Math.max(1, Math.ceil(drafts.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = (drafts ?? []).slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const runImport = async () => {
    if (!account || !drafts || included.length === 0 || !budgetId || importing || imported) return;
    setError(null);
    try {
      const result = await importTxns({
        budgetId,
        accountId: account.id,
        txns: included.map((row) =>
          snakeImportRow({
            ...row,
            resolvedPayee: row.payeeId != null ? payeeById.get(row.payeeId)?.name : undefined,
          }),
        ),
      }).unwrap();
      setImported(result);
      if (rules.length > 0) {
        try {
          await Promise.all(
            rules.map((rule) =>
              setRenameRule({
                budgetId,
                payeeId: rule.payeeId,
                matchType: 'contains',
                condition: rule.condition,
              }),
            ),
          );
        } catch (err) {
          setRulesError(apiErrorMessage(err, 'transactions imported, but saving the payee rules failed'));
        }
      }
      // Import (and any rename rules) persisted — back to where the user
      // came from. Rule-save failures stay visible after returning.
      router.back();
    } catch (err) {
      setError(apiErrorMessage(err, 'import failed'));
    }
  };

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

      {stage === 'mapping' && rawText ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Column mapping</Text>
          <View style={styles.mapRow}>
            <Text style={styles.mapLabel}>Delimiter</Text>
            <View style={styles.delimRow}>
              {DELIMITERS.map(({ value, label }) => (
                <Pressable
                  key={value}
                  onPress={() => setMapping({ ...mapping, delimiter: value })}
                  style={[styles.delimBtn, mapping.delimiter === value && styles.delimBtnOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: mapping.delimiter === value }}>
                  <Text style={[styles.delimLabel, mapping.delimiter === value && styles.delimLabelOn]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <CheckRow
            checked={mapping.headerRow === 0}
            label="First row is a header"
            onToggle={() => setMapping({ ...mapping, headerRow: mapping.headerRow === 0 ? -1 : 0 })}
          />
          <CheckRow
            checked={mapping.chargePositive}
            label="Charges are positive (invert amounts)"
            onToggle={() => setMapping({ ...mapping, chargePositive: !mapping.chargePositive })}
          />
          {COLUMN_ROLES.map(({ key, label }) => (
            <View key={key} style={styles.mapRow}>
              <Text style={styles.mapLabel}>{label}</Text>
              <View style={styles.mapPicker}>
                <Combobox
                  value={mapping.columns[key] == null ? '' : `Column ${mapping.columns[key]! + 1}`}
                  onChangeText={() => {}}
                  onPick={(col) => setMapping({ ...mapping, columns: { ...mapping.columns, [key]: col === '-1' ? null : Number(col) } })}
                  options={[
                    { key: '-1', label: '(not imported)' },
                    ...Array.from({ length: columnCount }, (_, i) => ({ key: String(i), label: `Column ${i + 1}` })),
                  ]}
                  placeholder="Column…"
                  chevron
                  accessibilityLabel={`${label} column`}
                />
              </View>
            </View>
          ))}
          {mappingNote ? <Text style={styles.mappingNote}>{mappingNote}</Text> : null}
          {mapped ? (
            <>
              <Text style={styles.parseSummary}>
                {mapped.rows.length} transaction{mapped.rows.length === 1 ? '' : 's'}
                {mapped.skipped > 0 ? `, ${mapped.skipped} skipped` : ''}
              </Text>
              {mapped.errors.length > 0 ? (
                <>
                  <Text style={styles.sectionTitle}>Issues</Text>
                  {mapped.errors.slice(0, 5).map((line, i) => (
                    <Text key={i} style={styles.errorText} numberOfLines={2}>
                      {line}
                    </Text>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
          <IndigoButton label="Looks good — review rows" onPress={confirmMapping} />
        </View>
      ) : null}

      {stage === 'preview' && drafts ? (
        <View style={styles.section}>
          <View style={styles.summaryRow}>
            <Text style={styles.parseSummary}>
              {included.length} of {drafts.length} transaction{drafts.length === 1 ? '' : 's'} selected
              {drafts.length - included.length > 0 ? `, ${drafts.length - included.length} excluded` : ''}
            </Text>
            <GhostButton label="Deselect all" onPress={() => setDrafts(drafts.map((d) => ({ ...d, included: false })))} />
            <GhostButton label="Select all" onPress={() => setDrafts(drafts.map((d) => ({ ...d, included: true })))} />
          </View>

          {/* Register parity (AccountsScreen reghd): uppercase faint labels
              between border rules; column flex weights match the register. */}
          <View style={styles.tableHead}>
            <View style={styles.checkCell} />
            <Text style={[styles.thCell, styles.colDate]}>DATE</Text>
            <Text style={[styles.thCell, styles.colPayee]}>PAYEE</Text>
            <Text style={[styles.thCell, styles.colMemo]}>MEMO</Text>
            <Text style={[styles.thCell, styles.colAmount]}>AMOUNT</Text>
          </View>

          {pageRows.map((row, i) => {
            const index = safePage * PAGE_SIZE + i;
            return (
              <View key={index} style={[styles.row, !row.included && styles.rowExcluded]}>
                <View style={styles.checkCell}>
                  <CheckRow checked={row.included} onToggle={() => patchDraft(index, { included: !row.included })} />
                </View>
                <View style={styles.colDate}>
                  <DateCell value={row.date} onCommit={(iso) => patchDraft(index, { date: iso })} />
                </View>
                <View style={styles.colPayee}>
                  <PayeeCell
                    display={
                      row.payeeId != null
                        ? (payeeById.get(row.payeeId)?.name ?? row.payee)
                        : row.payee
                    }
                    original={row.originalPayee}
                    bound={row.payeeId != null}
                    options={payeeOptions}
                    onChange={(patch) => patchDraft(index, patch)}
                  />
                </View>
                <View style={styles.colMemo}>
                  <MemoCell value={row.memo} onCommit={(memo) => patchDraft(index, { memo })} />
                </View>
                <View style={styles.colAmount}>
                  <AmountCell
                    outflowCents={row.outflowCents}
                    inflowCents={row.inflowCents}
                    onChange={(patch) => patchDraft(index, patch)}
                  />
                </View>
              </View>
            );
          })}

          {pageCount > 1 ? (
            <View style={styles.pager}>
              <GhostButton
                label="‹ Prev"
                onPress={() => setPage(safePage - 1)}
                style={safePage === 0 ? { opacity: 0.4 } : undefined}
              />
              <Text style={styles.pageLabel}>
                Page {safePage + 1} of {pageCount}
              </Text>
              <GhostButton
                label="Next ›"
                onPress={() => setPage(safePage + 1)}
                style={safePage >= pageCount - 1 ? { opacity: 0.4 } : undefined}
              />
            </View>
          ) : null}

          {rules.length > 0 ? (
            <View style={styles.rulesNote}>
              <Text style={styles.rulesTitle}>
                {rules.length === 1 ? '1 payee association will be' : `${rules.length} payee associations will be`} saved as rename rules:
              </Text>
              {rules.slice(0, 4).map((rule) => (
                <Text key={rule.condition} style={styles.rulesLine} numberOfLines={1}>
                  “{rule.condition}” → {rule.replacement}
                </Text>
              ))}
              {rules.length > 4 ? <Text style={styles.rulesLine}>… and {rules.length - 4} more</Text> : null}
            </View>
          ) : null}

          {imported != null ? (
            <>
              <Text style={styles.doneText}>
                Imported {imported.imported} transaction{imported.imported === 1 ? '' : 's'}
                {imported.duplicates > 0 ? `, skipped ${imported.duplicates} duplicate${imported.duplicates === 1 ? '' : 's'}` : ''}
                {rules.length > 0 ? ` — ${rules.length} payee rule${rules.length === 1 ? '' : 's'} saved` : ''}
              </Text>
              <GhostButton label="Import another file" onPress={resetReview} />
            </>
          ) : (
            <IndigoButton
              label={`Import ${included.length} transaction${included.length === 1 ? '' : 's'}`}
              onPress={() => void runImport()}
            />
          )}
        </View>
      ) : null}

      {rulesError ? <Text style={styles.errorText}>{rulesError}</Text> : null}
      {payeesOpen ? <ManagePayeesModal visible={payeesOpen} onClose={() => setPayeesOpen(false)} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { paddingBottom: 90, paddingHorizontal: 18, gap: 14 },
  hero: { gap: 2, paddingTop: 16 },
  heroTitle: { color: colors.text, fontSize: 22, fontWeight: '700' },
  heroSub: { color: colors.muted, fontSize: 13 },
  section: { gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  fieldLabel: { color: colors.muted, fontSize: 12 },
  hint: { color: colors.faint, fontSize: 11 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fileName: { color: colors.text, fontSize: 13, flex: 1 },
  errorText: { color: colors.redFg, fontSize: 12 },
  parseSummary: { color: colors.muted, fontSize: 12 },
  mappingNote: { color: colors.faint, fontSize: 11 },
  mapRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mapLabel: { color: colors.text, fontSize: 13, width: 110 },
  mapPicker: { flex: 1 },
  delimRow: { flexDirection: 'row', gap: 8, flex: 1 },
  delimBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
  },
  delimBtnOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  delimLabel: { color: colors.text, fontSize: 12 },
  delimLabelOn: { color: '#fff' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkBox: { width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: colors.border2 },
  checkBoxOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  checkMark: { color: '#fff', fontSize: 12, lineHeight: 14 },
  checkLabel: { color: colors.text, fontSize: 13 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  // Register parity (AccountsScreen reghd/regrow): border-ruled header,
  // solid 1px row rules, 20/10-11 padding, faint uppercase 11px labels.
  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  checkCell: { width: 22 },
  thCell: { color: colors.faint, fontSize: 11, letterSpacing: 0.5 },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowExcluded: { opacity: 0.45 },
  colDate: { flex: 0.7 },
  colPayee: { flex: 1.4 },
  // Register MEMO column weight (AccountsScreen reghd).
  colMemo: { flex: 1.2 },
  // Right-justified pill wrapper, as the register's AMOUNT column.
  colAmount: { flex: 1.1, flexDirection: 'row', justifyContent: 'flex-end' },
  cellInput: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'], paddingVertical: 4 },
  payeeInput: { color: colors.text, fontSize: 13, paddingVertical: 4 },
  // Combobox container inside the permanent-✕ row.
  payeeEditorField: { flex: 1, minWidth: 0 },
  payeeBound: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
  payeeBoundName: { color: colors.text, fontSize: 13, flex: 1, minWidth: 0 },
  payeeUnbind: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  payeeUnbindGlyph: { color: colors.muted, fontSize: 11, lineHeight: 13 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 8 },
  pageLabel: { color: colors.muted, fontSize: 12 },
  rulesNote: { gap: 2, marginTop: 4 },
  rulesTitle: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  rulesLine: { color: colors.faint, fontSize: 11 },
  doneText: { color: colors.green, fontSize: 14, fontWeight: '600', marginTop: 4 },
});
