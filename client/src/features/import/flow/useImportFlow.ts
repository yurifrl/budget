/**
 * State and actions of the import-transactions page: the account pick, the
 * flow reducer (pick → mapping → preview), the payee association pools and
 * the file / mapping / import handlers.
 */

import { useMemo, useReducer, useState } from 'react';
import { useRouter } from 'expo-router';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useService } from '@/platform/di/ServiceContext';
import { pickImportFile } from '@/platform/import/pickImportFile';

import {
  useGetAccountsQuery,
  useGetPayeesQuery,
  useImportTransactionsMutation,
  useSetPayeeRenameRuleMutation,
} from '@/budget/data/api';
import { snakeImportRow } from '@/budget/data/mapping';
import {
  emptyMapping,
  ImportMappingStoreToken,
  makeDraftRows,
  parseMappedCsv,
  parseStatementFile,
  sniffDelimiter,
  type CsvMapping,
  type DraftImportRow,
  type ImportMappingStore,
} from '../parsers';
import { useBudgetModel } from '@/state/useBudgetModel';
import {
  headerColumnCount,
  importFlowReducer,
  initialImportFlow,
  parsedOutcome,
  payeeOptions as toPayeeOptions,
  payeesById,
  pendingRules,
  reviewPage,
  rowsToImport,
  visiblePayees as toVisiblePayees,
} from './importFlow.logic';

export type ImportFlow = ReturnType<typeof useImportFlow>;

