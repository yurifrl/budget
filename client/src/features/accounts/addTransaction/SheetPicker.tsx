import { Pressable, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { colors } from '@/ui/theme';
import { t } from './i18n';
import { styles } from './styles';
import type { AddTransaction } from './useAddTransaction';

/** The open picker (inside the sheet's scroll view): Back, a search box (payee / category), and the choices with a create row. */
export function SheetPicker({ sheet }: { sheet: AddTransaction }) {
  const {
    picker,
    closePicker,
    search,
    setSearch,
    query,
    payee,
    canCreatePayee,
    filteredPayees,
    pickPayee,
    categoryId,
    canCreateCategory,
    filteredCategories,
    createCategory,
    pickCategory,
    labelOf,
    account,
    accountChoices,
    pickAccount,
  } = sheet;
  return (
    <>
      <Pressable style={styles.row} onPress={closePicker}>
        <Text style={styles.rowIcon}>‹</Text>
        <Text style={styles.rowV}>{tCommon('back')}</Text>
      </Pressable>
      {picker !== 'account' ? (
        <View style={styles.row}>
          <Text style={styles.rowIcon}>⌕</Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={picker === 'payee' ? t('picker.payeeSearch') : t('picker.categorySearch')}
            placeholderTextColor={colors.muted}
            autoFocus
            style={styles.payeeInput}
            accessibilityLabel={picker === 'payee' ? t('picker.payeeSearch') : t('picker.categorySearchLabel')}
          />
        </View>
      ) : null}
      {picker === 'payee' ? (
        <>
          {canCreatePayee ? (
            <Pressable style={styles.row} onPress={() => pickPayee(query)}>
              <Text style={[styles.rowIcon, { color: colors.indigo2 }]}>＋</Text>
              <Text style={[styles.rowV, { color: colors.indigo2 }]}>
                {t('picker.createPayee', { query })}
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
                {t('picker.createCategory', { query })}
              </Text>
            </Pressable>
          ) : null}
          {filteredCategories.map((c) => (
            <Pressable
              key={c.id}
              style={styles.row}
              onPress={() => pickCategory(c.id)}>
              <Text style={styles.rowV}>{labelOf(c)}</Text>
              {categoryId === c.id ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
            </Pressable>
          ))}
        </>
      ) : null}
      {picker === 'account'
        ? accountChoices.map((a) => (
            <Pressable
              key={a.id}
              style={styles.row}
              onPress={() => pickAccount(a.id)}>
              <Text style={styles.rowV}>{a.name}</Text>
              {account?.id === a.id ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
            </Pressable>
          ))
        : null}
    </>
  );
}
