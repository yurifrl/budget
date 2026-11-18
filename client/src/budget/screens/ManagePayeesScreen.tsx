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

import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppSelector } from '@/store/hooks';
import { Combobox } from '@/ui/combobox';

import {
  useAddCategoryMutation,
  useAddPayeeMutation,
  useDeletePayeeMutation,
  useGetPayeeTransactionsQuery,
  useGetPayeesQuery,
  useMergePayeesMutation,
  useRenamePayeeMutation,
  useSetPayeeCategorizationMutation,
  useSetPayeeHiddenMutation,
  useSetPayeeRenameRuleMutation,
} from '../data/api';
import { milliToCents } from '../data/mapping';
import type { PayeeAdminRow } from '../data/rows';
import type { MonthKey, Budget } from '../domain/types';
import { useMoneyFormat } from '../model/useDisplayPrefs';
import { categorizationModes, matchTypeLabels, matchTypes, type CategorizationMode, type MatchType } from '@shared/domain/payees';
import { useBudgetModel } from '../model/useBudgetModel';
import { useBudgetMonth } from '../model/useBudgetMonth';
import { selectActiveMonth } from '../state/ui';
import { CategoryDropdown } from './register/CategoryDropdown';
import { useBudgetShell } from './shell';
import { colors, radius } from '../ui/theme';

const CATEGORIZATION_LABELS: Record<CategorizationMode, { title: string; sub: string }> = {
  auto: { title: 'Auto-select', sub: 'suggest a category from past transactions' },
  fixed: { title: 'Fixed category', sub: 'always use the default category below' },
  never: { title: 'Never categorize', sub: 'leave new transactions uncategorized' },
};

