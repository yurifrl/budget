/**
 * State and actions of the add/edit transaction sheet: the keypad amount,
 * Spending/Income, the payee / category / account pickers with their search,
 * the date, and saving.
 */

import { useMemo, useReducer, useRef, useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppSelector } from '@/state/hooks';

import {
  useAddCategoryMutation,
  useAddTransactionMutation,
  useGetAccountsQuery,
  useGetBundlesQuery,
  useGetCategoriesQuery,
  useGetGroupsQuery,
  useGetPayeesWithTransfersQuery,
  useLazyGetPayeeSuggestionQuery,
  useUpdateTransactionMutation,
} from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { isTransferToOnBudget } from '@shared/domain/transfers';
import { isPickableCategory } from '@/domain/pickable';
import { draftTransferAccount, transferChoices } from '@/domain/transfers';
import { categoryLabel } from '@/domain/bundles';
import { addDaysToDate } from '@/domain/date';
import { todayIso } from '@/domain/format';
import { initialSheetKind, resolveSheetCategory, toggleSheetKind } from '@/domain/sheetKind';
import { keypadReducer, keypadStart, settledAmount, type KeypadKey } from '@/domain/txnKeypad';
import {
  canCreateNamed,
  canSaveAmount,
  initialSheetAmount,
  pickableAccounts,
  searchByLabel,
  sheetAccount,
  sheetEditPatch,
  sheetNewTransaction,
} from '@/domain/txnSheet';
import type { Transaction } from '@/domain/types';
import { selectActiveBudgetId } from '@/state/ui';
import { t } from './i18n';
import { matchesSystemName } from '@/domain/systemNames';

export type PickerMode = 'none' | 'payee' | 'category' | 'account';

export type AddTransaction = ReturnType<typeof useAddTransaction>;

