/**
 * Add-transaction sheet — calculator-style entry (mock `.txn-sheet`):
 * amount keypad (with ÷ × − ＋), Spending/Income toggle, payee, category,
 * account, date. Saving persists through `budgetApi.addTransaction`, which
 * also applies the account balance delta (new entries start uncleared).
 * Header clears the status bar; drag the header down to dismiss.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppSelector } from '@/store/hooks';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { addDaysToDate } from '@/platform/date';
import {
  useAddCategoryMutation,
  useAddTransactionMutation,
  useGetAccountsQuery,
  useGetBundlesQuery,
  useGetCategoriesQuery,
  useGetGroupsQuery,
  useGetPayeesQuery,
  useLazyGetPayeeSuggestionQuery,
  useUpdateTransactionMutation,
} from '../data/api';
import type { PayeeAdminRow } from '../data/rows';
import { categoryLabel } from '../domain/bundles';
import { formatDate, formatMoney, todayIso } from '../domain/format';
import { applyMathOp, type MathOp } from '../domain/quickmath';
import { initialSheetKind, resolveSheetCategory, toggleSheetKind } from '../domain/sheetKind';
import type { Cents, Transaction } from '../domain/types';
import { selectActiveBudgetId } from '../state/ui';
import { colors, radius } from '../ui/theme';

type Op = MathOp;
type PickerMode = 'none' | 'payee' | 'category' | 'account';

export function AddTransactionSheet({
  visible,
  onClose,
  editTxn = null,
  prefillCategoryId = null,
}: {
  visible: boolean;
  onClose: () => void;
  editTxn?: Transaction | null;
  /** New-entry prefill (mobile category detail "＋ Transaction"). The shell
   * keys the sheet by this id so a changed prefill remounts with fresh state. */
  prefillCategoryId?: string | null;
}) {
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const scope = budgetId ? { budgetId } : { budgetId: '' };
  const categories = useGetCategoriesQuery(scope, { skip: !budgetId });
  const bundleRows = useGetBundlesQuery(scope, { skip: !budgetId });
  const accounts = useGetAccountsQuery(scope, { skip: !budgetId });
  const groups = useGetGroupsQuery(scope, { skip: !budgetId });
  const payees = useGetPayeesQuery(scope, { skip: !budgetId });
  const [addTransaction, addState] = useAddTransactionMutation();
  const [updateTransaction, updateState] = useUpdateTransactionMutation();
  const [addCategory] = useAddCategoryMutation();
  const [fetchSuggestion] = useLazyGetPayeeSuggestionQuery();

  const [amount, setAmount] = useState<Cents>(
    editTxn ? (editTxn.inflow > 0 ? editTxn.inflow : editTxn.outflow) : 0,
  );
  const [pending, setPending] = useState<{ value: Cents; op: Op } | null>(null);
  const initialKind = initialSheetKind(editTxn, prefillCategoryId);
  const [isIncome, setIsIncome] = useState(initialKind.isIncome);
  const [payee, setPayee] = useState(editTxn?.payee ?? '');
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
    setAmount(0);
    setPending(null);
    setIsIncome(false);
    setPayee('');
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

  // iPhone: the Modal renders edge-to-edge, so the header must clear the
  // status bar and the keypad the home indicator.
  const insets = useSafeAreaInsets();
  // Drag-down dismiss: the header is the grabber region; the sheet follows the
  // finger and commits the close past 120px, otherwise springs back.
  const dragY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) dragY.setValue(0);
  }, [visible, dragY]);
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) dragY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 120) {
          Animated.timing(dragY, { toValue: 900, duration: 220, useNativeDriver: true }).start(() => close());
        } else {
          Animated.spring(dragY, { toValue: 0, speed: 24, bounciness: 4, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const pressDigit = (d: number) => setAmount((a) => Math.min(a * 10 + d, 999999999));
  const pressBackspace = () => setAmount((a) => Math.floor(a / 10));
  const pressOp = (op: Op) => {
    setPending({ value: pending ? (applyMathOp(pending.value, op, amount) ?? pending.value) : amount, op });
    setAmount(0);
  };
  // Chained ops accumulate in `pending`; the typed amount is 0 between ops.
  const settled =
    pending && amount === 0
      ? pending.value
      : pending
        ? (applyMathOp(pending.value, pending.op, amount) ?? pending.value)
        : amount;

  // The txn's own account stays listed even when closed (editing an existing
  // row on a closed account); closed accounts are otherwise not pick targets.
  const account = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.find((a) => !a.closed);
  const resolvedCategoryId = resolveSheetCategory({ isIncome, categoryId }, !!editTxn);
  const category = categories.data?.find((c) => c.id === resolvedCategoryId) ?? null;

  const bundles = useMemo(
    () => (bundleRows.data ?? []).map((b) => ({ id: b.id, groupId: b.group_id, name: b.name })),
    [bundleRows.data],
  );
  const labelOf = (c: { name: string; bundle_id?: string | null }) =>
    categoryLabel({ name: c.name, bundleId: c.bundle_id ?? undefined }, bundles);

  const query = search.trim();
  const q = query.toLowerCase();
  const filteredPayees = (payees.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  const canCreatePayee = q.length > 0 && !(payees.data ?? []).some((p) => p.name.toLowerCase() === q);
  const filteredCategories = (categories.data ?? []).filter((c) => !q || labelOf(c).toLowerCase().includes(q));
  const canCreateCategory =
    q.length > 0 && !(categories.data ?? []).some((c) => c.name.toLowerCase() === q);

  const closePicker = () => {
    setSearch('');
    setPicker('none');
  };

  const pickPayee = (name: string, row?: PayeeAdminRow) => {
    setPayee(name);
    closePicker();
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
      setSaveError(apiErrorMessage(err, 'failed to create category'));
    }
  };

  const save = async () => {
    if (!budgetId || !account || settled <= 0 || addState.isLoading || updateState.isLoading) return;
    setSaveError(null);
    const outflow = isIncome ? 0 : settled;
    const inflow = isIncome ? settled : 0;
    const categoryIdOut = category?.id ?? null;
    try {
      if (editTxn) {
        const cleared = editTxn.cleared;
        const patch = {
          accountId: account.id,
          date,
          payee: payee.trim(),
          categoryId: categoryIdOut,
          outflowCents: outflow,
          inflowCents: inflow,
        };
        await updateTransaction({ budgetId, id: editTxn.id, patch }).unwrap();
        close();
        return;
      }
      const txn = {
        accountId: account.id,
        date,
        payee: payee.trim(),
        categoryId: categoryIdOut,
        memo: '',
        outflowCents: outflow,
        inflowCents: inflow,
        cleared: 'uncleared' as const,
        approved: true,
        flag: null,
        repeat: 'never',
      };
      await addTransaction({ budgetId, txn }).unwrap();
      close();
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'failed to save transaction'));
    }
  };

  const keys: (string | Op)[] = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '⌫', '+', 'done'];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.sheet, { transform: [{ translateY: dragY }] }]}>
          <View style={[styles.top, { paddingTop: 14 + insets.top }]} {...panResponder.panHandlers}>
            <Pressable style={[styles.closeBtn, { top: 14 + insets.top }]} onPress={close} accessibilityLabel="Close">
              <Text style={{ color: colors.text, fontSize: 15 }}>✕</Text>
            </Pressable>
            <Text style={styles.amount}>
              {isIncome ? '' : '−'}
              {formatMoney(settled)}
            </Text>
            <Pressable
              style={styles.typeToggle}
              onPress={() => {
                const next = toggleSheetKind({ isIncome, categoryId });
                setIsIncome(next.isIncome);
                setCategoryId(next.categoryId);
              }}
              accessibilityLabel="Toggle spending or income">
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>
                {isIncome ? '⊞ Income ⇅' : '⊟ Spending ⇅'}
              </Text>
            </Pressable>
          </View>

          {picker === 'none' ? (
            <ScrollView style={styles.rows}>
              <Pressable style={styles.row} onPress={() => setPicker('payee')}>
                <Text style={styles.rowIcon}>◎</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowK}>Payee</Text>
                  <Text style={styles.rowV}>{payee || 'Choose…'}</Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>
              <Pressable style={styles.row} onPress={() => setPicker('category')}>
                <Text style={styles.rowIcon}>▤</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowK}>Category</Text>
                  <Text style={styles.rowV}>
                    {(category ? labelOf(category) : null) ?? (isIncome ? 'Ready to Assign' : 'Choose…')}
                  </Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>
              <Pressable style={styles.row} onPress={() => setPicker('account')}>
                <Text style={[styles.rowIcon, { color: colors.greenPillFg }]}>◉</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowK}>Account</Text>
                  <Text style={styles.rowV}>{account?.name ?? 'Choose…'}</Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>
              <View style={styles.row}>
                <Text style={styles.rowIcon}>▦</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowK}>Date</Text>
                  <Text style={styles.rowV}>{formatDate(date)}</Text>
                </View>
                <Pressable onPress={() => setDate((d) => addDaysToDate(d, -1))} hitSlop={8}>
                  <Text style={styles.dateStep}>‹</Text>
                </Pressable>
                <Pressable onPress={() => setDate((d) => addDaysToDate(d, 1))} hitSlop={8}>
                  <Text style={styles.dateStep}>›</Text>
                </Pressable>
              </View>
            </ScrollView>
          ) : (
            <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled">
              <Pressable style={styles.row} onPress={closePicker}>
                <Text style={styles.rowIcon}>‹</Text>
                <Text style={styles.rowV}>Back</Text>
              </Pressable>
              {picker !== 'account' ? (
                <View style={styles.row}>
                  <Text style={styles.rowIcon}>⌕</Text>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder={picker === 'payee' ? 'Find or add a payee' : 'Search Categories'}
                    placeholderTextColor={colors.muted}
                    autoFocus
                    style={styles.payeeInput}
                    accessibilityLabel={picker === 'payee' ? 'Find or add a payee' : 'Search categories'}
                  />
                </View>
              ) : null}
              {picker === 'payee' ? (
                <>
                  {canCreatePayee ? (
                    <Pressable style={styles.row} onPress={() => pickPayee(query)}>
                      <Text style={[styles.rowIcon, { color: colors.indigo2 }]}>＋</Text>
                      <Text style={[styles.rowV, { color: colors.indigo2 }]}>
                        Create “{query}” Payee
                      </Text>
                    </Pressable>
                  ) : null}
                  {filteredPayees.map((p) => (
                    <Pressable key={p.id} style={styles.row} onPress={() => pickPayee(p.name, p)}>
                      <Text style={styles.rowV}>{p.name}</Text>
                      {payee === p.name ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
                    </Pressable>
                  ))}
                </>
              ) : null}
              {picker === 'category' ? (
                <>
                  {canCreateCategory ? (
                    <Pressable style={styles.row} onPress={() => void createCategory()}>
                      <Text style={[styles.rowIcon, { color: colors.indigo2 }]}>＋</Text>
                      <Text style={[styles.rowV, { color: colors.indigo2 }]}>
                        New “{query}” Category
                      </Text>
                    </Pressable>
                  ) : null}
                  {filteredCategories.map((c) => (
                    <Pressable
                      key={c.id}
                      style={styles.row}
                      onPress={() => {
                        setCategoryId(c.id);
                        closePicker();
                      }}>
                      <Text style={styles.rowV}>{labelOf(c)}</Text>
                      {categoryId === c.id ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
                    </Pressable>
                  ))}
                </>
              ) : null}
              {picker === 'account'
                ? (accounts.data ?? []).filter((a) => !a.closed || a.id === accountId).map((a) => (
                    <Pressable
                      key={a.id}
                      style={styles.row}
                      onPress={() => {
                        setAccountId(a.id);
                        closePicker();
                      }}>
                      <Text style={styles.rowV}>{a.name}</Text>
                      {account?.id === a.id ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
                    </Pressable>
                  ))
                : null}
            </ScrollView>
          )}

          {saveError ? (
            <Text style={styles.errorStrip} accessibilityRole="alert">
              {saveError}
            </Text>
          ) : null}

          <View style={[styles.keypad, { paddingBottom: 26 + insets.bottom }]}>
            {keys.map((k) => (
              <Pressable
                key={k}
                style={[styles.key, k === 'done' && styles.keyDone, '÷×−+⌫'.includes(k) && styles.keyOp]}
                onPress={() => {
                  if (k === 'done') void save();
                  else if (k === '⌫') pressBackspace();
                  else if (k === '+' || k === '−' || k === '×' || k === '÷') pressOp(k);
                  else pressDigit(Number(k));
                }}
                accessibilityLabel={k === 'done' ? 'Save transaction' : `Key ${k}`}>
                <Text
                  style={[
                    styles.keyText,
                    '÷×−+⌫'.includes(k) && { color: colors.indigo2 },
                    k === 'done' && { color: '#fff', fontSize: 15, fontWeight: '700' },
                  ]}>
                  {k}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.5)', alignItems: 'center' },
  sheet: {
    flex: 1,
    width: '100%',
    maxWidth: 430,
    backgroundColor: colors.bg2,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
  top: {
    backgroundColor: colors.card2,
    paddingTop: 14,
    paddingBottom: 24,
    paddingHorizontal: 18,
    borderBottomLeftRadius: 22,
    borderBottomRightRadius: 22,
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    left: 16,
    top: 14,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  amount: { color: colors.text, fontSize: 34, fontWeight: '800', marginTop: 30, marginBottom: 16 },
  typeToggle: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  rows: { paddingHorizontal: 16, flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowIcon: { width: 26, textAlign: 'center', color: colors.faint, fontSize: 16 },
  rowK: { fontSize: 12, color: colors.faint },
  rowV: { fontSize: 15, color: colors.text },
  payeeInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 0 },
  chev: { color: colors.faint, fontSize: 16 },
  dateStep: { color: colors.indigo2, fontSize: 20, paddingHorizontal: 8 },
  keypad: {
    backgroundColor: colors.bg,
    padding: 10,
    paddingBottom: 26,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  errorStrip: {
    color: colors.redFg,
    backgroundColor: colors.redPillBg,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  key: {
    width: '23%',
    flexGrow: 1,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  keyOp: { backgroundColor: 'transparent' },
  keyDone: { backgroundColor: colors.indigo },
  keyText: { color: colors.text, fontSize: 21, fontWeight: '600' },
});