export function ManagePayeesBody({
  /** Native top inset — page only; the modal sheet floats with its own padding. */
  contentTopPad = 0,
  /** Modal variant supplies it (✕ in the header); the routed page omits it. */
  onClose,
}: {
  contentTopPad?: number;
  onClose?: () => void;
}) {
  const { budget: modelBudget, budgetId: activeBudgetId } = useBudgetModel();
  const budgetId = activeBudgetId ?? '';
  const scope = { budgetId };
  const payees = useGetPayeesQuery(scope, { skip: !budgetId });

  const [renamePayee] = useRenamePayeeMutation();
  const [setHidden] = useSetPayeeHiddenMutation();
  const [setCategorization] = useSetPayeeCategorizationMutation();
  const [mergePayees] = useMergePayeesMutation();
  const [deletePayee] = useDeletePayeeMutation();
  const [addPayee] = useAddPayeeMutation();
  const [setRenameRule] = useSetPayeeRenameRuleMutation();
  const [addCategory] = useAddCategoryMutation();

  // pickerBudget: the model is the active budget — same id
  // every caller used to pass, guarded anyway.
  const pickerBudget = modelBudget && modelBudget.id === budgetId ? modelBudget : undefined;
  const activeMonth = useAppSelector((s) => selectActiveMonth(s));

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [showTxns, setShowTxns] = useState(false);
  // Renaming-rule draft for the selected payee; null until touched, so the
  // rendered value tracks the payee's saved rule until the user edits it.
  const [ruleDraft, setRuleDraft] = useState<{ matchType: MatchType; condition: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Rename conflict (409) shown under the name field, separate from the banner.
  const [nameError, setNameError] = useState<string | null>(null);
  // Prompt visibility is separate from the picked target: the target stays
  // null until a real pick in the searchable select — no preselected default.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  // Latest name draft, readable synchronously so blur-after-Enter can't
  // re-commit the same rename.
  const nameDraftRef = useRef<string | null>(null);

  const all = useMemo(() => payees.data ?? [], [payees.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Hidden payees stay listed (grey) so they can be found and unhidden;
    // transfer payees are excluded server-side.
    return all.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [all, search]);

  const selected = all.find((p) => p.id === selectedId) ?? null;
  // Merge targets: other live, non-transfer payees in the budget.
  const mergeCandidates = selected
    ? all.filter((p) => p.id !== selected.id && !p.deleted && p.transfer_account_id === null)
    : [];

  // Reset the detail pane together with the selection; selectById lets the
  // add-row path select a freshly created row it doesn't have an object for.
  const selectById = (id: string) => {
    setSelectedId(id);
    setNameDraft(null);
    nameDraftRef.current = null;
    setShowTxns(false);
    setRuleDraft(null);
    setMergeOpen(false);
    setMergeTargetId(null);
    setError(null);
    setNameError(null);
  };

  const select = (p: PayeeAdminRow) => selectById(p.id);

  const commitRename = async () => {
    if (!selected) return;
    const draft = nameDraftRef.current;
    nameDraftRef.current = null;
    setNameDraft(null);
    if (draft == null) return;
    const name = draft.trim();
    if (!name || name === selected.name) return;
    try {
      await renamePayee({ budgetId, payeeId: selected.id, name }).unwrap();
    } catch (err) {
      // The draft was already cleared above, so the field reverts to the saved name.
      const message = apiErrorMessage(err, 'failed to rename payee');
      if ((err as { status?: unknown } | null)?.status === 409) setNameError(message);
      else setError(message);
    }
  };

  /** Commit the selected payee's renaming rule; empty condition clears it. */
  const saveRule = async (patch?: Partial<{ matchType: MatchType; condition: string }>) => {
    if (!selected) return;
    const base = ruleDraft ?? {
      matchType: selected.rename_match_type ?? 'contains',
      condition: selected.rename_condition ?? '',
    };
    const next = { ...base, ...patch };
    const condition = next.condition.trim();
    const saved = {
      matchType: selected.rename_match_type ?? 'contains',
      condition: selected.rename_condition ?? '',
    };
    if (condition === saved.condition && next.matchType === saved.matchType) {
      setRuleDraft(null);
      return;
    }
    try {
      await setRenameRule({ budgetId, payeeId: selected.id, matchType: next.matchType, condition }).unwrap();
      setRuleDraft(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to save renaming rule'));
    }
  };

  /** Create a payee from the list pane's inline add row; select it after. */
  const addNewPayee = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const row = await addPayee({ budgetId, name }).unwrap();
      setNewName('');
      setSearch('');
      selectById(row.id);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to add payee'));
    }
  };

  const toggleHidden = async () => {
    if (!selected) return;
    try {
      await setHidden({ budgetId, payeeId: selected.id, hidden: !selected.hidden }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update payee'));
    }
  };

  const setCategorizationMode = async (mode: CategorizationMode) => {
    if (!selected) return;
    try {
      await setCategorization({
        budgetId,
        payeeId: selected.id,
        categorizationMode: mode,
        defaultCategoryId: selected.default_category_id,
      }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update categorization'));
    }
  };

  const setDefaultCategory = async (defaultCategoryId: string | null) => {
    if (!selected) return;
    try {
      await setCategorization({
        budgetId,
        payeeId: selected.id,
        categorizationMode: 'fixed',
        defaultCategoryId,
      }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update categorization'));
    }
  };

  /**
   * Delete semantics per YNAB: with transactions, deleting would orphan
   * them — offer a merge into a surviving payee instead. Without
   * transactions, soft-delete straight away.
   */
  const tryDelete = () => {
    if (!selected) return;
    if (selected.transaction_count > 0) setMergeOpen(true);
    else void doDelete();
  };

  /** Standalone "Merge into…": same prompt the delete fallback opens. */
  const openMerge = () => {
    if (!selected) return;
    setMergeOpen(true);
  };

  const doDelete = async () => {
    if (!selected) return;
    try {
      await deletePayee({ budgetId, payeeId: selected.id }).unwrap();
      setSelectedId(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to delete payee'));
    }
  };

  const doMerge = async () => {
    if (!selected || !mergeTargetId) return;
    try {
      await mergePayees({ budgetId, payeeId: selected.id, targetPayeeId: mergeTargetId }).unwrap();
      setSelectedId(null);
      setMergeOpen(false);
      setMergeTargetId(null);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to merge payees'));
    }
  };

  const busy = payees.isLoading;
  /** Matcher shown when no unsaved draft: the payee's stored rule, else Contains. */
  const draftMatchType: MatchType = ruleDraft?.matchType ?? selected?.rename_match_type ?? 'contains';

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
        {/* ------------------------------------------------ left: list */}
        <ScrollView style={styles.listPane} contentContainerStyle={styles.listContent}>
          <View style={styles.addRow}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              onSubmitEditing={addNewPayee}
              placeholder="Add a payee…"
              placeholderTextColor={colors.faint}
              style={styles.addInput}
              accessibilityLabel="New payee name"
            />
            <Pressable onPress={addNewPayee} accessibilityRole="button" accessibilityLabel="Add payee">
              <Text style={styles.addRowBtn}>＋</Text>
            </Pressable>
          </View>
          {busy ? (
            <Text style={styles.empty}>Loading…</Text>
          ) : filtered.length === 0 ? (
            <Text style={styles.empty}>No payees match “{search.trim()}”.</Text>
          ) : (
            filtered.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => select(p)}
                style={({ pressed }) => [
                  styles.listRow,
                  p.id === selectedId && styles.listRowActive,
                  pressed && { backgroundColor: colors.hover },
                ]}>
                <Text style={[styles.listName, p.hidden && styles.listNameHidden]} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={styles.listCount}>{p.transaction_count}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>

        {/* ---------------------------------------------- right: detail */}
        <ScrollView style={styles.detailPane} contentContainerStyle={styles.detailContent}>
          {!selected ? (
            <Text style={styles.empty}>Select a payee to edit its details.</Text>
          ) : mergeOpen ? (
            <MergePrompt
              payee={selected}
              candidates={mergeCandidates}
              targetId={mergeTargetId}
              onTargetChange={setMergeTargetId}
              onConfirm={() => void doMerge()}
              onCancel={() => {
                setMergeOpen(false);
                setMergeTargetId(null);
              }}
            />
          ) : (
            <>
              <Text style={styles.sectionLabel}>NAME</Text>
              <View style={styles.nameRow}>
                <TextInput
                  value={nameDraft ?? selected.name}
                  onChangeText={(v) => {
                    nameDraftRef.current = v;
                    setNameDraft(v);
                    setNameError(null);
                    setError(null);
                  }}
                  // RN-web never wires `onEndEditing` (types only), so
                  // blur-commit needs the web-native onBlur too. The
                  // nameDraftRef guard makes multi-fire commits idempotent.
                  onEndEditing={commitRename}
                  onSubmitEditing={commitRename}
                  onBlur={commitRename}
                  style={styles.nameInput}
                />
              </View>
              {nameError ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {nameError}
                </Text>
              ) : null}

              <Text style={styles.sectionLabel}>ACTIVITY</Text>
              <Text style={styles.activity}>
                {selected.transaction_count} transaction{selected.transaction_count === 1 ? '' : 's'}
                {selected.last_used_date
                  ? ` · last used ${selected.last_used_date.slice(0, 10)}`
                  : ' · never used'}
              </Text>

              {selected.transaction_count > 0 ? (
                <>
                  <Pressable
                    onPress={() => setShowTxns(!showTxns)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: showTxns }}>
                    <Text style={styles.linkText}>
                      {showTxns ? 'Hide' : 'Show'} {selected.transaction_count} Transactions
                    </Text>
                  </Pressable>
                  {showTxns ? (
                    <PayeeTxnsPane budgetId={budgetId} payeeId={selected.id} />
                  ) : null}
                </>
              ) : null}

              <Text style={styles.sectionLabel}>CATEGORIZATION</Text>
              {categorizationModes.map((mode) => (
                <Pressable
                  key={mode}
                  onPress={() => void setCategorizationMode(mode)}
                  style={styles.radioRow}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selected.categorization_mode === mode }}>
                  <Text style={[styles.radioDot, selected.categorization_mode === mode && styles.radioDotOn]}>
                    {selected.categorization_mode === mode ? '●' : '○'}
                  </Text>
                  <View style={styles.radioText}>
                    <Text style={styles.radioTitle}>{CATEGORIZATION_LABELS[mode].title}</Text>
                    <Text style={styles.radioSub}>{CATEGORIZATION_LABELS[mode].sub}</Text>
                  </View>
                </Pressable>
              ))}
              {selected.categorization_mode === 'auto' ? (
                <Text style={styles.radioSub}>
                  {selected.inferred_category_name
                    ? `Current default category: ${selected.inferred_category_name}`
                    : 'Current default category: none yet'}
                </Text>
              ) : null}
              {selected.categorization_mode === 'fixed' && pickerBudget ? (
                <>
                  <Text style={styles.pickerLabel}>Default category</Text>
                  <DefaultCategoryPicker
                    payee={selected}
                    budget={pickerBudget}
                    month={activeMonth}
                    onCommit={(defaultCategoryId) => void setDefaultCategory(defaultCategoryId)}
                    onCreateError={(err) => setError(apiErrorMessage(err, 'failed to create category'))}
                    addCategory={addCategory}
                    budgetId={budgetId}
                  />
                </>
              ) : null}

              <Text style={styles.sectionLabel}>RENAMING</Text>
              <Text style={styles.radioSub}>
                Imported payees that match this rule will be renamed to “{selected.name}”.
              </Text>
              <View style={styles.ruleForm}>
                <Combobox
                  value={matchTypeLabels[ruleDraft?.matchType ?? selected.rename_match_type ?? 'contains']}
                  onChangeText={(v) => {
                    // Matcher is pick-only: adopt a typed label when it
                    // matches exactly, otherwise snap back to the current one.
                    const mt = matchTypes.find((m) => matchTypeLabels[m].toLowerCase() === v.trim().toLowerCase());
                    if (mt && mt !== draftMatchType) void saveRule({ matchType: mt });
                  }}
                  options={matchTypes.map((mt) => ({ key: mt, label: matchTypeLabels[mt] }))}
                  onPick={(key) => void saveRule({ matchType: key as MatchType })}
                  chevron
                  style={styles.ruleMatcher}
                  containerStyle={styles.ruleMatcherBox}
                  accessibilityLabel="Renaming matcher"
                />
                <TextInput
                  value={ruleDraft?.condition ?? selected.rename_condition ?? ''}
                  onChangeText={(v) => setRuleDraft({ matchType: draftMatchType, condition: v })}
                  onEndEditing={() => void saveRule()}
                  onSubmitEditing={() => void saveRule()}
                  onBlur={() => void saveRule()}
                  placeholder={draftMatchType === 'is' ? 'Is…' : 'Contains…'}
                  placeholderTextColor={colors.faint}
                  style={[styles.ruleInput, { flex: 1 }]}
                  accessibilityLabel="Renaming condition"
                />
              </View>

              <View style={styles.footerRow}>
                <Pressable onPress={() => void toggleHidden()} accessibilityRole="button">
                  <Text style={styles.linkText}>{selected.hidden ? 'Unhide this payee' : 'Hide this payee'}</Text>
                </Pressable>
                {selected.transaction_count > 0 && mergeCandidates.length > 0 ? (
                  <Pressable onPress={openMerge} accessibilityRole="button">
                    <Text style={styles.linkText}>Merge into…</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={tryDelete} accessibilityRole="button">
                  <Text style={styles.deleteText}>Delete</Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/** The routed page: same body, no ✕ — navigation lives in the shell chrome. */
export function ManagePayeesScreen() {
  const shell = useBudgetShell();
  return <ManagePayeesBody contentTopPad={shell.isDesktop ? 0 : shell.contentTopPad} />;
}

/** In-page, paginated table of one payee's transactions (syscd-app-kr7). */
function PayeeTxnsPane({ budgetId, payeeId }: { budgetId: string; payeeId: string }) {
  const { formatDate, formatMoney } = useMoneyFormat();
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const query = useGetPayeeTransactionsQuery({ budgetId, payeeId, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  if (query.isLoading) return <Text style={styles.txnsEmpty}>Loading…</Text>;
  if (query.error) return <Text style={styles.txnsEmpty}>Failed to load transactions.</Text>;

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <View style={styles.txnsPane}>
      {rows.length === 0 ? (
        <Text style={styles.txnsEmpty}>No transactions.</Text>
      ) : (
        <View style={styles.txnsTable}>
          <View style={[styles.txnsRow, styles.txnsHead]}>
            <Text style={[styles.txnsCell, styles.txnsDate]}>DATE</Text>
            <Text style={[styles.txnsCell, styles.txnsPayee]}>MEMO</Text>
            <Text style={[styles.txnsCell, styles.txnsAccount]}>ACCOUNT</Text>
            <Text style={[styles.txnsCell, styles.txnsCat]}>CATEGORY</Text>
            <Text style={[styles.txnsCellRight, styles.txnsAmount]}>AMOUNT</Text>
          </View>
          {rows.map((t) => (
            <Pressable key={t.id} style={styles.txnsRow}>
              <Text style={[styles.txnsCell, styles.txnsDate]}>{formatDate(t.date)}</Text>
              <Text style={[styles.txnsCell, styles.txnsPayee]} numberOfLines={1}>
                {t.memo || '—'}
              </Text>
              <Text style={[styles.txnsCell, styles.txnsAccount]} numberOfLines={1}>
                {t.account_name}
              </Text>
              <Text style={[styles.txnsCell, styles.txnsCat]} numberOfLines={1}>
                {t.category_name ?? '—'}
              </Text>
              <Text
                style={[
                  styles.txnsCellRight,
                  styles.txnsAmount,
                  t.amount < 0 && styles.txnsAmountNeg,
                ]}>
                {formatMoney(milliToCents(t.amount))}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.txnsPager}>
        <Pressable onPress={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
          <Text style={[styles.txnsPageBtn, page === 0 && styles.txnsPageBtnOff]}>← Prev</Text>
        </Pressable>
        <Text style={styles.txnsPageInfo}>
          Page {page + 1} of {pages}
        </Text>
        <Pressable
          onPress={() => setPage((p) => (p + 1 < pages ? p + 1 : p))}
          disabled={page + 1 >= pages}>
          <Text style={[styles.txnsPageBtn, page + 1 >= pages && styles.txnsPageBtnOff]}>Next →</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Fixed-mode default-category picker (reuses the register's CategoryDropdown). */
function DefaultCategoryPicker({
  payee,
  budget,
  month,
  onCommit,
  onCreateError,
  addCategory,
  budgetId,
}: {
  payee: PayeeAdminRow;
  budget: Budget;
  month: MonthKey;
  onCommit: (defaultCategoryId: string | null) => void;
  onCreateError: (err: unknown) => void;
  addCategory: (
    arg: { budgetId: string; groupId: string; name: string; sortOrder: number },
  ) => { unwrap: () => Promise<{ id: string }> };
  budgetId: string;
}) {
  const bm = useBudgetMonth(budget, month);
  const current = budget.categories.find((c) => c.id === payee.default_category_id) ?? null;
  const placeholder = current
    ? `${current.name} (${budget.groups.find((g) => g.id === current.groupId)?.name ?? ''})`
    : 'None';

  const createCategory = async (query: string, assign: (id: string) => void) => {
    const group = budget.groups[0];
    if (!group || !query) return;
    try {
      const created = await addCategory({
        budgetId,
        groupId: group.id,
        name: query,
        sortOrder: budget.categories.length,
      }).unwrap();
      assign(created.id);
    } catch (err) {
      onCreateError(err);
    }
  };

  return (
    <CategoryDropdown
      categories={budget.categories}
      groups={budget.groups}
      bundles={budget.bundles}
      currentCategoryId={payee.default_category_id}
      bm={bm}
      // Transfer accounts make no sense as a default category; the empty list
      // leaves the menu's Payment/Transfer view with nothing to pick.
      accounts={[]}
      payeeValue={payee.name}
      onPick={(picked) => onCommit(picked)}
      onCreate={(query) => void createCategory(query, (id) => onCommit(id))}
      onTransferPick={() => undefined}
      placeholder={placeholder}
      chevron
      accessibilityLabel="Default category"
    />
  );
}

/** Delete-with-transactions fallback: merge into a surviving payee. */
function MergePrompt({
  payee,
  candidates,
  targetId,
  onTargetChange,
  onConfirm,
  onCancel,
}: {
  payee: PayeeAdminRow;
  candidates: PayeeAdminRow[];
  targetId: string | null;
  onTargetChange: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Live search text; the same select pattern the transaction import uses
  // for payee association (Combobox filters options as you type).
  const [query, setQuery] = useState('');
  return (
    <>
      <Text style={styles.sectionLabel}>MERGE PAYEE</Text>
      <Text style={styles.mergeCopy}>
        “{payee.name}” has {payee.transaction_count} transaction{payee.transaction_count === 1 ? '' : 's'}. Choose a
        payee to merge it into — its transactions move to that payee.
      </Text>
      <Combobox
        value={query}
        onChangeText={setQuery}
        options={candidates.map((c) => ({ key: c.id, label: c.name }))}
        onPick={(key) => {
          onTargetChange(key);
          setQuery(candidates.find((c) => c.id === key)?.name ?? '');
        }}
        placeholder="Search payees…"
        chevron
        autoFocus
        containerStyle={styles.mergeSelect}
        accessibilityLabel="Payee to merge into"
      />
      <View style={styles.footerRow}>
        <Pressable onPress={onCancel} accessibilityRole="button">
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={!targetId}
          style={styles.mergeBtn}
          accessibilityRole="button">
          <Text style={styles.mergeBtnText}>Merge</Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  close: { color: colors.muted, fontSize: 14, paddingHorizontal: 6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: {
    fontSize: 10,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontWeight: '700',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  searchIcon: { color: colors.faint, fontSize: 14 },
  searchInput: { color: colors.text, fontSize: 13, paddingVertical: 8, flex: 1 },
  error: { color: colors.redFg, fontSize: 12, marginBottom: 6 },
  // flex: 1 so the list ScrollView scrolls within the page instead of the
  // body growing with content.
  body: { flexDirection: 'row', gap: 12, flex: 1, minHeight: 0 },
  listPane: { width: 240, flexGrow: 0 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 6,
    gap: 6,
  },
  addInput: { color: colors.text, fontSize: 13, paddingVertical: 4, flex: 1 },
  addRowBtn: { color: colors.indigo2, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  listContent: { paddingBottom: 6 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: radius.sm,
  },
  listRowActive: { backgroundColor: colors.indigoSoft },
  listName: { color: colors.text, fontSize: 13, flex: 1, marginRight: 6 },
  listNameHidden: { color: colors.faint, fontStyle: 'italic' },
  listCount: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  empty: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
  detailPane: { flex: 1 },
  detailContent: { paddingBottom: 10, gap: 2 },
  sectionLabel: {
    fontSize: 9,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 4,
  },
  nameRow: { flexDirection: 'row', gap: 8 },
  nameInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  activity: { color: colors.muted, fontSize: 12, marginBottom: 4 },
  linkText: { color: colors.indigo2, fontSize: 13, fontWeight: '600', paddingVertical: 3 },
  radioRow: { flexDirection: 'row', gap: 8, paddingVertical: 4, alignItems: 'flex-start' },
  radioDot: { color: colors.indigo2, fontSize: 13, marginTop: 1 },
  radioDotOn: { color: colors.indigo2 },
  radioText: { flex: 1 },
  radioTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  radioSub: { color: colors.faint, fontSize: 11 },
  ruleForm: { flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 4 },
  ruleMatcherBox: { width: 120 },
  ruleMatcher: { fontSize: 12, paddingVertical: 6 },
  ruleInput: {
    color: colors.text,
    fontSize: 12,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  deleteText: { color: colors.redFg, fontSize: 13, fontWeight: '600' },
  mergeCopy: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  mergeSelect: { marginTop: 8 },
  pickerLabel: { color: colors.faint, fontSize: 10, letterSpacing: 1, marginTop: 4 },
  txnsPane: { gap: 6, paddingVertical: 4 },
  txnsTable: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  txnsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  txnsHead: { backgroundColor: colors.bg2, borderTopWidth: 0 },
  txnsCell: { color: colors.text, fontSize: 12 },
  txnsDate: { width: 76, color: colors.muted },
  txnsPayee: { flex: 2, color: colors.muted },
  txnsAccount: { flex: 1.4, color: colors.muted },
  txnsCat: { flex: 1.4 },
  txnsCellRight: { textAlign: 'right' },
  txnsAmount: { flex: 1, fontVariant: ['tabular-nums'] },
  txnsAmountNeg: { color: colors.redFg },
  txnsEmpty: { color: colors.muted, fontSize: 12, paddingVertical: 4 },
  txnsPager: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  txnsPageBtn: { color: colors.text, fontSize: 12, fontWeight: '600' },
  txnsPageBtnOff: { color: colors.faint },
  txnsPageInfo: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  mergeBtn: {
    backgroundColor: colors.indigo,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  mergeBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