export function useImportFlow() {
  const router = useRouter();
  const { budgetId } = useBudgetModel();
  const scope = { budgetId: budgetId ?? '' };
  const accounts = useGetAccountsQuery(scope, { skip: !budgetId });
  const payees = useGetPayeesQuery(scope, { skip: !budgetId });
  const [importTxns, { isLoading: importing }] = useImportTransactionsMutation();
  const [setRenameRule] = useSetPayeeRenameRuleMutation();
  const mappingStore: ImportMappingStore = useService(ImportMappingStoreToken);

  const [account, setAccount] = useState<{ id: string; name: string } | null>(null);
  const [flow, dispatch] = useReducer(importFlowReducer, undefined, initialImportFlow);
  const { fileName, stage, rawText, mapping, mappingNote, drafts, page, imported, rulesError, error } = flow;
  const [payeesOpen, setPayeesOpen] = useState(false);

  // Visible payees for the per-row association dropdown (hidden payees
  // vanish from pickers; deleted rows are inert history).
  const payeeOptions = useMemo(() => toPayeeOptions(payees.data ?? []), [payees.data]);
  const payeeById = useMemo(() => payeesById(payees.data ?? []), [payees.data]);

  // Auto-selection pool (same visibility filter as the dropdown): statement
  // text that case-insensitively equals a payee name is pre-associated.
  const visiblePayees = useMemo(() => toVisiblePayees(payees.data ?? []), [payees.data]);

  // Pending associations: statement text → chosen payee name, shown so the
  // user sees what will be saved as rename rules (conflicts are dropped, and
  // payees that already carry a different rule keep their saved rule).
  const rules = useMemo(() => pendingRules(drafts, payeeById), [drafts, payeeById]);

  // Column count of the (suspected) header row drives the mapper dropdowns.
  const columnCount = useMemo(
    () => headerColumnCount(rawText, { delimiter: mapping.delimiter, headerRow: mapping.headerRow }),
    [rawText, mapping.delimiter, mapping.headerRow],
  );

  // Live re-parse while the user adjusts the mapping.
  const mapped = useMemo(
    () => (stage === 'mapping' && rawText ? parseMappedCsv(rawText, mapping) : null),
    [stage, rawText, mapping],
  );

  const chooseFile = async () => {
    dispatch({ type: 'pickStarted' });
    try {
      const picked = await pickImportFile();
      if (!picked) return;
      dispatch({ type: 'fileRead', name: picked.name, text: picked.text });
      const result = parseStatementFile(picked.name, picked);
      const outcome = parsedOutcome(result);
      if (outcome === 'unrecognized') {
        // Unknown layout → column mapper, prefilled from this account's
        // saved mapping when there is one.
        const firstLine = picked.text.split('\n', 1)[0] ?? '';
        const base: CsvMapping = { ...emptyMapping(), delimiter: sniffDelimiter(firstLine) };
        // NOTE: `load` is async and is not awaited (as before the split): the
        // promise is truthy and spreads to nothing, so with an account picked
        // the note shows and the mapping is the base one.
        const saved = account ? mappingStore.load(account.id) : null;
        if (saved) {
          dispatch({ type: 'mappingNeeded', mapping: { ...base, ...saved }, note: 'Using the mapping saved for this account.' });
        } else {
          dispatch({ type: 'mappingNeeded', mapping: base, note: null });
        }
      } else if (outcome === 'empty') {
        // Nothing parsed out of the file — surface the parser's rejection
        // (unreadable XLS, unsupported legacy OFC, …) instead of an empty
        // review table.
        dispatch({
          type: 'fileRejected',
          error: apiErrorMessage(new Error(result.errors.join('; ')), 'failed to read the file'),
        });
      } else {
        dispatch({ type: 'rowsReady', drafts: makeDraftRows(result.rows, visiblePayees) });
      }
    } catch (err) {
      dispatch({ type: 'pickFailed', error: apiErrorMessage(err, 'failed to read the file') });
    }
  };

  const setMapping = (next: CsvMapping) => dispatch({ type: 'mappingChanged', mapping: next });

  const confirmMapping = () => {
    if (!mapped || mapped.rows.length === 0) return;
    if (account) mappingStore.save(account.id, mapping);
    dispatch({ type: 'rowsReady', drafts: makeDraftRows(mapped.rows, visiblePayees) });
  };

  /** Reset the review table so another file can be imported. */
  const resetReview = () => dispatch({ type: 'reviewReset' });

  // Reducer update: a blur commit and the click that follows it (e.g.
  // pressing the amount's −/+ toggle) must not race on a stale drafts array.
  const patchDraft = (index: number, patch: Partial<DraftImportRow>) => dispatch({ type: 'draftPatched', index, patch });
  const setAllIncluded = (included: boolean) => dispatch({ type: 'allIncluded', included });
  const setPage = (next: number) => dispatch({ type: 'pageSet', page: next });

  const included = drafts?.filter((d) => d.included) ?? [];
  const { pageCount, safePage, offset: pageOffset, rows: pageRows } = reviewPage(drafts, page);

  const runImport = async () => {
    if (!account || !drafts || included.length === 0 || !budgetId || importing || imported) return;
    dispatch({ type: 'importStarted' });
    try {
      const result = await importTxns({
        budgetId,
        accountId: account.id,
        txns: rowsToImport(drafts, payeeById).map((row) => snakeImportRow(row)),
      }).unwrap();
      dispatch({ type: 'imported', outcome: result });
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
          dispatch({
            type: 'rulesFailed',
            error: apiErrorMessage(err, 'transactions imported, but saving the payee rules failed'),
          });
        }
      }
      // Import (and any rename rules) persisted — back to where the user
      // came from. Rule-save failures stay visible after returning.
      router.back();
    } catch (err) {
      dispatch({ type: 'importFailed', error: apiErrorMessage(err, 'import failed') });
    }
  };

  return {
    budgetId,
    accounts,
    account,
    setAccount,
    fileName,
    stage,
    rawText,
    mapping,
    setMapping,
    mappingNote,
    columnCount,
    mapped,
    confirmMapping,
    chooseFile,
    drafts,
    included,
    pageCount,
    safePage,
    pageOffset,
    pageRows,
    setPage,
    patchDraft,
    setAllIncluded,
    payeeOptions,
    payeeById,
    rules,
    imported,
    runImport,
    resetReview,
    rulesError,
    error,
    payeesOpen,
    setPayeesOpen,
  };
}