export function useAddTransaction({
  onClose,
  editTxn,
  prefillCategoryId,
}: {
  onClose: () => void;
  editTxn: Transaction | null;
  prefillCategoryId: string | null;
}) {
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const scope = budgetId ? { budgetId } : { budgetId: '' };
  const categories = useGetCategoriesQuery(scope, { skip: !budgetId });
  const bundleRows = useGetBundlesQuery(scope, { skip: !budgetId });
  const accounts = useGetAccountsQuery(scope, { skip: !budgetId });
  const groups = useGetGroupsQuery(scope, { skip: !budgetId });
  const payees = useGetPayeesWithTransfersQuery(scope, { skip: !budgetId });
  const [addTransaction, addState] = useAddTransactionMutation();
  const [updateTransaction, updateState] = useUpdateTransactionMutation();
  const [addCategory] = useAddCategoryMutation();
  const [fetchSuggestion] = useLazyGetPayeeSuggestionQuery();

  const [keypad, dispatchKeypad] = useReducer(keypadReducer, initialSheetAmount(editTxn), keypadStart);
  const initialKind = initialSheetKind(editTxn, prefillCategoryId);
  const [isIncome, setIsIncome] = useState(initialKind.isIncome);
  const [payee, setPayee] = useState(editTxn?.payee ?? '');
  // The picked payee's id (an existing payee, a transfer payee too); null for typed text.
  const [payeeId, setPayeeId] = useState<string | null>(editTxn?.payeeId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(initialKind.categoryId);
  const [accountId, setAccountId] = useState<string | null>(editTxn?.accountId ?? null);
  const [date, setDate] = useState(editTxn?.date ?? todayIso());
  const [picker, setPicker] = useState<PickerMode>('none');
  const [search, setSearch] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Payee id of the in-flight suggestion fetch — a stale response must not
   * overwrite a category picked after the fetch started. */
  const pickedPayeeIdRef = useRef<string | null>(null);

  const reset = () => {
    dispatchKeypad({ type: 'reset' });
    setIsIncome(false);
    setPayee('');
    setPayeeId(null);
    setCategoryId(null);
    setPicker('none');
    setSearch('');
    setDate(todayIso());
    setSaveError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const pressKey = (key: Exclude<KeypadKey, 'done'>) => dispatchKeypad({ type: 'key', key });
  const settled = settledAmount(keypad);

  const account = sheetAccount(accounts.data, accountId);
  // A transfer payee between two on-budget accounts: no category, and none can be set.
  const budgetAccounts = (accounts.data ?? []).map((a) => ({ id: a.id, onBudget: a.on_budget }));
  const transferAccountId = draftTransferAccount(editTxn, { payee, payeeId }, payees.data ?? []);
  const categoryLocked = !!account && isTransferToOnBudget(budgetAccounts, account.id, transferAccountId);
  const resolvedCategoryId = categoryLocked ? null : resolveSheetCategory({ isIncome, categoryId }, !!editTxn);
  const category = categories.data?.find((c) => c.id === resolvedCategoryId) ?? null;

  const bundles = useMemo(
    () => (bundleRows.data ?? []).map((b) => ({ id: b.id, groupId: b.group_id, name: b.name })),
    [bundleRows.data],
  );
  const labelOf = (c: { name: string; bundle_id?: string | null }) =>
    categoryLabel({ name: c.name, bundleId: c.bundle_id ?? undefined }, bundles);

  const query = search.trim();
  // Ordinary payees; the accounts' transfer payees are the "Payments and Transfers" section.
  const ordinaryPayees = (payees.data ?? []).filter((p) => p.transfer_account_id === null && !p.deleted);
  const filteredPayees = ordinaryPayees.filter((p) => !query || matchesSystemName(p.name, query.toLowerCase()));
  const filteredTransfers = transferChoices(
    payees.data ?? [],
    (accounts.data ?? []).map((a) => ({ id: a.id, name: a.name, group: a.account_group, onBudget: a.on_budget })),
    account?.id ?? null,
  ).filter(({ payee: p }) => !query || matchesSystemName(p.name, query.toLowerCase()));
  const canCreatePayee = canCreateNamed(payees.data ?? [], search);
  const groupFlags = (groups.data ?? []).map((g) => ({ id: g.id, isCreditCardPayments: g.is_credit_card_payments, internal: g.internal }));
  const pickableCategoryRows = (categories.data ?? []).filter((c) => isPickableCategory({ groupId: c.group_id, internal: c.internal }, groupFlags));
  const filteredCategories = searchByLabel(pickableCategoryRows, search, labelOf);
  const canCreateCategory = canCreateNamed(categories.data ?? [], search);
  const accountChoices = pickableAccounts(accounts.data ?? [], accountId);

  const closePicker = () => {
    setSearch('');
    setPicker('none');
  };

  const toggleKind = () => {
    const next = toggleSheetKind({ isIncome, categoryId });
    setIsIncome(next.isIncome);
    setCategoryId(next.categoryId);
  };

  const pickPayee = (name: string, row?: PayeeAdminRow) => {
    setPayee(name);
    setPayeeId(row?.id ?? null);
    closePicker();
    // A transfer payee carries no category (and no payee-based suggestion).
    if (row?.transfer_account_id) {
      setCategoryId(null);
      return;
    }
    // Auto-select the category the server will infer for this payee on save
    // (categorization mode + history, syscd-app-7pa). Only rows from the
    // payee list carry an id; a hand-typed (created) payee has no history.
    if (!row || !budgetId) return;
    pickedPayeeIdRef.current = row.id;
    fetchSuggestion({ budgetId, payeeId: row.id })
      .then((res) => {
        const suggested = res.data?.category_id;
        if (suggested && pickedPayeeIdRef.current === row.id) setCategoryId(suggested);
      })
      .catch(() => {});
  };

  const pickCategory = (id: string) => {
    setCategoryId(id);
    closePicker();
  };

  const pickAccount = (id: string) => {
    setAccountId(id);
    closePicker();
  };

  const stepDate = (days: number) => setDate((d) => addDaysToDate(d, days));

  const createCategory = async () => {
    const group = groups.data?.[0];
    if (!budgetId || !group || !query) return;
    setSaveError(null);
    try {
      const created = await addCategory({
        budgetId,
        groupId: group.id,
        name: query,
        sortOrder: categories.data?.length ?? 0,
      }).unwrap();
      setCategoryId(created.id);
      closePicker();
    } catch (err) {
      setSaveError(apiErrorMessage(err, t('error.createCategory')));
    }
  };

  const save = async () => {
    if (!budgetId || !account || !canSaveAmount(settled) || addState.isLoading || updateState.isLoading) return;
    setSaveError(null);
    const form = { accountId: account.id, date, payee, payeeId, categoryId: category?.id ?? null, isIncome, amount: settled };
    try {
      if (editTxn) {
        await updateTransaction({ budgetId, id: editTxn.id, patch: sheetEditPatch(form, editTxn) }).unwrap();
        close();
        return;
      }
      await addTransaction({ budgetId, txn: sheetNewTransaction(form) }).unwrap();
      close();
    } catch (err) {
      setSaveError(apiErrorMessage(err, t('error.save')));
    }
  };

  return {
    close,
    settled,
    pressKey,
    save,
    saveError,
    isIncome,
    toggleKind,
    payee,
    payeeId,
    category,
    categoryId,
    categoryLocked,
    labelOf,
    account,
    date,
    stepDate,
    picker,
    setPicker,
    closePicker,
    search,
    setSearch,
    query,
    filteredPayees,
    filteredTransfers,
    canCreatePayee,
    pickPayee,
    filteredCategories,
    canCreateCategory,
    createCategory,
    pickCategory,
    accountChoices,
    pickAccount,
  };
}
