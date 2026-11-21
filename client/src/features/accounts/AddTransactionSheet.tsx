/**
 * Add-transaction sheet — calculator-style entry (mock `.txn-sheet`):
 * amount keypad (with ÷ × − ＋), Spending/Income toggle, payee, category,
 * account, date. Saving persists through `budgetApi.addTransaction`, which
 * also applies the account balance delta (new entries start uncleared).
 * Header clears the status bar; drag the header down to dismiss.
 */

import { Animated, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Transaction } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';
import { Keypad } from './addTransaction/Keypad';
import { SheetFields } from './addTransaction/SheetFields';
import { SheetPicker } from './addTransaction/SheetPicker';
import { styles } from './addTransaction/styles';
import { useAddTransaction } from './addTransaction/useAddTransaction';
import { useSheetDrag } from './addTransaction/useSheetDrag';

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
  const { formatMoney } = useMoneyFormat();
  const sheet = useAddTransaction({ onClose, editTxn, prefillCategoryId });
  const { close, isIncome, settled, toggleKind, picker, saveError, pressKey, save } = sheet;

  // iPhone: the Modal renders edge-to-edge, so the header must clear the
  // status bar and the keypad the home indicator.
  const insets = useSafeAreaInsets();
  const { dragY, panHandlers } = useSheetDrag(visible, close);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.sheet, { transform: [{ translateY: dragY }] }]}>
          <View style={[styles.top, { paddingTop: 14 + insets.top }]} {...panHandlers}>
            <Pressable style={[styles.closeBtn, { top: 14 + insets.top }]} onPress={close} accessibilityLabel={tCommon('close')}>
              <Text style={{ color: colors.text, fontSize: 15 }}>✕</Text>
            </Pressable>
            <Text style={styles.amount}>
              {isIncome ? '' : '−'}
              {formatMoney(settled)}
            </Text>
            <Pressable
              style={styles.typeToggle}
              onPress={toggleKind}
              accessibilityLabel={t('sheet.toggleKind')}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>
                {isIncome ? t('sheet.income') : t('sheet.spending')}
              </Text>
            </Pressable>
          </View>

          {/* One scroll view for both modes, so toggling a picker keeps the instance. */}
          <ScrollView style={styles.rows} keyboardShouldPersistTaps={picker === 'none' ? undefined : 'handled'}>
            {picker === 'none' ? <SheetFields sheet={sheet} /> : <SheetPicker sheet={sheet} />}
          </ScrollView>

          {saveError ? (
            <Text style={styles.errorStrip} accessibilityRole="alert">
              {saveError}
            </Text>
          ) : null}

          <Keypad bottomInset={insets.bottom} onKey={pressKey} onDone={() => void save()} />
        </Animated.View>
      </View>
    </Modal>
  );
}
